// kv.mjs — safe mutation of shared Worker KV state.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE RACE THIS EXISTS TO CLOSE (found 2026-08-12).
//
// `scheduled()` used to fire FIVE concurrent `c.waitUntil()` blocks. That died `exceededMemory`.
// It now runs ONE sequential waitUntil, but the cron is still `*/2 * * * *`, so a tick that takes
// longer than two minutes would start a SECOND isolate-sharing invocation on top of the first —
// the same peak-RAM death, just delayed. `cronLeaseHeld` is the skip gate for that overlap.
// The session's tools still call `harvest_run` and `route_log`, which read-modify-write
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
export const CRON_LEASE_KEY = 'cron:lease';
export const CRON_LEASE_HOLD_MS = 12 * 60 * 1000;
export const CRON_SESSION_MISS_KEY = 'cron:sessionMissed';
// Sparse GLM is ~20 min, and a discovery skip stretches that to ~40 min; a live
// lease can delay one more slot. 45 min from startedAt abandoned every in-flight
// session (measured 2026-08-27, session 973). Age from the last slice, with margin.
export const SESSION_STALE_MS = 90 * 60 * 1000;

/** True when a previous scheduled tick is still in flight. KV is not a mutex; this only shrinks
    overlap. A missing/expired lease always means "run". */
export function cronLeaseHeld(lease, now = Date.now(), holdMs = CRON_LEASE_HOLD_MS) {
  if (!lease || !Number.isFinite(Number(lease.at))) return false;
  return (now - Number(lease.at)) < holdMs;
}

/** GLM slice on cron, but never on the same tick as janitor (%5) or discovery (%3).
 *  Measured 2026-08-27: stacking session + keeper traces + invariants OOMed the isolate. */
export function cronSessionDue(jtick) {
  const n = Number(jtick);
  if (!Number.isFinite(n)) return false;
  return n % 10 === 1 && n % 3 !== 0;
}

/** Janitor (%5) or discovery (%3) — GLM must not share these ticks. */
export function cronHygieneTick(jtick) {
  const n = Number(jtick);
  if (!Number.isFinite(n)) return false;
  return n % 5 === 0 || n % 3 === 0;
}

/** Run GLM on its sparse slot, or on the next non-hygiene tick if a lease ate that slot.
 *  Measured 2026-08-27: 23:40Z janitor held the 12 min lease, 23:42Z session tick skipped,
 *  session 973 stuck at round 2 for 30+ min. */
export function cronSessionShouldRun(jtick, missed) {
  if (cronSessionDue(jtick)) return true;
  return Boolean(missed) && !cronHygieneTick(jtick);
}

/** True when an in-flight session has had no slice in staleMs. Age lastSliceAt,
 *  not startedAt — sparse GLM cannot finish 12 rounds inside a 45-minute start clock. */
export function sessionIsStale(state, now = Date.now(), staleMs = SESSION_STALE_MS) {
  if (!state) return false;
  const last = Number(state.lastSliceAt || state.startedAt);
  if (!Number.isFinite(last) || last <= 0) return false;
  return (now - last) > staleMs;
}

// ⚠️ CORRECTION, MEASURED 2026-08-13. The paragraph above claims "an accumulating mutation applied
// twice to fresh state is still correct". THAT IS FALSE, and it inflated our own success metrics.
//
// The retry re-runs `mutate` against re-read state. But our PUT may well have LANDED — the version
// check fails whenever ANOTHER writer bumps `_v` after us, not only when we lost. So attempt 2 reads
// state that ALREADY CONTAINS our `wins + 1`, and adds 1 again. Same for weiEarned.
// Independently measured against four block explorers: the chain shows 77 incoming token transfers
// to ZERO's addresses; this counter claimed 207. A batch of 6 harvests emits 6 transfers but only 1
// win, so on-chain transfers must EXCEED wins — finding them at a third of it proves over-counting,
// and it is also why measured_usd ($0.0744) sat above the chain floor ($0.0482).
//
// This is the failure mode we are least able to see: a scoreboard we wrote, grading us, with no
// outside reading. The fix is idempotency, not more retries — pass `opId` for any non-idempotent
// mutation (counters, accumulators) and the same logical event can never be applied twice.
export async function mutateKV(env, key, mutate, { retries = KV_MUTATE_RETRIES, fallback = {}, opId = null } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const fresh = (await env.KV.get(key, 'json')) || fallback;
    // Already applied this logical event? Then a previous attempt's write DID land. Re-running the
    // mutation now would double count, so treat it as success and leave state untouched.
    if (opId && Array.isArray(fresh._ops) && fresh._ops.includes(opId)) {
      return { ok: true, value: fresh, attempts: attempt + 1, deduped: true };
    }
    const beforeV = Number(fresh._v || 0);
    const next = (await mutate(fresh)) ?? fresh;
    next._v = beforeV + 1;
    if (opId) next._ops = [opId, ...(Array.isArray(fresh._ops) ? fresh._ops : [])].slice(0, 200);
    await env.KV.put(key, JSON.stringify(next));
    const check = await env.KV.get(key, 'json');
    if (Number(check?._v || 0) === next._v) return { ok: true, value: next, attempts: attempt + 1 };
    last = { theirs: Number(check?._v || 0), ours: next._v };
  }
  return { ok: false, contended: last, note: `lost the write race on ${key} after ${retries + 1} attempts` };
}

// Accumulating helpers. These are written so that applying them to FRESH state is always correct,
// which is what makes the retry above safe: re-running an add against re-read state cannot double
// count, because the addend comes from the caller and the base comes from KV.
export const addBig = (a, b) => (BigInt(a || 0) + BigInt(b || 0)).toString();
export const addNum = (a, b, dp = 8) => +(((Number(a) || 0) + (Number(b) || 0)).toFixed(dp));
