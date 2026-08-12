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
import { priceEarnings, creditRoute } from './harvest.mjs';
import { searchCorpus, buildCorpus, reassembleDoc } from './docs.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('PASS  ' + name); pass++; }
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
const { mutateKV } = await import('./kv.mjs');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
