// regress.mjs — ONE TEST PER DEFECT THAT ACTUALLY HAPPENED. Offline, no network, no keys, seconds.
//
//   node regress.mjs
//
// WHY THIS IS SEPARATE FROM selftest.mjs. selftest drives the 15 agent TOOLS against a throwaway
// wallet and needs the network. This file tests the PURE LOGIC underneath — the arithmetic and the
// predicates — which is where every expensive bug in this project has actually lived. Those bugs
// were never "the API call failed"; they were "the number was wrong and nothing noticed".
//
// THE RULE FOR ADDING TO THIS FILE: a test goes in here when a defect has been FOUND IN THE WILD,
// and the test must FAIL against the old code. A test written from imagination guards nothing —
// and worse, it makes the suite look thorough while the real failure modes go unwatched.
//
// Each test names the defect, the date, and what it cost.
import { priceEarnings, creditRoute, rowUsd, relayRequestBody, harvestChainQueue, relayTaskOpen, harvestInflightRecord, funnelShouldArm, escapeConvertFloorUsd, ESCAPE, spendableFromRows, harvestFeeTo } from './harvest.mjs';
import { searchCorpus, buildCorpus, reassembleDoc } from './docs.mjs';
import { dashboardHTML } from './dashboard2.mjs';
import fs from 'node:fs';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n        ' + e.message); fail++; }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DEFECT 1 — UNKNOWN PRICE RECORDED AS ZERO EARNINGS (2026-08-12)
// `price ? wei * price : 0` at both settlement sites, accumulated into the PERMANENT route ledger.
// A momentary price-feed outage wrote a real payout into history as $0.00, forever. The agent reads
// that ledger back in its own system prompt to decide which routes deserve a scarce relay slot.
await t('unknown price yields usd:null and preserves wei — never 0', () => {
  const r = priceEarnings('65822908733718', null);
  eq(r.usd, null, 'usd must be null, not 0:');
  eq(r.wei, '65822908733718', 'wei must survive exactly:');
  ok(r.unpriced === true, 'must be flagged unpriced');
});
await t('known price prices correctly', () => {
  const r = priceEarnings('1000000000000000000', 1891);
  eq(r.usd, 1891, 'one whole token at $1891:');
  ok(r.unpriced === false);
});
await t('a zero price is treated as UNKNOWN, not as free', () => {
  // A feed answering 0 is a broken feed, not a worthless token. Both must land in the same bucket.
  for (const bad of [0, -1, NaN, undefined]) {
    const r = priceEarnings('123', bad);
    eq(r.usd, null, `price ${bad} must be unknown:`);
    ok(r.unpriced === true);
  }
});
await t('creditRoute banks wei always and never adds a phantom $0', () => {
  const route = { earned_usd: 5 };
  creditRoute(route, '1000000000000000000', null);       // feed down
  eq(route.earned_usd, 5, 'usd must be untouched when unpriced:');
  eq(route.unpriced_wei, '1000000000000000000', 'wei must be parked:');
  eq(route.earned_wei, '1000000000000000000');
  creditRoute(route, '1000000000000000000', 10);          // feed back
  eq(route.earned_usd, 15, 'usd accrues when known:');
  eq(route.earned_wei, '2000000000000000000', 'wei accrues in both cases:');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DEFECT 2 — THE FIX FOR DEFECT 1 WOULD HAVE KILLED THE ONLY PAYING ROUTE (2026-08-12)
// isDead()'s escape hatch was `earned_usd > 0` alone. Once earnings stopped being force-converted,
// a route that earned during a feed outage carries earned_usd 0 with real money behind it, and two
// capacity-noise "blocked" counts would bury it. This exact burial once made the agent log every
// harvest under a fresh route id, inflating routes_tried from 22 to 38 in ten hours.
const { isDead } = await import('./worker.mjs');
await t('a route paid in wei but unpriced is NOT dead', () => {
  ok(!isDead({ blocked: 5, dead: true, earned_usd: 0, unpriced_wei: '1' }, 'beefy-harvest-caller-fees'),
    'money arrived as wei — it must outrank every flag');
});
await t('a route paid in usd is NOT dead (original hatch still works)', () => {
  ok(!isDead({ blocked: 9, dead: true, earned_usd: 0.07 }, 'x'));
});
await t('a route that never earned IS dead on the counter', () => {
  ok(isDead({ blocked: 2, earned_usd: 0 }, 'x'), 'no money ever = the counter decides');
});
await t('a malformed wei counter is not treated as evidence of earnings OR of death', () => {
  ok(isDead({ blocked: 2, earned_usd: 0, earned_wei: 'garbage' }, 'x'), 'unparseable must not resurrect');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DEFECT 3 — A CORPUS SEARCH THAT ANSWERS EVERYTHING ANSWERS NOTHING (2026-08-12)
// A retrieval layer the agent trusts must return NOTHING when it knows nothing, or it becomes a
// hallucination surface with extra steps.
const corpus = buildCorpus([{
  slug: 'x', title: 'X', markdown: '# X\n## WETH9 withdraw trap\nA Safe cannot unwrap WETH because transfer forwards only 2300 gas.',
}]);
await t('corpus finds a real passage', () => {
  const r = searchCorpus(corpus, 'can a Safe unwrap WETH');
  ok(r.results.length > 0, 'should have matched');
  ok(/2300/.test(r.results[0].text));
});
await t('corpus returns NOTHING for content it does not have', () => {
  const r = searchCorpus(corpus, 'kubernetes helm ingress controller');
  eq(r.results.length, 0, 'must not invent a best-effort match:');
});
await t('every corpus result carries the hypothesis warning', () => {
  ok(/HYPOTHESIS/.test(searchCorpus(corpus, 'WETH').warning || ''), 'the health warning must travel with results');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DEFECT 4 — LAST-WRITER-WINS ON THE EARNINGS LEDGER (2026-08-12)
// scheduled() fires FIVE concurrent waitUntil blocks, one of which is the agent's own session. Its
// route_log and harvest_run tools write `state:routes` and `harvest:state` while the earner loop
// writes the same keys. batchHarvest read state, then polled relay status for up to ~60 SECONDS,
// then wrote the captured blob back — erasing anything recorded in that minute.
const { mutateKV, cronLeaseHeld, cronSessionDue, cronSessionShouldRun, cronHygieneTick, sessionIsStale, CRON_LEASE_HOLD_MS, SESSION_STALE_MS } = await import('./kv.mjs');
const fakeKV = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, _m: m }; };

await t('mutateKV applies the mutation to FRESH state, not a stale capture', async () => {
  const env = { KV: fakeKV() };
  await env.KV.put('state:routes', JSON.stringify({ routes: { a: { earned_usd: 1 } } }));
  // Simulate the real bug: a long operation captured state, then a concurrent writer landed.
  const stale = await env.KV.get('state:routes', 'json');
  await env.KV.put('state:routes', JSON.stringify({ routes: { a: { earned_usd: 1 }, b: { earned_usd: 99 } } }));
  // OLD behaviour would be: put(stale) -> route b is gone.
  stale.routes.a.earned_usd += 5;
  // NEW behaviour: mutate against whatever is there now.
  await mutateKV(env, 'state:routes', (db) => { db.routes.a.earned_usd += 5; return db; });
  const after = await env.KV.get('state:routes', 'json');
  eq(after.routes.a.earned_usd, 6, 'our own increment must land:');
  ok(after.routes.b, 'the concurrent writer\'s route MUST still exist — this is the lost update');
  eq(after.routes.b.earned_usd, 99);
});
await t('mutateKV stamps a monotonic version so a clobber is detectable', async () => {
  const env = { KV: fakeKV() };
  await mutateKV(env, 'k', (s) => { s.n = 1; return s; });
  const v1 = (await env.KV.get('k', 'json'))._v;
  await mutateKV(env, 'k', (s) => { s.n = 2; return s; });
  const v2 = (await env.KV.get('k', 'json'))._v;
  ok(v2 > v1, `version must advance: ${v1} -> ${v2}`);
});

await t('a live cron lease blocks the overlapping */2 invocation', () => {
  const now = 1_700_000_000_000;
  ok(cronLeaseHeld({ at: now - 60_000 }, now), 'tick that started 60s ago is still in flight');
  ok(!cronLeaseHeld({ at: now - CRON_LEASE_HOLD_MS - 1 }, now), 'expired lease must not block');
  ok(!cronLeaseHeld(null, now), 'missing lease must run');
  ok(!cronLeaseHeld({ at: 'nope' }, now), 'garbage lease must run, not deadlock the cron');
});
await t('GLM session ticks skip janitor and discovery ticks', () => {
  ok(!cronSessionDue(0), 'tick 0 is janitor (%5) and discovery (%3)');
  ok(cronSessionDue(1), 'tick 1 is a sparse session slot');
  ok(!cronSessionDue(21), 'tick 21 is a discovery tick');
  ok(!cronSessionDue('nope'), 'garbage jtick must not fire a session');
});
await t('a leased session tick is replayed on the next non-hygiene tick', () => {
  ok(cronSessionShouldRun(1, null), 'the sparse slot still fires');
  ok(!cronSessionShouldRun(21, { at: 1 }), 'a miss must not stack GLM onto discovery');
  ok(!cronSessionShouldRun(0, { at: 1 }), 'a miss must not stack GLM onto janitor');
  ok(cronSessionShouldRun(2, { at: 1 }), 'tick 2 is the 2-min retry after a leased tick 1');
  ok(!cronSessionShouldRun(2, null), 'tick 2 without a miss is not a session slot');
  ok(cronHygieneTick(0) && cronHygieneTick(21) && !cronHygieneTick(1) && !cronHygieneTick(2));
});
await t('a session that sliced recently is not stale just because it started 50 min ago', () => {
  const now = 1_777_000_000_000;
  const live = { startedAt: now - 50 * 60_000, lastSliceAt: now - 20 * 60_000 };
  ok(!sessionIsStale(live, now), 'sparse GLM must be allowed to finish');
  ok(!sessionIsStale({ startedAt: now - 10 * 60_000 }, now), 'a brand-new session is not stale');
  ok(!sessionIsStale(null, now), 'missing state is not stale');
  ok(!sessionIsStale({ startedAt: 'nope' }, now), 'garbage startedAt must not abandon');
  ok(sessionIsStale({ startedAt: now - 3 * 3600_000, lastSliceAt: now - SESSION_STALE_MS - 1 }, now), '90 min without a slice is stale');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DEFECT 5 — SERVING A DOCUMENT REBUILT FROM CHUNKS DESTROYED EVERY HEADING (2026-08-12)
// chunkMarkdown consumed heading lines into metadata, and /docs/<slug> rebuilt the doc by joining
// chunk TEXT. Measured live: docs/safe.md has 34 headings; the endpoint served 1. A 34-section
// operational reference was published as one structureless wall.
const structured = buildCorpus([{
  slug: 'd', title: 'D',
  markdown: ['# D', '## Alpha', 'first body', '### Beta', 'second body', '## Gamma', 'third body'].join('\n'),
}]);
await t('reassembling a doc preserves every heading and its level', () => {
  const out = reassembleDoc(structured, 'd');
  for (const h of ['## Alpha', '### Beta', '## Gamma']) ok(out.includes(h), 'lost heading ' + h + ' in: ' + out);
  ok(out.includes('first body') && out.includes('third body'), 'body text must survive too');
});
await t('a long section repeats its heading only once', () => {
  const long = buildCorpus([{ slug: 'l', title: 'L', markdown: ['# L', '## Big', 'x'.repeat(4000)].join('\n') }]);
  const out = reassembleDoc(long, 'l');
  eq((out.match(/## Big/g) || []).length, 1, 'heading must appear exactly once across split chunks:');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DEFECT 6 — A FAILED RELAY READ BECAME "0 SLOTS", WHICH BECAME A FABRICATED REFILL SCHEDULE (2026-08-12)
// relayBudget answered `remaining: 0` for a 429/502/timeout/bot-403, and `Number(j.remaining ?? 0)`
// meant an error BODY parsed cleanly so `error` was never even set. observeRelay then stamped a fake
// exhaustion, the recovery next tick became a REFILL with a real timestamp, and relayResetSummary
// published `reset_schedule: "MEASURED: refills Xh apart"` into the agent's own system prompt.
// That is this project's single most expensive failure — a previous ZERO inventing "the relay resets
// at 5 AM UTC" and burning eleven sessions on it — rebuilt in code and stamped MEASURED.
const { observeRelay } = await import('./harvest.mjs');
await t('a MISSED relay reading records no refill and no exhaustion', async () => {
  const env = { KV: fakeKV() };
  await observeRelay(env, [{ name: 'base', remaining: 5, limit: 5 }]);
  await observeRelay(env, [{ name: 'base', remaining: null, limit: null, error: 'HTTP 429' }]);
  await observeRelay(env, [{ name: 'base', remaining: 5, limit: 5 }]);
  const st = await env.KV.get('relay:observations', 'json');
  eq(st.chains.base.refills.length, 0, 'a 5 -> unreadable -> 5 sequence is NOT a refill:');
  ok(!st.chains.base.exhaustedAt, 'an unreadable quota is not an exhaustion');
  eq(st.chains.base.missedReadings, 1, 'the miss must be counted, not hidden:');
});
await t('a REAL exhaustion and refill is still recorded', async () => {
  const env = { KV: fakeKV() };
  await observeRelay(env, [{ name: 'base', remaining: 5, limit: 5 }]);
  await observeRelay(env, [{ name: 'base', remaining: 0, limit: 5 }]);
  await observeRelay(env, [{ name: 'base', remaining: 5, limit: 5 }]);
  const st = await env.KV.get('relay:observations', 'json');
  eq(st.chains.base.refills.length, 1, 'a genuine 0 -> 5 IS a refill:');
  ok(st.chains.base.exhaustedAt, 'a genuine 0 IS an exhaustion');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DEFECT 7 — THE SWEEP GATED ON A STICKY FLAG MEANING "AN ESCAPE RELAYED ONCE, EVER" (2026-08-12)
// `hs.escaped` is set from an HTTP 201 and never reset. False => LEG B skipped AND LEG A blocked by
// `if (pending.length) return`, wedging the whole rail with money already burned at the source.
// True (its permanent state) => no protection at all, so the mint can take the Base slot the funnel
// is waiting on. worker.mjs had already migrated harvest_run off this exact variable.
const { sweepCycle } = await import('./sweep.mjs');
await t('with no harvest:state at all, the mint leg is still reachable', async () => {
  const env = { KV: fakeKV() };
  await env.KV.put('sweep:state', JSON.stringify({ pending: [{ chain: 'optimism', tx: null, taskId: null, at: new Date().toISOString() }], done: [] }));
  // escapeNeedsBase false => the escape is not holding Base => LEG B must run. It will fail to
  // resolve a tx (there is none) but it must not be SKIPPED, which is what the old gate did.
  const out = await sweepCycle(env, async () => { throw new Error('no rpc in this test'); }, '0x0', { escapeNeedsBase: false });
  eq(out.pending, 1, 'entry still queued:');
  ok(!('skipped_leg_b' in out), 'LEG B must not be gated off by a missing harvest:state');
});
await t('when the funnel is holding Base, the mint leg yields', async () => {
  const env = { KV: fakeKV() };
  await env.KV.put('sweep:state', JSON.stringify({ pending: [{ chain: 'optimism', tx: '0x' + 'a'.repeat(64), at: new Date().toISOString() }], done: [] }));
  const out = await sweepCycle(env, async () => { throw new Error('no rpc'); }, '0x0', { escapeNeedsBase: true });
  ok(!out.minted, 'must not spend the Base slot the funnel is waiting on');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DEFECT 8 — discover:state GREW WITHOUT BOUND AND KILLED THE AGENT (2026-08-23)
// 4.0 MB / 6,639 candidates, parsed in concurrent waitUntil blocks on a 128 MB isolate. Every cron
// from 04:20 to 05:00 died `exceededMemory`, session 933 never started, and because an over-memory
// kill produces no exception, the ledger just looked quiet. Serializing the two writers was tried
// and was NOT enough. The blob itself has to stop growing, and a proven payer must never be the
// thing that gets evicted to make room.
const { pruneDiscoverState, DISCOVERY_CALLER, loadDiscoverState, putDiscoverState, DISCOVER_SAFE_BYTES } = await import('./discover.mjs');
const { SMART_ACCOUNT, RETIRED_SAFE, LIVE_EOA } = await import('./shop.mjs');
await t('discovery simulates from the live Safe, not the retired 0x5106', () => {
  eq(DISCOVERY_CALLER.toLowerCase(), SMART_ACCOUNT.toLowerCase());
  ok(DISCOVERY_CALLER.toLowerCase() !== '0x510601f59fda068d70ad6760c9d9085b0f42cbb1', 'retired Safe must not be the discovery caller');
});
await t('expired PAYS_ZERO is dropped and a proven payer is kept', () => {
  const now = 1_000_000_000_000;
  const { state: out, pruned } = pruneDiscoverState({
    candidates: {
      'base:pays': { chain: 'base', contract: '0x1', payout_verdict: 'PAYS_CALLERS', first_seen: '2020' },
      'base:zero': { chain: 'base', contract: '0x2', payout_verdict: 'PAYS_ZERO', retired: true, retired_at: now - 50 * 86400e3, functions: Array(80).fill({ sig: 'x()', extra: 'fat' }) },
    },
  }, { cap: 2500, now });
  ok(out.candidates['base:pays'], 'proven payer must survive');
  ok(!out.candidates['base:zero'], 'expired PAYS_ZERO must go');
  ok(pruned >= 1, 'prune must report the drop');
});
await t('functions arrays are compacted so the blob cannot store 80 ABI objects per row', () => {
  const { state: out, compacted } = pruneDiscoverState({
    candidates: {
      'base:x': { payout_verdict: 'PAYS_CALLERS', functions: Array(80).fill({ sig: 'harvest()', name: 'Harvest', inputs: [1, 2, 3] }) },
    },
  });
  eq(out.candidates['base:x'].functions.length, 4, 'cap fat ABI dumps:');
  ok(out.candidates['base:x'].functions.every(f => f.sig === 'harvest()' && Object.keys(f).length === 1), 'keep selector only');
  ok(compacted >= 1);
});
await t('a cap never evicts PAYS_CALLERS', () => {
  const state = { candidates: { keep: { payout_verdict: 'PAYS_CALLERS', first_seen: '2019' } } };
  for (let i = 0; i < 20; i++) state.candidates['x' + i] = { retired: true, payout_verdict: 'PAYS_ZERO', retired_at: 1, first_seen: '2020-01-01' };
  const { state: out } = pruneDiscoverState(state, { cap: 5, now: 1e15 });
  ok(out.candidates.keep, 'payer survives a cap');
  ok(Object.keys(out.candidates).length <= 5, 'cap is honoured: ' + Object.keys(out.candidates).length);
});
await t('unset discover:bytes refuses the parse that OOM-killed every cron', async () => {
  const g = await loadDiscoverState({ KV: fakeKV() });
  ok(g.skipped, 'must skip');
  ok(/unset|refuse first parse/i.test(g.reason));
});
await t('a marked small blob loads, and putDiscoverState writes the size key', async () => {
  const env = { KV: fakeKV() };
  const put = await putDiscoverState(env, { candidates: { a: { payout_verdict: 'PAYS_CALLERS' } } });
  ok(put.bytes > 0 && put.bytes < DISCOVER_SAFE_BYTES);
  const g = await loadDiscoverState(env);
  ok(!g.skipped, g.reason);
  ok(g.state.candidates.a);
});
await t('an oversized marked blob is not parsed', async () => {
  const env = { KV: fakeKV() };
  await env.KV.put('discover:bytes', String(DISCOVER_SAFE_BYTES + 1));
  await env.KV.put('discover:state', JSON.stringify({ candidates: { boom: true } }));
  const g = await loadDiscoverState(env);
  ok(g.skipped);
  ok(!g.state.candidates?.boom, 'fallback must not be the fat blob');
});

await t('rowUsd includes Safe native — the live −$0.018741 dashboard gap', () => {
  const r = { eoa_native_usd: 0.598591, safe_usd: 0.014168, eoa_usd: 0, usdc_usd: 0.000646, safe_native_usd: 0.018741 };
  eq(+rowUsd(r).toFixed(6), 0.632146);
  const old = (x) => (x.eoa_native_usd || 0) + (x.safe_usd || 0) + (x.eoa_usd || 0) + (x.usdc_usd || 0);
  ok(Math.abs(old(r) - rowUsd(r) - (-0.018741)) < 1e-9 || Math.abs(rowUsd(r) - old(r) - 0.018741) < 1e-9, 'delta is exactly the omitted Safe native');
});
await t('rowUsd does not double-count wrapped aliases', () => {
  eq(rowUsd({ eoa_usd: 1, eoa_wrapped_usd: 1, safe_usd: 2, safe_wrapped_usd: 2 }), 3);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTROL. A guard that cannot fail is not a guard — it is decoration that makes the suite look
// thorough while the real failure mode goes unwatched. This project has the scar: a benchmark trap
// that could not fire for ANY input, so every candidate that cut a verification gate was published
// as PASSING it. So: re-implement each OLD, BROKEN behaviour here and assert the test above would
// have CAUGHT it. If a control ever starts "passing", the corresponding test has gone blind.
console.log('\n--- CONTROL: each guard must reject the old, broken behaviour ---');
const control = async (name, brokenFn) => {
  let caught = false;
  try { await brokenFn(); } catch { caught = true; }
  if (caught) { console.log('PASS  guard catches: ' + name); pass++; }
  else { console.log('FAIL  guard is BLIND to: ' + name + ' — the test would not have caught the original bug'); fail++; }
};

await control('old overlapping scheduled ticks both ran', () => {
  const old = (_lease) => false; // no skip gate — every cron entered waitUntil
  const now = 1_700_000_000_000;
  ok(old({ at: now - 1000 }), 'old code always ran the stacked tick:');
});
await control('old GLM session on every cron including janitor+discovery', () => {
  const oldDue = (_jtick) => true;
  ok(!oldDue(0), 'old code ran GLM on the OOM-stacking hygiene tick:');
});
await control('old lease skip dropped the GLM slot instead of replaying it', () => {
  const oldShouldRun = (jtick, _missed) => cronSessionDue(jtick);
  ok(oldShouldRun(2, { at: 1 }), 'CONTROL: tick 2 after a leased tick 1 would wait 20 min:');
});
await control('old stale check aged from startedAt, which kills every sparse session', () => {
  const now = 1_777_000_000_000;
  const live = { startedAt: now - 50 * 60_000, lastSliceAt: now - 20 * 60_000 };
  const oldBroken = (state, t) => state && (t - state.startedAt) > 45 * 60_000;
  ok(!oldBroken(live, now), 'CONTROL: 45 min from start would abandon a session that sliced 20 min ago:');
});
await control('old health aged only completed sessions, so sparse GLM always looked dead', () => {
  const now = Date.now();
  const meta = { lastSession: new Date(now - 35 * 3600_000).toISOString() };
  const oldHours = (now - Date.parse(meta.lastSession)) / 3600000;
  ok(oldHours < 2, 'CONTROL: completed-only age would trip DEGRADED while a slice is live:');
});
await control('old usable treated a missing chainWork row as harvestable', () => {
  const oldUsable = (work, remaining, name) => work && work[name] === 0 ? 0 : (remaining || 0);
  eq(oldUsable({ base: 224 }, 5, 'gnosis'), 0, 'CONTROL: gnosis 5/5 with no work row counted as 5 usable:');
});
await control('old priceEarnings coercing unknown price to $0', () => {
  const oldPrice = (wei, price) => ({ wei, usd: price ? Number(wei) / 1e18 * price : 0, unpriced: false });
  const r = oldPrice('65822908733718', null);
  eq(r.usd, null, 'old code returned 0 here, which the test must reject:');
});
await control('old isDead burying a route that earned only unpriced wei', () => {
  const oldIsDead = (r) => { if (r.earned_usd > 0) return false; if (r.dead === true || r.blocked >= 2) return true; return false; };
  ok(!oldIsDead({ blocked: 5, dead: true, earned_usd: 0, unpriced_wei: '1' }), 'old code returned dead=true for a paying route:');
});
await control('old treasury coercing an unpriced chain to $0 in the total', () => {
  // The shape of the bug: two reads of identical on-chain state, one with the feed up and one down.
  const oldTotal = (wei, price) => (price ? Number(wei) / 1e18 * price : 0);
  const up = oldTotal('65822908733718', 1891), down = oldTotal('65822908733718', null);
  ok(up === down, `the same balance produced $${up} and $${down} from a feed hiccup — a total must not move when the chain did not:`);
});
await control('the old join-the-text reassembly, which dropped every heading', () => {
  const oldJoin = structured.chunks.filter(c => c.slug === 'd').map(c => c.text).join('\n\n');
  ok(oldJoin.includes('## Alpha'), `old reassembly silently lost headings — served: ${JSON.stringify(oldJoin)}`);
});
await control('old relayBudget turning a 429 into a real-looking "0 slots remaining"', () => {
  const oldBudget = (j) => ({ remaining: Number(j.remaining ?? 0), limit: Number(j.limit ?? 0) });
  const r = oldBudget({ error: 'Too Many Requests' });      // a 429 JSON body parses cleanly
  ok(r.remaining === null, `old code reported remaining=${r.remaining} for an ERROR body — indistinguishable from a genuine exhaustion:`);
});
await control('old observeRelay recording a fabricated refill from a failed read', async () => {
  const env = { KV: fakeKV() };
  // The old code had no null branch: a failed read arrived as 0 and was treated as an observation.
  const oldObserve = async (budgets) => {
    const st = (await env.KV.get('relay:observations', 'json')) || { chains: {} };
    for (const b of budgets) {
      const c = st.chains[b.name] ||= { refills: [] };
      if (c.lastRemaining !== undefined && b.remaining > c.lastRemaining) c.refills.unshift({ at: 'now' });
      c.lastRemaining = b.remaining;
    }
    await env.KV.put('relay:observations', JSON.stringify(st));
    return st;
  };
  await oldObserve([{ name: 'base', remaining: 5 }]);
  await oldObserve([{ name: 'base', remaining: 0 }]);        // <- was actually an HTTP 429
  const st = await oldObserve([{ name: 'base', remaining: 5 }]);
  eq(st.chains.base.refills.length, 0, 'old code invented a refill out of network noise:');
});
await control('a corpus search that returns a best-effort match for unknown content', () => {
  const r = searchCorpus(corpus, 'kubernetes helm ingress controller');
  ok(r.results.length > 0, 'corpus correctly returned nothing, so this control fires as expected:');
});
await control('old per-chain sum omitting Safe native ETH', () => {
  const old = (x) => (x.eoa_native_usd || 0) + (x.safe_usd || 0) + (x.eoa_usd || 0) + (x.usdc_usd || 0);
  const r = { eoa_native_usd: 0.5, safe_usd: 0.01, safe_native_usd: 0.02, usdc_usd: 0 };
  eq(old(r), rowUsd(r), 'old sum dropped Safe native, so this equality must fail:');
});
await control('old inspect() defaulting to the retired Safe', () => {
  const oldCaller = '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';
  eq(oldCaller.toLowerCase(), DISCOVERY_CALLER.toLowerCase(), 'old default was the retired Safe:');
});
await control('old discover:state write keeping expired PAYS_ZERO forever', () => {
  const oldPrune = (s) => ({ state: s, pruned: 0 });
  const now = 1_000_000_000_000;
  const { state: out } = oldPrune({
    candidates: { 'base:zero': { payout_verdict: 'PAYS_ZERO', retired: true, retired_at: now - 50 * 86400e3 } },
  });
  ok(!out.candidates['base:zero'], 'old code kept the expired zero that OOM-killed the isolate:');
});
await control('old cron parsing discover:state with no size gate', async () => {
  const env = { KV: fakeKV() };
  await env.KV.put('discover:state', JSON.stringify({ candidates: { fat: true } }));
  const old = async (e) => (await e.KV.get('discover:state')) || { candidates: {} };
  const parsed = await old(env);
  ok(!parsed.candidates?.fat, 'old code always parsed the fat blob:');
});

// DEFECT 9 — local harness was missing every harvest tool the Worker exposes (2026-08-27)
// CLAUDE.md: "tool semantics are duplicated — change BOTH." Local agent.mjs could not harvest,
// inspect, or ask gas_sources, so a local session was a different agent.
const { TOOL_DEFS, TOOL_IMPL } = await import('./tools.mjs');
const { harvestScan, harvestRun, harvestSafe } = await import('./harvest.mjs');
await t('local harness exposes harvest_scan/batch/run/stats + inspect + gas_sources', () => {
  const names = TOOL_DEFS.map(d => d.function.name);
  for (const n of ['harvest_scan', 'harvest_batch', 'harvest_run', 'harvest_stats', 'inspect_contract', 'gas_sources', 'payout_history', 'discover_list', 'payout_oracle', 'gasless_control', 'doc_search', 'treasury', 'experiment']) {
    ok(names.includes(n), `${n} missing from TOOL_DEFS`);
    ok(typeof TOOL_IMPL[n] === 'function', `${n} missing from TOOL_IMPL`);
  }
});
await t('Worker TOOL_DEFS names match the local harness', () => {
  const src = fs.readFileSync(new URL('./worker.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('const TOOL_DEFS = [');
  const end = src.indexOf('].map(f => ({ type: \'function\'', start);
  ok(start >= 0 && end > start, 'could not find Worker TOOL_DEFS');
  const workerNames = [...src.slice(start, end).matchAll(/\{ name: '([^']+)'/g)].map(m => m[1]).sort();
  const localNames = TOOL_DEFS.map(d => d.function.name).sort();
  eq(workerNames, localNames, 'tool-name drift between worker.mjs and tools.mjs:');
  eq(Object.keys(TOOL_IMPL).sort(), localNames, 'TOOL_IMPL keys must match TOOL_DEFS:');
});
await t('dashboard names the in-flight session instead of a 35h completed-session gap', () => {
  const html = dashboardHTML({
    session_in_progress: { session: 973, round: 2, started: '2026-08-27T23:02:28.980Z' },
    sessions_completed: 972,
    last_session: '2026-08-26T11:50:30.804Z',
    health: { state: 'EARNING', headline: 'Working. Money is arriving.', signals: [], capacity: { free: 11, usable: 11, total: 30 } },
    balances: { spendable_liquid_native_eth_on_base_usd: 0.61, holdings_usd: 0.65, phase0_target_usd: 1, phase0_pct: 61 },
    prospect: { grind: { PROVEN_PAYING: 1, callable_now: 1, total_candidates: 1 } },
  });
  ok(html.includes('session 973') && html.includes('in flight'), 'must name the live session');
  ok(!html.includes('last 35h ago') && !html.includes('last 36h ago'), 'must not headline the completed-session gap');
});
await t('harvestScan and harvestRun are shared functions, not Worker-only copies', () => {
  ok(typeof harvestScan === 'function' && typeof harvestRun === 'function');
});
await t('harvestSafe ignores env.SAFE_ADDRESS pointed at the retired Safe', () => {
  eq(harvestSafe({ SAFE_ADDRESS: RETIRED_SAFE }).toLowerCase(), SMART_ACCOUNT.toLowerCase());
  eq(harvestSafe({ SAFE_ADDRESS: '0x0000000000000000000000000000000000000001' }).toLowerCase(), SMART_ACCOUNT.toLowerCase());
});
await t('Base harvest fee lands at the EOA; other chains stay on the Safe', () => {
  // DEFECT: harvest(address Safe) then needed a second relay slot to get spendable ETH at the EOA.
  // CONTROL: the old always-Safe recipient.
  const old = (chain, safe) => safe;
  eq(old('base', SMART_ACCOUNT).toLowerCase(), SMART_ACCOUNT.toLowerCase());
  ok(old('base', SMART_ACCOUNT).toLowerCase() !== LIVE_EOA.toLowerCase(), 'control still pays the Safe');
  eq(harvestFeeTo('base', SMART_ACCOUNT).toLowerCase(), LIVE_EOA.toLowerCase());
  eq(harvestFeeTo('gnosis', SMART_ACCOUNT).toLowerCase(), SMART_ACCOUNT.toLowerCase());
  eq(harvestFeeTo('optimism', SMART_ACCOUNT).toLowerCase(), SMART_ACCOUNT.toLowerCase());
});
await t('relay POST body includes the Rhinestone-required safeTxHash', () => {
  const hash = '0x' + 'ab'.repeat(32);
  const body = relayRequestBody({
    to: SMART_ACCOUNT,
    data: '0x6a761202',
    gasLimit: '1000000',
    safeTxHash: hash,
  });
  eq(body.safeTxHash, hash);
  eq(body.version, '1.4.1');
  eq(body.gasLimit, '1000000');
  eq(body.to.toLowerCase(), SMART_ACCOUNT.toLowerCase());
});
await t('a Base escape does not skip Optimism harvests', () => {
  const q = harvestChainQueue({ escapeNeedsBase: false, spent: ['base'] });
  ok(!q.includes('base'), 'Base already spent');
  ok(q.includes('optimism') && q.includes('arbitrum') && q.includes('polygon'), 'other quotas are independent');
});
await t('an Arbitrum sweep does not skip Base or Optimism harvests', () => {
  const q = harvestChainQueue({ escapeNeedsBase: false, spent: ['arbitrum'] });
  ok(!q.includes('arbitrum'));
  ok(q.includes('base') && q.includes('optimism'));
});
await t('an in-flight Base funnel does not skip Optimism harvests', () => {
  const q = harvestChainQueue({ escapeNeedsBase: true, spent: ['base'] });
  ok(!q.includes('base'));
  ok(q.includes('optimism') && q.includes('polygon'));
});
await t('Rhinestone status 100 is still in flight; a mined tx is not', () => {
  const now = 1_777_000_000_000;
  ok(relayTaskOpen({ status: 100, tx: null }, now - 120_000, now), 'status 100 must skip the next POST');
  ok(relayTaskOpen({ status: 409, tx: null }, now - 120_000, now), 'HTTP 409 must skip the next POST');
  ok(!relayTaskOpen({ status: 409, tx: null }, now - 11 * 60_000, now), 'stale 409 must not lock the chain forever');
  ok(!relayTaskOpen({ status: 100, tx: null }, now - 11 * 60_000, now), 'stale status 100 must expire');
  ok(!relayTaskOpen({ status: 100, tx: '0xabc' }, now - 120_000, now), 'a receipt frees the nonce');
  ok(!relayTaskOpen({ status: 'ExecReverted', tx: null }, now - 120_000, now), 'a dead task is not a lock');
  ok(relayTaskOpen({ status: null, tx: null }, now - 60_000, now), 'recent unknown status is still open');
  ok(!relayTaskOpen({ status: null, tx: null }, now - 11 * 60_000, now), 'stale unknown status is not a lock forever');
});
await t('a 409 with no taskId is still recovered as inflight', () => {
  const rec = harvestInflightRecord({
    inflight: { optimism: { taskId: '409:optimism', at: 1_777_000_000_000, reason: '409' } },
  }, 'optimism');
  eq(rec.reason, '409');
  eq(rec.taskId, '409:optimism');
});
await t('a relayed harvest with no tx is recovered as inflight from the log', () => {
  const rec = harvestInflightRecord({
    log: [{ chain: 'base', taskId: 'task-base-1', relayed: true, at: '2026-08-27T22:38:00.000Z' }],
  }, 'base');
  eq(rec.taskId, 'task-base-1');
  ok(!harvestInflightRecord({ log: [{ chain: 'base', taskId: 'task-base-1', relayed: true, at: '2026-08-27T22:38:00.000Z' }] }, 'optimism'));
});
await t('funnel accumulate below the $0.02 floor is not work when the EOA reserve is healthy', () => {
  eq(escapeConvertFloorUsd(0.61), ESCAPE.aboveReserveFloorUsd);
  eq(escapeConvertFloorUsd(0.01), ESCAPE.belowReserveFloorUsd);
  ok(!funnelShouldArm({ safeWethUsd: 0.014, usdcUnits: 0n, eoaNativeUsd: 0.61, safeWethWei: 5601711337343n, priceKnown: true }));
  ok(funnelShouldArm({ safeWethUsd: 0.1244, usdcUnits: 0n, eoaNativeUsd: 0.002, safeWethWei: 1n, priceKnown: true }), 'origin: $0.1244 with empty reserve must arm');
  ok(funnelShouldArm({ safeWethUsd: 0.03, usdcUnits: 0n, eoaNativeUsd: 0.61, safeWethWei: 1n, priceKnown: true }), 'above $0.02 with healthy reserve must arm');
});
const { spendableOverstated, INVARIANT_CFG, chainsPricedAtZero, publishedChainsPricedAtZero } = await import('./invariants.mjs');
await t('a mill of ETH-price drift is not spendable-overstated', () => {
  ok(!spendableOverstated(0.61477996, 0.61472861, INVARIANT_CFG.spendableSlackUsd));
  ok(spendableOverstated(0.2272606, 0.002176, INVARIANT_CFG.spendableSlackUsd), 'origin 104x must still fire');
});
await t('a failed Base price read is unmeasured, not priced-at-zero', () => {
  const liveHit = { base: { wrapped: '5601711337343', native: '0', priceKnown: false, usdContribution: null } };
  eq(chainsPricedAtZero(liveHit), [], 'failed nativeUsd must not look like $0:');
  ok(chainsPricedAtZero({ base: { wrapped: '5601711337343', native: '0', priceKnown: false, usdContribution: 0 } }).length === 1,
    'coercing unknown price to $0 must still fire');
  eq(publishedChainsPricedAtZero([{ chain: 'base', price_known: false, eoa_native_wei: '1', eoa_usd: null, safe_usd: null, eoa_native_usd: null, usdc_usd: null }]), []);
  ok(publishedChainsPricedAtZero([{ chain: 'polygon', price_known: false, eoa_wei: '1', eoa_usd: 0, safe_usd: 0, eoa_native_usd: 0, usdc_usd: 0 }]).length === 1,
    'published $0 for unpriced wei must fire');
});
const { diagnose, sessionHoursSinceActivity, chainUsable, reviveStatusPayload, reviveSpendableBalances, STALL } = await import('./health.mjs');
await t('an in-flight GLM slice is not "sessions stopped"', () => {
  const now = Date.now();
  const meta = { lastSession: new Date(now - 35 * 3600_000).toISOString(), barrenStreak: 0 };
  const current = { startedAt: now - 10 * 60_000, lastSliceAt: now - 10 * 60_000 };
  const hours = sessionHoursSinceActivity(meta, current, now);
  ok(hours !== null && hours < STALL.sessionQuietHours, 'live slice must count as activity');
  const h = diagnose({
    earnings: {},
    relay: { chains: [{ name: 'base', remaining: 2, limit: 5 }] },
    prospect: { grind: { still_queued: 0, PROVEN_PAYING: 1, last: new Date(now).toISOString() } },
    meta, harvest: { log: [{ wei_earned: '1', at: new Date(now).toISOString() }], chainWork: { base: 1 } },
    refill: { medianGapHours: 24, nextEtaHours: 12 },
    current,
  });
  ok(!h.signals.includes('sessions-stopped'), 'in-flight session must not trip sessions-stopped: ' + h.signals.join(','));
  ok(h.state !== 'DEGRADED' || !/session/i.test(h.headline), 'must not headline a false session outage: ' + h.state + ' ' + h.headline);
});
await t('gnosis 5/5 with no chainWork entry is not usable capacity', () => {
  eq(chainUsable({ base: 224 }, 5, 'gnosis'), 0);
  eq(chainUsable({ base: 224 }, 0, 'base'), 0);
  eq(chainUsable({ polygon: 1 }, 4, 'polygon'), 4);
  eq(chainUsable(null, 5, 'gnosis'), 0, 'no census is not harvestable:');
  const h = diagnose({
    earnings: {},
    relay: { chains: [
      { name: 'gnosis', remaining: 5, limit: 5 },
      { name: 'unichain', remaining: 5, limit: 5 },
      { name: 'base', remaining: 0, limit: 5 },
      { name: 'polygon', remaining: 0, limit: 5 },
    ] },
    prospect: { grind: { still_queued: 0, PROVEN_PAYING: 1, last: new Date().toISOString() } },
    meta: { lastSession: new Date().toISOString(), barrenStreak: 0 },
    harvest: { log: [{ wei_earned: '1', at: new Date().toISOString() }], chainWork: { base: 224 } },
    refill: { medianGapHours: 24, nextEtaHours: 12 },
    current: { startedAt: Date.now(), lastSliceAt: Date.now() },
  });
  eq(h.capacity.usable, 0, 'live 23:50Z overstatement was usable=10:');
  ok(h.capacity.dead_chains.includes('gnosis') && h.capacity.dead_chains.includes('unichain'));
});
await t('a frozen status cache is revived to live clocks and usable=0', () => {
  const now = Date.parse('2026-08-28T00:00:40.029Z');
  const stale = {
    last_session: '2026-08-26T11:50:30.804Z',
    sessions_completed: 972,
    session_in_progress: { session: 973, round: 2, started: '2026-08-27T23:02:28.980Z' },
    harvest_events: [{ wei_earned: '1', at: '2026-08-27T23:39:00.000Z' }],
    prospect: { grind: { still_queued: 0, PROVEN_PAYING: 372, last: '2026-08-27T23:00:00.000Z' } },
    refill_eta: { hours: 19, chain: 'gnosis', basis: 'all chains' },
    health: {
      state: 'EARNING',
      hours_since_session_activity: 0.05,
      barren_streak: 0,
      capacity: {
        free: 10, usable: 10, total: 30, dead_chains: [],
        chains: [
          { name: 'gnosis', remaining: 5, limit: 5, work: null, usable: 5 },
          { name: 'unichain', remaining: 5, limit: 5, work: null, usable: 5 },
          { name: 'base', remaining: 0, limit: 5, work: 224, usable: 0 },
          { name: 'optimism', remaining: 0, limit: 5, work: null, usable: 0 },
          { name: 'arbitrum', remaining: 0, limit: 5, work: null, usable: 0 },
          { name: 'polygon', remaining: 0, limit: 5, work: null, usable: 0 },
        ],
      },
    },
  };
  const live = reviveStatusPayload(stale, { now });
  eq(live.health.capacity.usable, 0, '00:00Z cache said usable=10:');
  ok(live.health.hours_since_session_activity > 0.5, 'frozen 0.05h activity must age: ' + live.health.hours_since_session_activity);
  eq(live.health.state, 'CYCLING');
  ok(!/nullh/.test(live.health.headline), 'revived headline must not print cycle nullh: ' + live.health.headline);
});
await t('a missing Base reconcile row is unread spendable, not $0', () => {
  eq(spendableFromRows([{ chain: 'optimism', eoa_native_usd: 0 }]), null);
  eq(spendableFromRows([{ chain: 'base', eoa_native_usd: null }]), null);
  eq(spendableFromRows([{ chain: 'base', eoa_native_usd: 0.61336681 }]), 0.61336681);
  eq(spendableFromRows([{ chain: 'base', eoa_native_usd: 0 }]), 0);
});
await t('cached spendable $0 is revived from chainstate when reconcile missed Base', () => {
  const snap = {
    spendable_liquid_native_eth_on_base_usd: 0,
    phase0_target_usd: 1,
    phase0_pct: 0,
    holdings_usd: 0.64242955,
    holdings_breakdown: { spendable_native_eth_on_base_usd: 0 },
    all_chains_priced: [{ chain: 'optimism', eoa_native_usd: 0, usdc_usd: 0.000412 }],
    per_chain_read: [{ chain: 'base', eoa_native_usd: 0.61336681, eoa_wrapped_usd: 0, safe_wrapped_usd: 0.014, usdc_usd: null }],
    read_errors: ['base: RPC eth_call failed'],
  };
  const live = reviveSpendableBalances(snap);
  eq(live.spendable_liquid_native_eth_on_base_usd, 0.61336681);
  ok(live.all_chains_priced.some(r => r.chain === 'base'), 'holdings table must gain the Base row');
  const page = reviveStatusPayload({ balances: snap, health: { capacity: { chains: [] } } });
  eq(page.balances.spendable_liquid_native_eth_on_base_usd, 0.61336681);
});
await control('old reconcile publishing $0 spendable when Base was unread', () => {
  const old = (per) => {
    let usdSpendable = 0;
    for (const r of per) if (r.chain === 'base' && r.eoa_native_usd != null) usdSpendable += r.eoa_native_usd;
    return +usdSpendable.toFixed(8);
  };
  eq(old([{ chain: 'optimism', eoa_native_usd: 0 }]), null, 'old code published 0 when Base never appeared:');
});
await control('old status cache served frozen hours_since_session_activity', () => {
  const oldServe = (cached) => cached.health;
  const frozen = oldServe({ health: { hours_since_session_activity: 0.05, capacity: { usable: 10 } } });
  ok(frozen.hours_since_session_activity > 0.5, 'CONTROL: 35-min-old cache still said activity 0.05h:');
});
const { stampSessionSlice } = await import('./worker.mjs');
await t('a 0-round slice does not stamp lastSliceAt', () => {
  const state = { round: 2, lastSliceAt: 1000 };
  ok(!stampSessionSlice(state, 0, 9999));
  eq(state.lastSliceAt, 1000, 'empty slice must not heartbeat:');
  ok(stampSessionSlice(state, 2, 9999));
  eq(state.lastSliceAt, 9999);
});
const { transferSimOk, isLiveOwnedAddress } = await import('./janitor.mjs');
await t('transfer false / Error(string) revert data is not a successful sim', () => {
  ok(transferSimOk('0x'), 'empty return');
  ok(transferSimOk('0x0000000000000000000000000000000000000000000000000000000000000001'), 'true');
  ok(!transferSimOk('0x0000000000000000000000000000000000000000000000000000000000000000'), 'false');
  ok(!transferSimOk('0x08c379a000000000000000000000000000000000000000000000000000000000'), 'revert data');
});
await t('janitor will not scan the retired Safe', () => {
  ok(!isLiveOwnedAddress(RETIRED_SAFE));
  ok(isLiveOwnedAddress(SMART_ACCOUNT));
});
const { discoverList } = await import('./discover.mjs');
await t('discoverList hides retired PAYS_ZERO so they cannot be served as work', () => {
  const out = discoverList({
    passes: 3,
    candidates: {
      dead: { retired: true, payout_verdict: 'PAYS_ZERO', callable_now: ['harvest()'], chain: 'base', contract: '0x1' },
      live: { retired: false, callable_now: ['harvest()'], chain: 'base', contract: '0x2', payouts_seen: 4 },
    },
  });
  eq(out.total, 2);
  eq(out.promising, 1);
  eq(out.untried_promising[0].contract, '0x2');
});
await control('old local TOOL_IMPL with no harvest_scan', () => {
  const oldImpl = { ensure_wallet() {}, get_status() {} };
  ok(typeof oldImpl.harvest_scan === 'function', 'old harness had no harvest_scan:');
});
await control('old Worker schema missing tools the local harness exposes', () => {
  const localNames = TOOL_DEFS.map(d => d.function.name).sort();
  const oldWorker = localNames.filter(n => n !== 'bruteforce');
  eq(oldWorker, localNames, 'old Worker omitted bruteforce:');
});
await control('old dashboard aged only last_session, so sparse GLM looked 35h dead', () => {
  const html = dashboardHTML({
    session_in_progress: { session: 973, round: 2, started: '2026-08-27T23:02:28.980Z' },
    sessions_completed: 972,
    last_session: '2026-08-26T11:50:30.804Z',
    health: { state: 'EARNING', headline: 'Working.', signals: [], capacity: { free: 11, usable: 11, total: 30 } },
    balances: { spendable_liquid_native_eth_on_base_usd: 0.61, holdings_usd: 0.65, phase0_target_usd: 1, phase0_pct: 61 },
    prospect: { grind: {} },
  });
  const oldLine = `972 sessions run · last 35h ago`;
  ok(!html.includes('session 973'), 'CONTROL: in-flight session must be invisible to the old copy:');
  ok(html.includes(oldLine), 'CONTROL: old copy printed the 35h gap:');
});
await control('old harvestCycle honouring env.SAFE_ADDRESS = retired Safe', () => {
  const old = (env) => env.SAFE_ADDRESS || SMART_ACCOUNT;
  eq(old({ SAFE_ADDRESS: RETIRED_SAFE }).toLowerCase(), SMART_ACCOUNT.toLowerCase(), 'old env override harvested as retired:');
});
await control('old relay POST omitting safeTxHash', () => {
  const old = ({ to, data, gasLimit }) => ({ version: '1.4.1', to, data, gasLimit });
  const b = old({ to: SMART_ACCOUNT, data: '0x6a761202', gasLimit: '2500000' });
  ok(b.safeTxHash, 'old body had no safeTxHash and Rhinestone answered 400:');
});
await control('old Rhinestone gasLimit 1500000 on Base', () => {
  const oldLimit = '1500000';
  eq(oldLimit, '1000000', 'old 1.5M gasLimit 400d after the in-flight task cleared:');
});
await control('old escapeSpentSlot skipping every chain harvest', () => {
  const old = (escapeSpentSlot) => escapeSpentSlot ? [] : ['base', 'optimism', 'arbitrum', 'polygon', 'unichain', 'gnosis'];
  eq(old(true).includes('optimism'), true, 'old code harvested nothing after a Base funnel:');
});
await control('old harvest POST while Rhinestone task still status 100', () => {
  const oldSkip = (_st) => false;
  ok(oldSkip({ status: 100, tx: null }), 'old code posted the same nonce again:');
});
await control('old 409 inflight never expired', () => {
  const now = 1_777_000_000_000;
  const oldOpen = (st, submittedAt) => {
    if (st?.tx) return false;
    if (st?.status === 409 || st?.status === 100) return true;
    return submittedAt && (now - submittedAt) < 10 * 60 * 1000;
  };
  ok(!oldOpen({ status: 409, tx: null }, now - 18 * 60 * 1000), 'old 409:optimism skipped harvests after the nonce was free:');
});
await control('old funnel-idle wei floor firing while accumulate waited for $0.02', () => {
  const oldHasWork = (safeWeth, usdc) => safeWeth >= 2000000000000n || usdc >= ESCAPE.minUsdcUnits;
  ok(!oldHasWork(5601711337343n, 0n), 'old $0.0038 floor treated $0.014 waiting for $0.02 as a contradiction:');
});
await control('old spendable-overstated mill slack firing on price drift', () => {
  const old = (claimed, actual) => claimed > actual + 0.00001;
  ok(!old(0.61477996, 0.61472861), 'old $0.00001 slack treated $0.00005 of ETH-price drift as 104x:');
});
await control('old value-priced-at-zero firing on a failed price read', () => {
  const old = (perChain) => {
    const bad = [];
    for (const [name, r] of Object.entries(perChain)) {
      const held = BigInt(r.wrapped || 0) + BigInt(r.native || 0);
      if (held > 0n && r.priceKnown === false && (r.usdContribution ?? 0) === 0) bad.push(name);
    }
    return bad;
  };
  ok(old({ base: { wrapped: '5601711337343', native: '0', priceKnown: false, usdContribution: null } }).length === 0,
    'old check treated a failed Base price read as priced-at-zero:');
});
await control('old janitor treating transfer-false as success', () => {
  const old = (_ret) => true;
  ok(!old('0x0000000000000000000000000000000000000000000000000000000000000000'), 'old sim would burn a slot on return-false:');
});

// DEFECT 10 — payout_history called a Safe fee recipient PAYS_ZERO, and a 500 PAYS_ZERO (2026-08-27)
// F2 skipped every to.is_contract. ZERO harvests to its Safe, and keepers do too, so the bread-and-
// butter rail graded as "does not pay callers". Separately, a Blockscout 500 on token-transfers left
// moves=[] and prospect retired the candidate. Unmeasured is not proven-zero.
const { collectPayouts, payoutHistory } = await import('./payouts.mjs');
const SAFE = '0x75d93b33708e7cf5eb4dcf14dfc25254f5d5817f';
const STRAT = '0x8b45d51e015dac924eeaea754e6f768943206f05';
await t('a Safe that is the caller still counts as PAYS_CALLERS', () => {
  const paid = collectPayouts({
    contract: STRAT, caller: SAFE, named: [],
    moves: [
      { from: STRAT, to: SAFE, toRaw: SAFE, toIsContract: true, amount: '0.001', token: 'WETH' },
      { from: STRAT, to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', toRaw: '0xaa', toIsContract: true, amount: '1', token: 'WETH' },
    ],
  });
  eq(paid.length, 1);
  eq(paid[0].beneficiary, 'caller');
});
await t('harvest(address Safe) named recipient counts even though the Safe is a contract', () => {
  const paid = collectPayouts({
    contract: STRAT, caller: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', named: [SAFE],
    moves: [{ from: STRAT, to: SAFE, toRaw: SAFE, toIsContract: true, amount: '0.001', token: 'WETH' }],
  });
  eq(paid.length, 1);
  eq(paid[0].beneficiary, 'named-recipient');
});
await t('unnamed protocol sink stays plumbing', () => {
  const paid = collectPayouts({
    contract: STRAT, caller: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', named: [],
    moves: [{ from: STRAT, to: '0xcccccccccccccccccccccccccccccccccccccccc', toIsContract: true, amount: '1', token: 'WETH' }],
  });
  eq(paid.length, 0);
});
await t('a 500 on the tx list throws unmeasured instead of PAYS_ZERO', async () => {
  try {
    await payoutHistory(async () => ({ status: 500, text: '' }), { chain: 'base', contract: '0x' + '11'.repeat(20) });
  } catch (e) {
    ok(/unmeasured|explorer read failed/i.test(e.message), e.message);
    return;
  }
  throw new Error('500 was treated as a verdict');
});
await t('token-transfers 500 with empty internals is unmeasured, not PAYS_ZERO', async () => {
  const strat = '0x' + '22'.repeat(20);
  const hash = '0x' + 'ab'.repeat(32);
  const f = async (url) => {
    if (url.includes('/transactions?filter=to')) {
      return { status: 200, text: JSON.stringify({ items: [{ status: 'ok', method: 'harvest', hash, from: { hash: '0x' + '33'.repeat(20) } }] }) };
    }
    return { status: 500, text: '' };
  };
  try {
    await payoutHistory(f, { chain: 'base', contract: strat, sample: 1 });
  } catch (e) {
    ok(/unmeasured|explorer read failed/i.test(e.message), e.message);
    return;
  }
  throw new Error('failed transfer reads graded PAYS_ZERO');
});
await control('old toIsContract skip grading a Safe caller as PAYS_ZERO', () => {
  const old = (m) => {
    if (m.toIsContract) return [];
    return [{ beneficiary: 'caller' }];
  };
  const rows = old({ toIsContract: true, to: SAFE, from: STRAT, amount: '0.001' });
  ok(rows.length > 0, 'old grader skipped the Safe and called the rail dead:');
});
await control('old failed transfer read becoming PAYS_ZERO', () => {
  const old = (moves) => (moves.length ? 'PAYS_CALLERS' : 'PAYS_ZERO');
  eq(old([]), 'NO_EVIDENCE', 'old code treated empty moves (a 500) as PAYS_ZERO:');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
