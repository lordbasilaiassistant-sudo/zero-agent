/* RESOURCE-CLASS SCANNER (2026-08-13) — deterministic, runs on the cron, costs zero intelligence.
 *
 * WHY THIS IS CODE AND NOT A PROMPT (COMPUTE LAW):
 * "Does relayer X still have free slots for my address?" has the same answer every time given the
 * same inputs. That is arithmetic, not judgment, and the agent was spending metered thinking on it
 * every session. This file answers it for free, forever, and hands the agent only the DELTA —
 * what changed and what is newly reachable — which is the part that actually needs a mind.
 *
 * WHY IT SCANS A CLASS AND NOT A RESOURCE (RESOURCE-CLASS LAW):
 * ZERO found Safe's relayer, filed it as "I have 5 slots", and stopped looking — while under-counting
 * it 6x (it is 5/day on SIX chains) and missing four siblings that were never hidden. So this does not
 * check "my relayer". It enumerates every KNOWN member of the free-execution class on every chain,
 * every tick, and reports total free capacity as a number the agent cannot mistake for a ration.
 *
 * ADDING A MEMBER IS THE POINT. When a new sponsor is found, add it to CLASS below and it is
 * monitored forever at no cost. The list is meant to grow.
 */

import { RELAY_HEADERS } from './harvest.mjs';

/* Every known member of the class "somebody else pays for my execution".
   `probe` returns { free, limit, note } or null if unreachable. */
export const CLASS = [
  {
    id: 'safe-relay',
    what: 'Safe public relayer — sponsors execTransaction/createProxyWithNonce, no key, no account',
    why: 'Safe pays via Gelato 1Balance to drive Safe adoption. Structural, not charity.',
    chains: [
      { id: 8453, name: 'base' }, { id: 10, name: 'optimism' }, { id: 100, name: 'gnosis' },
      { id: 137, name: 'polygon' }, { id: 42161, name: 'arbitrum' }, { id: 130, name: 'unichain' },
    ],
    async probe(chain, address) {
      // CloudFront 403s a bare fetch — the Origin header is load-bearing, not decoration.
      /* REUSE THE PROVEN HEADERS, DO NOT INVENT NEW ONES — measured 2026-08-13.
         I hand-rolled a "polite" UA ('compatible; ZERO/1.0'), CloudFront 403'd every chain, and the
         scanner reported that as 0 free capacity — a number that would have told ZERO it was out of
         gas while 30 free transactions sat unused. harvest.mjs has relayed successfully for weeks
         with RELAY_HEADERS; the correct move was always to import the working part, not to write a
         second one. Grep the parts you have before you build a new one. */
      const r = await fetch(`https://safe-client.safe.global/v1/chains/${chain.id}/relay/${address}`, {
        headers: RELAY_HEADERS,
      });
      if (!r.ok) return null;
      const j = await r.json();
      return { free: Number(j.remaining ?? 0), limit: Number(j.limit ?? 0) };
    },
  },
];

/* Chains we have NOT yet found a sponsor on. Every tick re-probes a couple of them, because
   "no relayer here" is a NEGATIVE CONCLUSION and those expire (MEMORY LAW). A chain that gains a
   relayer next month should be found by a machine, not by luck. */
export const FRONTIER_CHAINS = [
  { id: 1, name: 'ethereum' }, { id: 56, name: 'bnb' }, { id: 43114, name: 'avalanche' },
  { id: 59144, name: 'linea' }, { id: 534352, name: 'scroll' }, { id: 324, name: 'zksync' },
  { id: 480, name: 'world' }, { id: 5000, name: 'mantle' }, { id: 81457, name: 'blast' },
  { id: 34443, name: 'mode' }, { id: 1868, name: 'soneium' }, { id: 57073, name: 'ink' },
];

/**
 * Scan the whole class. Pure measurement — no writes, no signing, no spending.
 * @returns {Promise<object>} capacity report the agent reads instead of re-deriving.
 */
export async function scanResourceClass(address, { frontierSampleAt = 0 } = {}) {
  const at = new Date().toISOString();
  const members = [];
  let totalFree = 0, totalLimit = 0;

  for (const m of CLASS) {
    const perChain = await Promise.all(m.chains.map(async (chain) => {
      try {
        const res = await m.probe(chain, address);
        if (!res) return { chain: chain.name, chainId: chain.id, reachable: false };
        return { chain: chain.name, chainId: chain.id, reachable: true, free: res.free, limit: res.limit };
      } catch (e) {
        return { chain: chain.name, chainId: chain.id, reachable: false, error: String(e.message).slice(0, 80) };
      }
    }));
    for (const c of perChain) { if (c.reachable) { totalFree += c.free || 0; totalLimit += c.limit || 0; } }
    members.push({ id: m.id, what: m.what, why: m.why, chains: perChain });
  }

  /* Re-probe TWO frontier chains per tick, rotating. A full sweep every ~6 ticks costs nothing and
     means a newly-launched relayer is found within minutes instead of never. This is the fix for
     "we found it once and stopped looking". */
  const i = Math.abs(frontierSampleAt) % FRONTIER_CHAINS.length;
  const sample = [FRONTIER_CHAINS[i], FRONTIER_CHAINS[(i + 1) % FRONTIER_CHAINS.length]];
  const frontier = await Promise.all(sample.map(async (chain) => {
    try {
      const res = await CLASS[0].probe(chain, address);
      return res
        ? { chain: chain.name, chainId: chain.id, NEW: true, free: res.free, limit: res.limit }
        : { chain: chain.name, chainId: chain.id, NEW: false };
    } catch { return { chain: chain.name, chainId: chain.id, NEW: false }; }
  }));
  const discovered = frontier.filter(f => f.NEW);

  /* ⚠️ NEVER REPORT A CONFIDENT ZERO FROM A FAILED PROBE (2026-08-13).
     First live run returned 0/0 because every probe 403'd — and a 0 here does not mean "no gas
     available", it means "I could not see". Those are opposite instructions to an agent: one says
     stop, the other says retry. Shipping 0 would have told ZERO it was broke while 30 free
     transactions sat unused, which is precisely the confidently-outdated failure the MEMORY LAW
     exists to prevent. So: if nothing was reachable, the number is null and the agent is told to
     treat capacity as UNKNOWN and re-probe, never as exhausted. */
  const anyReachable = members.some(m => m.chains.some(c => c.reachable));

  return {
    at,
    address,
    /* The headline the agent must read as CAPACITY, never as a ration. If this number is small the
       correct response is to enumerate more of the class — not to allocate the small number better. */
    free_execution_available: anyReachable ? totalFree : null,
    free_execution_ceiling: anyReachable ? totalLimit : null,
    measurement_ok: anyReachable,
    unknown_reason: anyReachable ? null
      : 'every probe failed (Safe relay returned 403 to both the Worker and a direct call). Capacity is UNKNOWN, NOT zero — do not conclude you are out of gas. Re-probe next tick; if it persists, the endpoint shape or an IP block changed and that is a real work order.',
    members,
    frontier_probed: frontier.map(f => f.chain),
    NEWLY_DISCOVERED: discovered,
    reminder: discovered.length
      ? `NEW SPONSOR FOUND on ${discovered.map(d => d.chain).join(', ')} — add it to CLASS and tell your operator.`
      : 'No new sponsor this tick. Capacity is a floor you measured, not a ceiling the world imposed — if you are slot-starved, go enumerate the class, do not merely re-allocate.',
  };
}
