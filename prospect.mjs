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
    // P3 fix: this replace used to substitute the match with ITSELF ('$1') — a no-op. Strip the
    // trailing specifics so ...VelodromeV4-Aero and ...VelodromeV4 land in one bucket.
    .replace(/(Strategy|Vault|Pool|Gauge)[A-Za-z0-9_-]*$/i, '$1')
    .slice(0, 48) || 'unknown';
}

const VERDICT = { PAYS: 'PAYS_CALLERS', ZERO: 'PAYS_ZERO', NONE: 'NO_EVIDENCE' };

// Pick the next candidate that will teach us the most per subrequest spent:
//   1. callable but never payout-checked  — one check away from being a usable stream
//   2. never scored for callability       — the raw backlog
// Within each, prefer contracts we have actually watched pay somebody.
function pickNext(candidates) {
  // D5 FIX: a candidate whose explorer lookup failed used to be re-selected on every tick forever
  // (deterministic max on payouts_seen) — one 500ing Blockscout page head-of-line-blocked the whole
  // grind. Backoff via payout_retry_after.
  const pending = Object.values(candidates)
    .filter(c => !c.retired || Date.now() - (c.retired_at || 0) > 30 * 86400e3)   // D13: eliminations expire
    .filter(c => !(c.payout_retry_after > Date.now()));
  const needsPayout = pending.filter(c => c.callable_now?.length && !c.payout_verdict);
  if (needsPayout.length) return { c: needsPayout.sort((a, b) => (b.payouts_seen || 0) - (a.payouts_seen || 0))[0], why: 'callable, payout unproven' };
  // WAS: c.callable_now === undefined — which no candidate can ever satisfy, because every write site
  // does 'ins.callable_now || []'. The queue was therefore always empty and this whole grind was dead
  // code reporting success. Select on a stamp that is only written after a real simulation.
  const unscored = pending.filter(c => !c.triaged_at);
  if (unscored.length) return { c: unscored.sort((a, b) => (b.payouts_seen || 0) - (a.payouts_seen || 0))[0], why: 'never triaged' };
  return { c: null, why: 'backlog empty — every known candidate is triaged' };
}

export async function prospectTick(env, fetcher) {
  const state = (await env.KV.get('discover:state', 'json')) || { candidates: {} };
  const { c, why } = pickNext(state.candidates || {});
  if (!c) return { skipped: why, triaged: Object.keys(state.candidates || {}).length };

  const out = { contract: c.contract, chain: c.chain, reason: why };

  // Stage 1 — resolve + simulate. Free, and the only thing that cannot lie about callability.
  if (!c.triaged_at) {
    try {
      const ins = await inspect(c.chain, c.contract);
      c.verified = !!ins.verified;
      c.access_controlled = ins.access_controlled ?? null;
      c.pays_a_caller = ins.pays_a_caller ?? null;
      c.implementation = ins.implementation || null;
      c.callable_now = ins.callable_now || [];
      c.triaged_at = Date.now();
      c.functions = ins.candidate_functions || [];
      c.name = ins.name || c.name || null;
      c.family = familyOf(c.name);
      out.stage = 'simulated';
      out.callable_now = c.callable_now;
      out.name = c.name;
    } catch (e) {
      c.callable_now = [];
      c.triaged_at = Date.now();   // attempted and failed still counts as triaged, or it blocks forever
      out.stage = 'simulate failed';
      out.error = String(e.message).slice(0, 120);
    }
  } else {
    // Stage 2 — it simulates callable, so the only question left is whether calling it PAYS.
    // A callable function that pays the caller nothing is worth exactly zero relay slots.
    try {
      const p = await payoutHistory(fetcher, { chain: c.chain, contract: c.contract, sample: 5 });
      // D13 FIX: NO_EVIDENCE means "we saw nothing", not "this contract never pays" — writing it as
      // the verdict froze the candidate forever (neither queued nor eliminated). Re-check in 24h.
      if (p.verdict === VERDICT.NONE) {
        c.payout_retry_after = Date.now() + 24 * 3600e3;
        out.stage = 'no evidence — will re-check';
      } else {
        c.payout_verdict = p.verdict;
      }
      // F2 follow-up: settled_payouts includes hardcoded fee sinks (strategist/feeRecipient) that
      // the CALLER can never receive. Size expectations only on caller-obtainable money.
      c.settled_examples = ((p.caller_obtainable || []).length ? p.caller_obtainable : p.settled_payouts || []).slice(0, 2);
      c.checked_at = new Date().toISOString();
      if (p.verdict === VERDICT.ZERO) { c.retired = true; c.retired_at = Date.now(); }   // D13: expires in pickNext
      out.stage = out.stage === 'no evidence — will re-check' ? out.stage : 'payout-checked';
      out.verdict = p.verdict;
      out.settled = c.settled_examples;
    } catch (e) {
      // D5 FIX: a failing check must leave a marker with backoff, or the same contract is picked
      // again on the very next tick and every tick after (proven: 4/4 ticks on one dead explorer).
      c.payout_fails = (c.payout_fails || 0) + 1;
      c.payout_retry_after = Date.now() + Math.min(6 * 3600e3, 300e3 * 2 ** c.payout_fails);
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

  // EVERY PROBE IS A LABELLED EXAMPLE, so stop throwing them away. Each triage produces
  // (chain, contract, implementation, family, callable, verdict, real settled amount) with GROUND
  // TRUTH attached — measured on-chain, not annotated by anyone. We have already generated thousands
  // of these and discarded them.
  //
  // This is not a fine-tuning set yet and should not be pitched as one: ~30 real lessons is a prompt,
  // not a dataset, and everything we have learned so far belongs in code (a guard cannot be ignored;
  // a weight can). But the corpus is free to collect and compounds while the prospector runs anyway.
  // Its FIRST use is an eval, not a fine-tune: a labelled set of "does this contract pay an arbitrary
  // caller" is exactly how you measure whether ANY model — or any heuristic — is good at this, which
  // is the question you must answer before it is worth training one.
  try {
    const corpus = (await env.KV.get('train:probes', 'json')) || { n: 0, rows: [] };
    corpus.rows.unshift({
      at: new Date().toISOString(),
      chain: c.chain, contract: c.contract, implementation: c.implementation || null,
      family: c.family || familyOf(c.name), name: c.name || null,
      payouts_seen: c.payouts_seen || 0,
      access_controlled: c.access_controlled ?? null,
      pays_a_caller_regex: c.pays_a_caller ?? null,   // the weak signal, kept as a feature to beat
      callable_now: c.callable_now || [],
      label: c.payout_verdict || (c.callable_now?.length ? 'CALLABLE_UNPROVEN' : 'NOT_CALLABLE'),
      settled: c.settled_examples?.[0] || null,
    });
    corpus.rows = corpus.rows.slice(0, 4000);
    corpus.n = (corpus.n || 0) + 1;
    await env.KV.put('train:probes', JSON.stringify(corpus));
  } catch { /* corpus collection must never block the grind */ }

  state.prospected = (state.prospected || 0) + 1;
  state.lastProspect = new Date().toISOString();
  // D6 FIX: discoveryPass runs concurrently (separate waitUntil, worker.mjs) and both read-modify-
  // write 'discover:state'. A long prospect tick used to be clobbered wholesale by discovery's
  // stale snapshot — verdicts, families and train:probes links vanished every 3rd cron tick.
  // Re-read and merge ONLY the fields this tick touched.
  const key = `${c.chain}:${String(c.contract).toLowerCase()}`;
  const fresh = (await env.KV.get('discover:state', 'json')) || { candidates: {} };
  fresh.candidates ||= {};
  if (fresh.candidates[key]) {
    fresh.candidates[key] = { ...fresh.candidates[key], ...pickFields(c) };
    fresh.families = { ...(fresh.families || {}), ...(state.families || {}) };
  } else {
    fresh.candidates[key] = c;
    fresh.families = { ...(fresh.families || {}), ...(state.families || {}) };
  }
  fresh.prospected = state.prospected;
  fresh.lastProspect = state.lastProspect;
  await env.KV.put('discover:state', JSON.stringify(fresh));

  const all = Object.values(state.candidates);
  out.progress = {
    total: all.length,
    // D4 FIX: `callable_now !== undefined` was always true — every write coerces to []. The triage
    // counters reported the backlog fully processed while never having simulated one candidate.
    triaged: all.filter(x => x.triaged_at).length,
    callable: all.filter(x => x.callable_now?.length).length,
    proven_paying: all.filter(x => x.payout_verdict === VERDICT.PAYS).length,
    eliminated: all.filter(x => x.retired && !(Date.now() - (x.retired_at || 0) > 30 * 86400e3)).length,
    remaining: all.filter(x => !x.triaged_at || (x.callable_now?.length && !x.payout_verdict)).length,
  };
  return out;
}

// The only fields prospectTick is authoritative for — everything else defers to fresher state.
function pickFields(c) {
  const { verified, access_controlled, pays_a_caller, implementation, callable_now, triaged_at,
    functions, name, family, payout_verdict, settled_examples, checked_at, retired, retired_at,
    payout_fails, payout_retry_after } = c;
  return { verified, access_controlled, pays_a_caller, implementation, callable_now, triaged_at,
    functions, name, family, payout_verdict, settled_examples, checked_at, retired, retired_at,
    payout_fails, payout_retry_after };
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
      triaged: all.filter(x => x.triaged_at).length,                 // D4 FIX: was always-true test
      still_queued: all.filter(x => !x.triaged_at).length,
      callable_now: all.filter(x => x.callable_now?.length).length,
      PROVEN_PAYING: paying.length,
      eliminated_forever: all.filter(x => x.retired && !(Date.now() - (x.retired_at || 0) > 30 * 86400e3)).length,
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
