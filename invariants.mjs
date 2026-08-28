// invariants.mjs — THE IMMUNE SYSTEM. Contradictions between what the code CLAIMS and what the
// chain SAYS, checked every tick, repaired where a repair is safe, escalated where it is not.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS, and why health.mjs was never going to catch it.
//
// health.mjs asks "IS IT MOVING?" — idle slots, nothing earned in N hours, a stale prospector. That
// is a liveness question, and both of the failures found on 2026-08-12 were perfectly alive:
//
//   * escapeCycle returned step:"done" every 2 minutes for hours while the Base Safe held 57x the
//     agent's own reserve target, unconverted. Nothing was idle. Nothing errored. It was WORKING,
//     on the wrong belief.
//   * sweepCycle retried a CCTP mint for TWELVE DAYS against "Nonce already used" — a message a
//     third-party relayer had already delivered for free. `pending: 1` looks exactly like patience.
//
// Through both, health.mjs reported: "CYCLING — Nothing is stuck. Slots were spent on earning."
// It was not wrong about liveness. It was answering a different question.
//
// The question that catches these is not "is it moving?" but:
//
//     >>> DOES WHAT THE CODE CLAIMS MATCH WHAT THE CHAIN SAYS? <<<
//
// Every check below is a CONTRADICTION between two sources that must agree. A contradiction cannot
// be argued with, cannot be waited out, and does not depend on a threshold anybody guessed. And per
// DOCTRINE §5 — give the tireless exhaustive work to CODE, leave the model the breadth — none of
// this needs a model. Contradiction detection is arithmetic.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT A REPAIR IS ALLOWED TO BE. This is the safety boundary and it is deliberately narrow.
//
// A repair may ONLY rewrite the agent's own KV bookkeeping — retire a wedged queue entry, clear a
// stale reservation flag, drop a poisoned cooldown. That is where every stall so far actually lived:
// STATE that stopped matching reality.
//
// A repair may NEVER: send a transaction, spend a relay slot, move value, change a threshold, or
// edit code. Those are Anthony's gated actions (global rules §4) and an autonomous agent must not
// reach them by calling the reach a "fix". An invariant that needs one of those is ESCALATED, never
// self-served.
//
// So the honest claim for this file is NOT "it repairs bugs". It is:
//   * state wedges  -> repaired automatically, in one tick
//   * code bugs     -> made LOUD and ATTRIBUTABLE in one tick instead of twelve days
// The second is most of the value. Nobody was ever going to read a healthy-looking log.
import { ethers } from 'ethers';
import { CHAINS, HARVEST_CFG, ESCAPE, USDC_BY_CHAIN, HOME_CHAIN, wethBalance, nativeUsd, funnelShouldArm, escapeConvertFloorUsd } from './harvest.mjs';
import { SWEEP_RAIL } from './sweep.mjs';
import { mutateKV } from './kv.mjs';

export const INVARIANT_CFG = {
  // A violation that survives this many consecutive ticks is no longer a blip. At one tick per
  // 2 minutes, 15 ticks is 30 minutes of the same contradiction holding.
  escalateAfterTicks: 15,
  // OLD wei floor (~$0.0038). Kept so the CONTROL can re-implement the 2026-08-27 false positive.
  // The live check uses funnelShouldArm — the same $0.002 / $0.02 floors escapeCycle uses.
  funnelIdleFloorWei: 2000000000000n,
  // USDC residue on a tributary that should have been burned with the last sweep.
  tributaryResidueUnits: 2000n,                 // 0.002 USDC
  // How long holdings may rise with spendable flat before the funnel is not reaching the scoreboard.
  conversionStaleHours: 30,                     // > the measured ~24h relay refill cycle, with margin
  // Published vs live spendable. Origin was 104× ($0.227 vs $0.002). A mill of ETH-price drift
  // between two reads is not that bug. One cent matches the comment that shipped with the check.
  spendableSlackUsd: 0.01,
};

const b = (x) => (typeof x === 'bigint' ? x : BigInt(x || 0));

/** True when a census row CLAIMS $0 for a chain that holds wei and has no price.
 *  usdContribution null is unread — not a $0 claim. The 2026-08-28 live hit fired because
 *  readWorld initialised usdContribution to 0, so a failed Base Blockscout price read looked
 *  exactly like "priced at nothing". */
export function chainsPricedAtZero(perChain) {
  const bad = [];
  for (const [name, r] of Object.entries(perChain || {})) {
    const held = b(r.wrapped) + b(r.native);
    if (held > 0n && r.priceKnown === false && r.usdContribution === 0) {
      bad.push({ chain: name, wei: held.toString() });
    }
  }
  return bad;
}

/** Same contradiction, against what `/` actually served. A null usd field is unmeasured. */
export function publishedChainsPricedAtZero(rows) {
  const bad = [];
  for (const r of rows || []) {
    const wei = [r.eoa_wei, r.safe_wei, r.eoa_native_wei, r.safe_native_wei]
      .reduce((n, x) => n + b(x || 0), 0n);
    if (wei <= 0n) continue;
    if (r.price_known !== false) continue;
    const usdFields = [r.eoa_usd, r.safe_usd, r.eoa_native_usd, r.usdc_usd];
    if (usdFields.some(v => v === null || v === undefined)) continue;
    if (usdFields.every(v => v === 0)) bad.push({ chain: r.chain, wei: wei.toString() });
  }
  return bad;
}
/** True when published spendable is materially above native ETH at the Base EOA. */
export function spendableOverstated(claimed, actualUsd, slackUsd = INVARIANT_CFG.spendableSlackUsd) {
  if (typeof claimed !== 'number' || actualUsd == null || !Number.isFinite(actualUsd)) return false;
  return claimed > actualUsd + slackUsd;
}

// ── THE CHECKS ───────────────────────────────────────────────────────────────────────────────────
// Each one names the bug it descends from, so nobody has to rediscover why it is here.
// `check` returns null when satisfied, or { detail, evidence, repairable } when contradicted.
const INVARIANTS = [
  {
    id: 'funnel-idle-while-safe-loaded',
    asks: 'The Base Safe holds convertible value AND the funnel is not armed to convert it.',
    origin: 'escapeCycle returned step:"done" for hours holding $0.1244 — 57x its own reserve target.',
    async check(ctx) {
      const safeWeth = ctx.chain.baseSafeWrapped;
      const usdc = ctx.chain.baseSafeUsdc;
      if (safeWeth === null) return null;                       // unreadable is a different invariant
      const price = ctx.chain.basePrice;
      const eoaWei = ctx.chain.baseEoaNative;
      const eoaUsd = (price != null && eoaWei != null)
        ? Number(ethers.formatEther(eoaWei)) * price
        : (ctx.escape?.reserve?.eoa_native_eth_usd ?? null);
      const safeUsd = (price != null)
        ? Number(ethers.formatEther(safeWeth)) * price
        : (ctx.escape?.reserve?.safe_weth_usd ?? null);
      const hasWork = funnelShouldArm({
        safeWethUsd: safeUsd,
        usdcUnits: usdc,
        eoaNativeUsd: eoaUsd,
        safeWethWei: safeWeth,
        priceKnown: price != null || ctx.escape?.reserve?.safe_weth_usd != null,
      });
      if (!hasWork) return null;
      const step = ctx.escape?.step;
      // 'funnel' (armed, possibly waiting for a slot) is the correct state. Anything else while
      // there is work is the contradiction. 'accumulate' is correct WHEN hasWork is false —
      // that case already returned above. Firing on accumulate below the $0.02 floor was the
      // 2026-08-27 false positive (Safe ~$0.014, EOA reserve already healthy).
      if (step === 'funnel') return null;
      if (!step) return null;                                   // no reading this tick, not a claim
      return {
        detail: `Funnel reports "${step}" while the Base Safe holds ${safeWeth} wei wrapped native and ${usdc} USDC units.`,
        evidence: {
          escape_step: step,
          safe_wrapped_wei: safeWeth.toString(),
          safe_usdc_units: usdc.toString(),
          safe_weth_usd: safeUsd,
          floor_usd: escapeConvertFloorUsd(eoaUsd),
        },
        repairable: false,   // this is a CODE belief, not a state wedge — a repair would paper over it
      };
    },
  },
  {
    id: 'cctp-message-already-delivered',
    asks: 'A pending CCTP transfer has in fact already been minted on Base.',
    origin: 'sweepCycle retried "Nonce already used" for 12 days; the message was delivered free by a third-party relayer on 2026-07-31.',
    async check(ctx) {
      const pending = ctx.sweep?.pending || [];
      if (!pending.length) return null;
      const p = pending[0];
      if (!p?.tx || !p.chain) return null;
      const src = SWEEP_RAIL.sources[p.chain];
      if (!src) return null;
      // Ask Circle for the attested message, then ask BASE whether that nonce is already spent.
      // Two independent sources; the chain is the one that decides.
      let used = null, nonce = null;
      try {
        const r = await fetch(`${SWEEP_RAIL.iris}/${src.domain}?transactionHash=${p.tx}`, { headers: { 'User-Agent': 'zero-agent/0.4' } });
        const j = r.ok ? await r.json() : null;
        const m = j?.messages?.find(x => x.message);
        if (!m) return null;
        // CCTP v2 nonce is bytes 12..44 of the message body.
        nonce = '0x' + m.message.replace(/^0x/, '').slice(24, 88);
        const data = new ethers.Interface(['function usedNonces(bytes32) view returns (uint256)'])
          .encodeFunctionData('usedNonces', [nonce]);
        const ret = await ctx.rpc('base', 'eth_call', [{ to: SWEEP_RAIL.messageTransmitter, data }, 'latest']);
        used = BigInt(ret) > 0n;
      } catch { return null; }                                  // a failed read is not a violation
      if (!used) return null;
      return {
        detail: `Sweep is holding a pending entry for ${p.chain} whose CCTP nonce is ALREADY SPENT on Base — the USDC arrived. It is blocking every future burn.`,
        evidence: { chain: p.chain, burn_tx: p.tx, nonce, usedNonces: '1', pending_since: p.at },
        repairable: true,
      };
    },
    async repair(ctx) {
      const st = ctx.sweep;
      const p = st.pending.shift();
      st.done = [{ ...p, minted: true, delivered_by: 'third party; detected by invariant, not by our own relay', at: new Date().toISOString() }, ...(st.done || [])].slice(0, 20);
      await mutateKV(ctx.env, 'sweep:state', () => st, { fallback: { pending: [], done: [] } });
      return { action: 'retired the delivered CCTP entry from the pending queue', note: 'No slot spent. The burn leg is unblocked from the next tick.' };
    },
  },
  {
    id: 'sweep-queue-wedged',
    asks: 'A pending sweep entry is older than any honest attestation delay.',
    origin: 'The same 12-day jam: nothing in the queue had a timeout, so a stuck entry was indistinguishable from a waiting one — forever.',
    async check(ctx) {
      const p = (ctx.sweep?.pending || [])[0];
      if (!p?.at) return null;
      const ageH = (Date.now() - Date.parse(p.at)) / 3600000;
      if (!Number.isFinite(ageH) || ageH <= SWEEP_RAIL.pendingGiveUpHours) return null;
      return {
        detail: `Sweep pending entry for ${p.chain} is ${ageH.toFixed(1)}h old (limit ${SWEEP_RAIL.pendingGiveUpHours}h). While it sits there, LEG A cannot burn on any chain.`,
        evidence: { chain: p.chain, age_hours: +ageH.toFixed(1), burn_tx: p.tx, pending_since: p.at },
        repairable: true,
      };
    },
    async repair(ctx) {
      const st = ctx.sweep;
      const p = st.pending.shift();
      st.done = [{ ...p, abandoned: true, reason: 'exceeded pendingGiveUpHours; retired by invariant so the rail can move', at: new Date().toISOString() }, ...(st.done || [])].slice(0, 20);
      await mutateKV(ctx.env, 'sweep:state', () => st, { fallback: { pending: [], done: [] } });
      return { action: 'retired a wedged sweep entry', note: 'Rail unblocked. The burn will be re-attempted from current balances; nothing is lost because the funds never left the source Safe unless the burn landed.' };
    },
  },
  {
    id: 'spendable-overstated',
    asks: 'The published "spendable" figure exceeds the native ETH actually at the EOA on Base.',
    origin: 'The published number said $0.2272606 while the EOA held $0.002176 — overstated 104x, which is exactly what made the funnel look unnecessary.',
    async check(ctx) {
      const claimed = ctx.reported?.spendable_usd;
      if (typeof claimed !== 'number') return null;
      const actualWei = ctx.chain.baseEoaNative;
      const price = ctx.chain.basePrice;
      if (actualWei === null || price === null) return null;
      const actual = Number(ethers.formatEther(actualWei)) * price;
      // A cent of tolerance covers price drift between the two reads. $0.00001 was a mill, not a
      // cent — live 2026-08-27 23:10Z fired on $0.61478 vs $0.61473 (overstated_x: 1).
      if (!spendableOverstated(claimed, actual)) return null;
      return {
        detail: `Reported spendable $${claimed} exceeds native ETH at the Base EOA ($${actual.toFixed(8)}). "Spendable" must mean capability and nothing else (DOCTRINE §11b).`,
        evidence: { claimed_usd: claimed, actual_native_usd: +actual.toFixed(8), eoa_native_wei: actualWei.toString(), overstated_x: +(claimed / Math.max(actual, 1e-12)).toFixed(1) },
        repairable: false,
      };
    },
  },
  {
    id: 'value-priced-at-zero',
    asks: 'A chain holds a nonzero balance but contributes $0 to the totals.',
    origin: '`price ? amount * price : 0` turned Polygon\'s intermittent price feed into $0, deleting the whole pile from every total ever printed.',
    async check(ctx) {
      const bad = [
        ...chainsPricedAtZero(ctx.chain.perChain),
        ...publishedChainsPricedAtZero(ctx.reported?.all_chains_priced),
      ];
      const seen = new Set();
      const uniq = bad.filter(x => seen.has(x.chain) ? false : seen.add(x.chain));
      if (!uniq.length) return null;
      return {
        detail: `${uniq.map(x => x.chain).join(', ')} hold real balances that are priced at nothing. Unpriced is NOT zero — a chain missing from a total must be labelled unmeasured, never silently dropped.`,
        evidence: { chains: uniq },
        repairable: false,   // it is a reporting truth, surfaced deliberately; nothing to rewrite
        severity: 'notice',
      };
    },
  },
  {
    id: 'value-stranded-as-wrapped-at-eoa',
    asks: 'The EOA holds wrapped native but no gas to unwrap it — the unrecoverable state.',
    origin: 'DOCTRINE §10: WETH at the EOA is worth NOTHING until the EOA is seeded. Never accept payment into that state.',
    async check(ctx) {
      const w = ctx.chain.baseEoaWrapped, e = ctx.chain.baseEoaNative;
      if (w === null || e === null || w === 0n) return null;
      if (e > 0n) return null;                                   // it can unwrap itself; escapeCycle step 3 handles it
      return {
        detail: `EOA holds ${w} wei of wrapped native and ZERO gas. It cannot move it, and a Safe cannot unwrap on its behalf. Fees must land in the Safe, never here.`,
        evidence: { eoa_wrapped_wei: w.toString(), eoa_native_wei: '0' },
        repairable: false,
      };
    },
  },
  {
    id: 'earning-but-not-converting',
    asks: 'Total holdings keep rising while spendable stays flat — the funnel is not reaching the scoreboard.',
    origin: 'The whole point of DOCTRINE §11b: harvesting more WETH into a pile that cannot act scores as ZERO. This is the metric that says the funnel has silently stopped mattering.',
    async check(ctx) {
      const hist = ctx.history || [];
      if (hist.length < 2) return null;
      const oldest = hist[hist.length - 1], newest = hist[0];
      const hours = (newest.t - oldest.t) / 3600000;
      if (hours < INVARIANT_CFG.conversionStaleHours) return null;
      const holdingsUp = (newest.holdings ?? 0) - (oldest.holdings ?? 0);
      const spendableUp = (newest.spendable ?? 0) - (oldest.spendable ?? 0);
      if (holdingsUp <= 0.0005 || spendableUp > 0.0001) return null;
      return {
        detail: `Over ${hours.toFixed(1)}h holdings rose $${holdingsUp.toFixed(6)} but spendable moved $${spendableUp.toFixed(8)}. Value is arriving and never becoming capability.`,
        evidence: { hours: +hours.toFixed(1), holdings_delta_usd: +holdingsUp.toFixed(6), spendable_delta_usd: +spendableUp.toFixed(8) },
        repairable: false,
      };
    },
  },
  {
    id: 'tributary-usdc-residue',
    asks: 'A tributary Safe is sitting on USDC that a sweep should already have burned.',
    origin: 'The burn amount was outMin — the slippage FLOOR — so every sweep left its change behind. 299 units are on the optimism Safe from exactly this.',
    async check(ctx) {
      const bad = [];
      for (const [name] of Object.entries(SWEEP_RAIL.sources)) {
        const u = ctx.chain.perChain[name]?.usdc;
        if (u !== null && u !== undefined && b(u) >= INVARIANT_CFG.tributaryResidueUnits) bad.push({ chain: name, units: b(u).toString() });
      }
      if (!bad.length) return null;
      return {
        detail: `USDC left behind on ${bad.map(x => x.chain).join(', ')}. The next sweep should absorb it (burn = prior balance + outMin); if it persists across sweeps, the residue fix regressed.`,
        evidence: { residue: bad },
        repairable: false,
        severity: 'notice',
      };
    },
  },
  {
    id: 'phantom-relay-capacity',
    asks: 'The relay reports free capacity on a chain where the Safe has no code.',
    origin: 'MEASURED 2026-08-12: unichain reports 5/5 forever, but eth_getCode at the Safe is 0x there — the account was never deployed. The relay gateway does not check; it answers 5/5 for ANY address, including 0x…0001. Health counted those 5 slots as free capacity, the dashboard showed them, and a strategy note built on "10 wasted slots/day" was wrong by half.',
    async check(ctx) {
      // ⚠️ AN INVARIANT THAT CANNOT FIRE IS WORSE THAN NO INVARIANT: it reports "all hold" and buys
      // false confidence. This check needs the relay table, and a caller once omitted it — leaving
      // the check silently inert while unichain was advertising 5 slots against a Safe with no code.
      // If the input is missing, SAY SO. Never return null (which reads as "satisfied").
      if (!ctx.relay || !Object.keys(ctx.relay).length) {
        return {
          detail: 'NOT ASSESSED — no relay table was supplied to checkInvariants, so this check could not run. That is not the same as passing.',
          evidence: { missing_input: 'relay' },
          repairable: false,
          severity: 'notice',
        };
      }
      const bad = [];
      for (const [name, r] of Object.entries(ctx.chain.perChain)) {
        if (r.error) continue;
        const rem = ctx.relay?.[name]?.remaining;
        if (r.safeDeployed === false && typeof rem === 'number' && rem > 0) {
          bad.push({ chain: name, remaining: rem });
        }
      }
      if (!bad.length) return null;
      return {
        detail: `${bad.map(x => `${x.chain} advertises ${x.remaining} free relay slots but the Safe HAS NO CODE there` ).join('; ')}. That capacity cannot be spent — do not count it, do not plan around it.`,
        evidence: { phantom: bad },
        repairable: false,
        severity: 'notice',
      };
    },
  },
  {
    id: 'escape-reservation-stale',
    asks: 'Base is reserved for the funnel by a flag the cron has not refreshed.',
    origin: 'escape:needsBase gates the manual harvest path. A stale true would quietly starve Base harvests with nobody spending the slot either.',
    async check(ctx) {
      const flag = ctx.needsBase;
      if (!flag?.v) return null;
      const ageMin = (Date.now() - (flag.at || 0)) / 60000;
      if (ageMin < 12) return null;                              // ~6 ticks
      return {
        detail: `escape:needsBase has been true for ${ageMin.toFixed(0)} minutes without a refresh. Base harvests are being held for a funnel that is not running.`,
        evidence: { age_minutes: +ageMin.toFixed(0), flag },
        repairable: true,
      };
    },
    async repair(ctx) {
      await ctx.env.KV.put('escape:needsBase', JSON.stringify({ v: false, at: Date.now() }), { expirationTtl: 3600 });
      return { action: 'cleared the stale Base reservation', note: 'Base harvests can proceed; the funnel re-arms itself next tick if it really has work.' };
    },
  },
];

// ── THE RUNNER ───────────────────────────────────────────────────────────────────────────────────
// Reads the world ONCE, sequentially, then evaluates every invariant against that snapshot so two
// checks can never disagree about the same number.
export async function readWorld(rpc, env, eoa, safe) {
  const perChain = {};
  let baseSafeWrapped = null, baseEoaWrapped = null, baseEoaNative = null, baseSafeUsdc = 0n, basePrice = null;
  for (const [name, c] of Object.entries(CHAINS)) {
    const row = { wrapped: null, native: null, usdc: null, priceKnown: null, usdContribution: null };
    try {
      row.wrapped = (await wethBalance(rpc, safe, name, c.weth)).toString();
      row.native = (await rpc(name, 'eth_getBalance', [safe, 'latest'])).toString();
      if (USDC_BY_CHAIN[name]) row.usdc = (await wethBalance(rpc, safe, name, USDC_BY_CHAIN[name])).toString();
      // Does the Safe actually EXIST here? The relay will happily advertise a quota for an address
      // that has never been deployed, so quota alone is not capability.
      row.safeDeployed = (await rpc(name, 'eth_getCode', [safe, 'latest'])) !== '0x';
      const p = await nativeUsd(name);
      row.priceKnown = p !== null;
      if (p !== null) row.usdContribution = Number(ethers.formatEther(b(row.wrapped))) * p;
      if (name === HOME_CHAIN) {
        baseSafeWrapped = b(row.wrapped);
        baseSafeUsdc = b(row.usdc);
        basePrice = p;
        baseEoaWrapped = await wethBalance(rpc, eoa, name, c.weth);
        baseEoaNative = BigInt(await rpc(name, 'eth_getBalance', [eoa, 'latest']));
      }
    } catch (e) { row.error = String(e.message).slice(0, 80); }
    perChain[name] = row;
  }
  return { perChain, baseSafeWrapped, baseSafeUsdc, baseEoaWrapped, baseEoaNative, basePrice };
}

export async function checkInvariants(env, rpc, { eoa, safe, escape, reported, relay } = {}) {
  const ctx = {
    env, rpc,
    escape: escape || (await env.KV.get('escape:last', 'json')) || null,
    reported, relay: relay || {},
    chain: await readWorld(rpc, env, eoa, safe),
    sweep: (await env.KV.get('sweep:state', 'json')) || { pending: [], done: [] },
    needsBase: (await env.KV.get('escape:needsBase', 'json')) || null,
    history: (await env.KV.get('invariants:history', 'json')) || [],
  };

  const prior = (await env.KV.get('invariants:streaks', 'json')) || {};
  const violations = [], repaired = [], errors = [];

  for (const inv of INVARIANTS) {
    let hit = null;
    try { hit = await inv.check(ctx); }
    catch (e) { errors.push({ id: inv.id, error: String(e.message).slice(0, 120) }); continue; }

    if (!hit) { delete prior[inv.id]; continue; }

    const ticks = (prior[inv.id]?.ticks || 0) + 1;
    prior[inv.id] = { ticks, since: prior[inv.id]?.since || new Date().toISOString() };

    const record = {
      id: inv.id, asks: inv.asks, origin: inv.origin,
      severity: hit.severity || 'violation',
      detail: hit.detail, evidence: hit.evidence,
      ticks, since: prior[inv.id].since,
      escalate: ticks >= INVARIANT_CFG.escalateAfterTicks && (hit.severity || 'violation') === 'violation',
    };

    if (hit.repairable && typeof inv.repair === 'function') {
      try {
        const r = await inv.repair(ctx);
        record.repaired = true; record.repair = r;
        delete prior[inv.id];
        repaired.push(record);
        continue;
      } catch (e) { record.repair_failed = String(e.message).slice(0, 120); }
    }
    violations.push(record);
  }

  // A rolling record of the two numbers that matter, so 'earning-but-not-converting' has something
  // to compare against. Kept small and time-stamped; 48 entries at one per tick is ~1.6h, so the
  // window is widened by only storing an entry when the hour changes.
  const hist = ctx.history.slice();
  const nowH = Math.floor(Date.now() / 3600000);
  if (!hist.length || Math.floor(hist[0].t / 3600000) !== nowH) {
    hist.unshift({ t: Date.now(), spendable: reported?.spendable_usd ?? null, holdings: reported?.total_holdings_usd ?? null });
  }
  await env.KV.put('invariants:history', JSON.stringify(hist.slice(0, 48)));
  await env.KV.put('invariants:streaks', JSON.stringify(prior));

  const out = {
    checked_at: new Date().toISOString(),
    invariants_checked: INVARIANTS.length,
    clean: violations.length === 0 && repaired.length === 0,
    violations, repaired, read_errors: errors,
    headline: violations.length
      ? `${violations.length} contradiction${violations.length === 1 ? '' : 's'} between what the code claims and what the chain says${repaired.length ? `, ${repaired.length} repaired automatically` : ''}.`
      : repaired.length
        ? `${repaired.length} state wedge${repaired.length === 1 ? '' : 's'} repaired automatically. No open contradictions.`
        : `All ${INVARIANTS.length} invariants hold. Claims match the chain.`,
    what_this_is: 'Contradiction checks, not liveness checks. health.mjs asks "is it moving?" — this asks "does what the code claims match what the chain says?" Both 2026-08-12 stalls were fully alive and reported healthy.',
  };
  await env.KV.put('invariants:last', JSON.stringify(out));
  return out;
}

// Anything a human or an escalated agent needs to act, in one line each.
export function invariantBrief(res) {
  if (!res || res.clean) return null;
  const L = [];
  for (const v of res.violations) {
    L.push(`  ⚠ [${v.id}] ${v.detail} (holding ${v.ticks} tick${v.ticks === 1 ? '' : 's'}${v.escalate ? ', ESCALATED' : ''})`);
  }
  for (const r of res.repaired) L.push(`  ✓ [${r.id}] REPAIRED: ${r.repair?.action}. ${r.repair?.note || ''}`);
  return L.length ? `INVARIANTS — ${res.headline}\n${L.join('\n')}` : null;
}
