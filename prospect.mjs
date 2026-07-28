// prospect.mjs — the tireless part, with no model in the loop.
//
// THE ARGUMENT: process of elimination genuinely does map the whole ecosystem, but only if something
// actually grinds through it. Leaving that to the agent does not work — it gets 12 rounds every 25
// minutes, and it spends them re-checking its status and re-deriving yesterday's conclusion. Eleven
// sessions produced zero triaged candidates while 214 sat untouched.
//
// None of that work needs a language model. "Resolve the proxy, simulate the entry points, check
// whether it has ever paid a caller, write down the verdict" is pure deterministic procedure. So it
// runs here, on every cron tick, forever, independent of which model is driving. The agent then wakes
// up to an ALREADY-TRIAGED list and spends its scarce rounds on the part that genuinely needs
// judgement: what the eliminated set implies, and where to look next.
//
// It also does the thing that makes elimination compound instead of merely accumulate: it rolls
// verdicts up BY CONTRACT FAMILY. One StrategyMerkl paying tells you little; six of six paying tells
// you the shape pays, and that generalises to strategies never seen before. That is the pattern
// recognition — computed from evidence, not guessed by a flash model.
import { inspect, resolveImpl } from './discover.mjs';
import { payoutHistory } from './payouts.mjs';

// A family is the contract's implementation NAME with trailing specifics stripped — the shape, not the
// instance. StrategyPassiveManagerVelodromeV4 and ...VelodromeV3 are the same shape.
export function familyOf(name) {
  if (!name) return 'unknown';
  return String(name)
    .replace(/V\d+$/i, '')
    .replace(/(Strategy|Vault|Pool|Gauge)$/i, '$1')
    .slice(0, 48) || 'unknown';
}

const VERDICT = { PAYS: 'PAYS_CALLERS', ZERO: 'PAYS_ZERO', NONE: 'NO_EVIDENCE' };

// Pick the next candidate that will teach us the most per subrequest spent:
//   1. callable but never payout-checked  — one check away from being a usable stream
//   2. never scored for callability       — the raw backlog
// Within each, prefer contracts we have actually watched pay somebody.
function pickNext(candidates) {
  const pending = Object.values(candidates).filter(c => !c.retired);
  const needsPayout = pending.filter(c => c.callable_now?.length && !c.payout_verdict);
  if (needsPayout.length) return { c: needsPayout.sort((a, b) => (b.payouts_seen || 0) - (a.payouts_seen || 0))[0], why: 'callable, payout unproven' };
  const unscored = pending.filter(c => c.callable_now === undefined);
  if (unscored.length) return { c: unscored.sort((a, b) => (b.payouts_seen || 0) - (a.payouts_seen || 0))[0], why: 'never triaged' };
  return { c: null, why: 'backlog empty — every known candidate is triaged' };
}

export async function prospectTick(env, fetcher) {
  const state = (await env.KV.get('discover:state', 'json')) || { candidates: {} };
  const { c, why } = pickNext(state.candidates || {});
  if (!c) return { skipped: why, triaged: Object.keys(state.candidates || {}).length };

  const out = { contract: c.contract, chain: c.chain, reason: why };

  // Stage 1 — resolve + simulate. Free, and the only thing that cannot lie about callability.
  if (c.callable_now === undefined) {
    try {
      const ins = await inspect(c.chain, c.contract);
      c.verified = !!ins.verified;
      c.access_controlled = ins.access_controlled ?? null;
      c.pays_a_caller = ins.pays_a_caller ?? null;
      c.implementation = ins.implementation || null;
      c.callable_now = ins.callable_now || [];
      c.functions = ins.candidate_functions || [];
      c.name = ins.name || c.name || null;
      c.family = familyOf(c.name);
      out.stage = 'simulated';
      out.callable_now = c.callable_now;
      out.name = c.name;
    } catch (e) {
      c.callable_now = [];
      out.stage = 'simulate failed';
      out.error = String(e.message).slice(0, 120);
    }
  } else {
    // Stage 2 — it simulates callable, so the only question left is whether calling it PAYS.
    // A callable function that pays the caller nothing is worth exactly zero relay slots.
    try {
      const p = await payoutHistory(fetcher, { chain: c.chain, contract: c.contract, sample: 5 });
      c.payout_verdict = p.verdict;
      c.settled_examples = (p.settled_payouts || []).slice(0, 2);
      c.checked_at = new Date().toISOString();
      if (p.verdict === VERDICT.ZERO) c.retired = true; // eliminated: never spend a slot here
      out.stage = 'payout-checked';
      out.verdict = p.verdict;
      out.settled = c.settled_examples;
    } catch (e) {
      out.stage = 'payout check failed';
      out.error = String(e.message).slice(0, 120);
    }
  }

  // Roll the verdict into what we know about the SHAPE. This is the part that generalises.
  const fam = (state.families ||= {});
  const f = (fam[c.family || familyOf(c.name)] ||= { seen: 0, callable: 0, pays: 0, zero: 0 });
  f.seen = Object.values(state.candidates).filter(x => (x.family || familyOf(x.name)) === (c.family || familyOf(c.name))).length;
  f.callable = Object.values(state.candidates).filter(x => (x.family || familyOf(x.name)) === (c.family || familyOf(c.name)) && x.callable_now?.length).length;
  f.pays = Object.values(state.candidates).filter(x => (x.family || familyOf(x.name)) === (c.family || familyOf(c.name)) && x.payout_verdict === VERDICT.PAYS).length;
  f.zero = Object.values(state.candidates).filter(x => (x.family || familyOf(x.name)) === (c.family || familyOf(c.name)) && x.payout_verdict === VERDICT.ZERO).length;

  state.prospected = (state.prospected || 0) + 1;
  state.lastProspect = new Date().toISOString();
  await env.KV.put('discover:state', JSON.stringify(state));

  const all = Object.values(state.candidates);
  out.progress = {
    total: all.length,
    triaged: all.filter(x => x.callable_now !== undefined).length,
    callable: all.filter(x => x.callable_now?.length).length,
    proven_paying: all.filter(x => x.payout_verdict === VERDICT.PAYS).length,
    eliminated: all.filter(x => x.retired).length,
    remaining: all.filter(x => x.callable_now === undefined || (x.callable_now?.length && !x.payout_verdict)).length,
  };
  return out;
}

// What the grinding has LEARNED — the map, not the individual squares.
export async function prospectIntel(env) {
  const state = (await env.KV.get('discover:state', 'json')) || { candidates: {} };
  const all = Object.values(state.candidates || {});
  const fams = Object.entries(state.families || {})
    .map(([name, f]) => ({
      family: name, ...f,
      pay_rate: f.pays + f.zero > 0 ? +(f.pays / (f.pays + f.zero)).toFixed(2) : null,
    }))
    .sort((a, b) => (b.pays - a.pays) || (b.callable - a.callable));

  const paying = all.filter(x => x.payout_verdict === VERDICT.PAYS);
  return {
    grind: {
      total_candidates: all.length,
      triaged: all.filter(x => x.callable_now !== undefined).length,
      still_queued: all.filter(x => x.callable_now === undefined).length,
      callable_now: all.filter(x => x.callable_now?.length).length,
      PROVEN_PAYING: paying.length,
      eliminated_forever: all.filter(x => x.retired).length,
      prospect_ticks: state.prospected || 0,
      last: state.lastProspect || null,
    },
    // Every one of these is a candidate STREAM: callable by us, and proven to have paid a caller.
    streams_ready_to_stack: paying.slice(0, 12).map(x => ({
      chain: x.chain, contract: x.contract, name: x.name,
      callable: x.callable_now, example_payout: x.settled_examples?.[0] || null,
    })),
    // The generalisation. A shape that pays 6/6 predicts the next instance you have never seen.
    families_by_evidence: fams.slice(0, 12),
    how_to_read: 'families_by_evidence is the pattern layer: it generalises from contracts already tested to ones you have never seen. A family with pays>0 and pay_rate near 1 means that SHAPE pays callers — go find more instances of it. A family with zero>0 and pays=0 is an eliminated shape; skip every instance on sight and do not spend rounds re-deriving it. This is how elimination compounds instead of merely accumulating.',
  };
}
