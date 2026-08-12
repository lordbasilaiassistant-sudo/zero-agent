// kv.mjs — safe mutation of shared Worker KV state.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE RACE THIS EXISTS TO CLOSE (found 2026-08-12).
//
// `scheduled()` fires FIVE concurrent `c.waitUntil()` blocks: the earner loop, the prospector,
// discovery, the experiment rotation, and — the dangerous one — `tick(env,'cron')`, the agent's own
// reasoning session. The session's tools call `harvest_run` and `route_log`, which read-modify-write
// `harvest:state` and `state:routes`. The earner loop writes the very same two keys.
//
// Cloudflare KV has NO transactions and NO compare-and-swap. So the classic pattern used everywhere
// in this repo —
//     const state = await env.KV.get(k, 'json');   // ...minutes of work...
//     await env.KV.put(k, JSON.stringify(state));
// — is a last-writer-wins clobber, and the window is not small. `batchHarvest` reads state at the
// top, then relays, then POLLS RELAY STATUS FOR UP TO ~60 SECONDS, and only then writes. Anything
// the agent session records during that minute is silently erased on the next line.
//
// What gets lost is not cosmetic: `state:routes` IS the earnings ledger. It is what the agent reads
// back in its own system prompt to decide which routes deserve a scarce relay slot, and it is the
// only durable record that a route ever paid.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS CAN AND CANNOT PROMISE — stated plainly, because overclaiming here would be its own bug.
// KV is eventually consistent and offers no atomic primitive, so NOTHING built on it can be a true
// mutex. What `mutateKV` does is:
//   1. RE-READ IMMEDIATELY BEFORE WRITING and apply the mutation to that fresh value, so the window
//      shrinks from "the whole operation" (a minute) to "one read plus one write" (milliseconds).
//   2. Force the caller to express the change as a FUNCTION OF CURRENT STATE rather than as a blob
//      captured minutes ago — which is the part that actually prevents lost updates, because an
//      accumulating mutation applied twice to fresh state is still correct, whereas a stale blob
//      overwrite never is.
//   3. Detect the collision it cannot prevent, via a monotonic `_v`, and retry the mutation.
// A residual window remains. It is orders of magnitude smaller, and the mutations are now written so
// that losing the race degrades to "applied late" instead of "silently discarded".
export const KV_MUTATE_RETRIES = 3;

export async function mutateKV(env, key, mutate, { retries = KV_MUTATE_RETRIES, fallback = {} } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const fresh = (await env.KV.get(key, 'json')) || fallback;
    const beforeV = Number(fresh._v || 0);
    const next = (await mutate(fresh)) ?? fresh;
    next._v = beforeV + 1;
    await env.KV.put(key, JSON.stringify(next));
    // Confirm nobody landed between our read and our write. This is detection, not prevention —
    // but a detected clobber that gets re-applied beats an undetected one that vanishes.
    const check = await env.KV.get(key, 'json');
    if (Number(check?._v || 0) === next._v) return { ok: true, value: next, attempts: attempt + 1 };
    last = { theirs: Number(check?._v || 0), ours: next._v };
  }
  return { ok: false, contended: last, note: `lost the write race on ${key} after ${retries + 1} attempts — the mutation was re-applied to fresh state each time, so no read was stale, but a concurrent writer kept winning` };
}

// Accumulating helpers. These are written so that applying them to FRESH state is always correct,
// which is what makes the retry above safe: re-running an add against re-read state cannot double
// count, because the addend comes from the caller and the base comes from KV.
export const addBig = (a, b) => (BigInt(a || 0) + BigInt(b || 0)).toString();
export const addNum = (a, b, dp = 8) => +(((Number(a) || 0) + (Number(b) || 0)).toFixed(dp));
