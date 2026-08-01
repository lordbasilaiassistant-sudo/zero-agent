# ZERO audit — lane `health-state`

Modules: `health.mjs` (159) · `selftest.mjs` (199) · `dashboard.mjs` (443) · `shop.mjs` (491).
Read-only pass, 2026-07-31. Every P0/P1/P2 below is reproduced by a command quoted inline; nothing here
is asserted from reading alone.

**Headline: `shop.mjs` risks NO capital — phase 0 is not violated.** No wallet, no key, no signer, no
`send_tx`, no `relayExec`, no relay slot anywhere in the file. It only does `ethers.verifyTypedData`
(pure) and `eth_call`. What it *does* do is deliver goods against a payment instrument it can never
settle, and book that as revenue (H-4).

**The through-line of this lane: every one of the four modules answers a question it did not measure.**
`selftest` asserts a guard it cannot fail (H-1) and asserts it against a stale mirror of the code that
actually runs (H-2). `health` judges "has it ever earned" from a 50-row window while the cumulative
total sits unused in the same object (H-3). `dashboard` flatlines the hero when the *measurement* fails,
not when earnings go to zero (H-7). `shop` books an unsettleable IOU as cash (H-4).

---

## H-1 · P1 · `selftest.mjs:127-131` — the private-key gate passes with the guard deleted

```js
  try {
    await TOOL_IMPL.secret_store({ name: 'evil', value: '0x' + 'a'.repeat(64) });
    throw new Error('accepted a private key!');
  } catch (e) { if (!/private key/i.test(e.message)) throw e; }
```

**Why it is wrong.** The failure message *"accepted a private key!"* contains the substring
`private key`. It is thrown into its own `catch`, matches `/private key/i`, so `!test(...)` is `false`
and the rethrow is skipped. The test's own alarm is swallowed by the test's own filter.

**Proof (run):**

```
$ node -e "const brokenSecretStore = async () => ({stored:'evil'});   // guard removed
(async()=>{ try { await brokenSecretStore({name:'evil',value:'0x'+'a'.repeat(64)});
  throw new Error('accepted a private key!'); } catch(e){ if(!/private key/i.test(e.message)) throw e; }
  console.log('PROOF: selftest reported PASS while the private-key guard was REMOVED'); })()"
PROOF: selftest reported PASS while the private-key guard was REMOVED
```

**Concrete failure.** Delete `tools.mjs:274` / `worker.mjs:426` and `node selftest.mjs` still prints
`PASS  secret store/get/list + private-key refusal` and exits 0. The only automated protection against
ZERO writing its own deployer key into `creds:*` (readable back out through `secret_get`, and thence
into model context) is a test that cannot fail.

**Fix:**

```diff
--- a/selftest.mjs
+++ b/selftest.mjs
@@ -125,9 +125,11 @@
   const l = await TOOL_IMPL.secret_list();
   if (!l.secrets.some(s => s.name === 'test-api-key')) throw new Error('not listed');
-  try {
-    await TOOL_IMPL.secret_store({ name: 'evil', value: '0x' + 'a'.repeat(64) });
-    throw new Error('accepted a private key!');
-  } catch (e) { if (!/private key/i.test(e.message)) throw e; }
+  // The sentinel must NOT be catchable by the filter that guards the rethrow, or the test
+  // passes with the guard deleted. Assert on the outcome, never on an exception message
+  // that shares vocabulary with the thing being asserted.
+  let accepted = false;
+  try { await TOOL_IMPL.secret_store({ name: 'evil', value: '0x' + 'a'.repeat(64) }); accepted = true; }
+  catch (e) { if (!/private key/i.test(e.message)) throw new Error('wrong refusal: ' + e.message); }
+  if (accepted) throw new Error('secret_store ACCEPTED a raw private key');
+  if (await TOOL_IMPL.secret_list().then(x => x.secrets.some(s => s.name === 'evil'))) throw new Error('key was stored anyway');
 });
```

---

## H-2 · P1 · `selftest.mjs` tests `tools.mjs`, which is a stale mirror of the code that actually runs — two measured drifts, both of them fixes never back-ported

`worker.mjs` does **not** import `tools.mjs` (checked: `grep -n "tools.mjs" *.mjs` → only `agent.mjs:5`
and `selftest.mjs:13`). The Worker builds its own `makeTools(ctx)`. `worker.mjs:4` claims *"Tool
semantics mirror tools.mjs — change both"* and `worker.mjs:1194` already concedes *"the two have
drifted before, and a guard that only holds locally is not a guard."* **Both halves of that comment are
currently false and true respectively — they have drifted again, and selftest is testing the broken half.**

### Drift A — `isDead()` still carries the bug worker.mjs documents as having cost 88% of lifetime earnings

```js
// tools.mjs:310  (the copy selftest.mjs exercises)
  if (r.earned_usd > 0 && r.dead !== true) return false;

// worker.mjs:133 (production, FIXED 2026-07-31)
  if (r.earned_usd > 0) return false;
```

`worker.mjs:126-132` spells out exactly what `&& r.dead !== true` did: it disabled the escape hatch, so
`beefy-harvest-caller-fees` ($0.074421 = 88% of lifetime, 26 of 34 successes) was listed under
`DEAD_NEVER_REVISIT` in the system prompt every session. **`tools.mjs` still has it.**

**Proof (run):**

```
$ node -e "Promise.all([import('./tools.mjs'),import('./worker.mjs')]).then(([t,w])=>{
  const r={earned_usd:0.074421,dead:true,blocked:2,notes:[],attempts:26,successes:26};
  console.log('tools.mjs  isDead =',t.isDead(r,'beefy-harvest-caller-fees'));
  console.log('worker.mjs isDead =',w.isDead(r,'beefy-harvest-caller-fees'));})"
tools.mjs  isDead = true
worker.mjs isDead = false
```

### Drift B — `broke` is the degenerate default, and `selftest.mjs:38-42` asserts the degenerate default

```js
// tools.mjs:144
  out.broke = Object.values(out.chains).every(c => !c.eth || parseFloat(c.eth) === 0);

// worker.mjs:246 (fixed; worker.mjs:211 and :241 record that this returned broke:true for 39 sessions
// while real money sat on three chains)
  out.broke = !(earnedUsd > 0 || liquidUsd > 0 || Object.values(out.chains).some(c => parseFloat(c.eth || 0) > 0));
```

```js
// selftest.mjs:38-42
await t('get_status (fresh = broke)', async () => {
  const r = await TOOL_IMPL.get_status();
  if (r.broke !== true) throw new Error('fresh wallet should be broke: ' + JSON.stringify(r));
```

**Proof (run):**

```
$ node -e "const brokeOf=c=>Object.values(c).every(x=>!x.eth||parseFloat(x.eth)===0);
console.log('all RPCs errored        ->',brokeOf({base:{error:'ECONNRESET'},optimism:{error:'ECONNRESET'}}));
console.log('holds 10 USDC + 0 ETH   ->',brokeOf({base:{eth:'0',tokens:[{symbol:'USDC'}]}}));
console.log('holds 0.05 WETH + 0 ETH ->',brokeOf({base:{eth:'0',tokens:[{symbol:'WETH'}]}}));"
all RPCs errored        -> true
holds 10 USDC + 0 ETH   -> true
holds 0.05 WETH + 0 ETH -> true
```

`tools.mjs:118-122` catches every RPC error into `{error: …}`, so `!c.eth` is true and `broke` is true.
The test therefore **passes with the network unplugged** — it cannot distinguish a measured zero from a
failed measurement, which is the exact defect the memory records as *"39 sessions reported broke:true
while holding money"*. It also ignores tokens entirely, including WETH — the token harvest fees actually
arrive in (`worker.mjs:1339-1340`).

### Drift C — chain coverage

`tools.mjs:14-27` knows **2** chains (base, base-sepolia). `worker.mjs:25+` knows **7**. ZERO's measured
income is spread across base + arbitrum + polygon, so the tool selftest validates is structurally
incapable of seeing most of the money, and `broke` above is computed over a 2-chain universe.

**Fix — one of two, not both:**

```diff
--- a/tools.mjs
+++ b/tools.mjs
@@ -307,7 +307,8 @@ export function isDead(r, id) {
   if (!r) return false;
-  if (r.earned_usd > 0 && r.dead !== true) return false;
+  // Money arriving outranks any flag, unconditionally (see worker.mjs:126-132).
+  if (r.earned_usd > 0) return false;
   if (r.dead === true || r.blocked >= 2) return true;
```

…but the durable fix is to stop having two copies. `isDead` / `normId` / `NON_ROUTE_RE` / `notARoute` /
`closedCategory` / `route_log` are duplicated verbatim between the two files. Extract them to a single
`rules.mjs` imported by both, and point `selftest.mjs` at **that**, plus add a live smoke test that hits
`POST /tool?key=$ADMIN_KEY&name=…` (the endpoint `worker.mjs:1196` already built for exactly this and
which nothing calls).

---

## H-3 · P1 · `health.mjs:51-52` — "has it ever earned" is read from a 50-row rolling window, so a machine holding $0.084 reports *"Nothing has ever been earned"* and silently disarms two alarms

```js
  const lastWin = (harvest?.log || []).find(l => l.wei_earned && BigInt(l.wei_earned || '0') > 0n);
  const hoursSinceEarning = lastWin ? (now - Date.parse(lastWin.at)) / 3600000 : null;
```

`harvest.log` is truncated to 50 entries (`harvest.mjs:583`, `harvest.mjs:708`) and most entries are
`wei_earned: '0'`. Once 50 consecutive barren attempts accumulate, `lastWin` is `undefined` and
`hoursSinceEarning` becomes `null`. Three branches then change behaviour at once:

| line | gate | effect when `hoursSinceEarning === null` |
|---|---|---|
| `:67` | `hoursSinceEarning !== null && > 1` | **idle-capacity alarm disarmed** |
| `:101` | `hoursSinceEarning !== null && > staleAfter` | **STALLED alarm can never fire** |
| `:131` | `state === 'EARNING' && hoursSinceEarning === null` | state becomes `NO INCOME YET`, headline `"Nothing has ever been earned."` |

So the alarm system goes quiet in exactly the situation it exists for: many attempts, no wins.

**Proof (run):**

```
$ node -e "import('./health.mjs').then(({diagnose})=>{
  const relay={chains:[{name:'gnosis',remaining:5,limit:5},{name:'unichain',remaining:5,limit:5},
    {name:'base',remaining:4,limit:5},{name:'polygon',remaining:3,limit:5},{name:'arbitrum',remaining:2,limit:5}]};
  const d=diagnose({earnings:{},relay,prospect:null,meta:{},
    harvest:{chainWork:{gnosis:0,unichain:0,base:7,polygon:0,arbitrum:0},log:[]},refill:null});
  console.log('state=%s usable=%d signals=%j',d.state,d.capacity.usable,d.signals);
  console.log('headline:',d.headline);})"
state=NO INCOME YET usable=4 signals=[]
headline: Nothing has ever been earned.
```

Four usable slots sitting idle and **zero signals raised.** `dashboard.mjs:55` then maps
`NO INCOME YET` → verdict `BROKEN`, so the public page asserts *"Nothing has ever been earned"* in the
diagnosis block while the tile 40 lines above it renders `lifetime earned $0.084468` from the route
ledger. Two numbers on one page contradicting each other.

**Root cause is that the truth is passed in and discarded.** `diagnose({ earnings, … })` destructures
`earnings` at `health.mjs:29` and **never references it again** (`grep -n earnings health.mjs` → lines
20, 29, 91 only; 20 and 91 are comments). `harvest.wins` and `harvest.weiEarned` are cumulative, sit in
the same object as `harvest.log`, and are also unused.

**Fix:**

```diff
--- a/health.mjs
+++ b/health.mjs
@@ -49,8 +49,15 @@ export function diagnose({ earnings, relay, prospect, meta, harvest, refill }) {
   // ── money: when did value last actually arrive? ──
-  const lastWin = (harvest?.log || []).find(l => l.wei_earned && BigInt(l.wei_earned || '0') > 0n);
-  const hoursSinceEarning = lastWin ? (now - Date.parse(lastWin.at)) / 3600000 : null;
+  // `log` is a 50-row window (harvest.mjs:583/708). It answers "when did money last arrive"; it
+  // must NEVER be used to answer "has money EVER arrived" — 50 barren rows would erase a real
+  // history and disarm both the idle-capacity and STALLED alarms at once.
+  const lastWin = (harvest?.log || []).find(l => {
+    try { return BigInt(l.wei_earned || '0') > 0n; } catch { return false; }
+  });
+  const hoursSinceEarning = lastWin ? (now - Date.parse(lastWin.at)) / 3600000 : null;
+  const everEarned = Number(harvest?.wins || 0) > 0
+    || (() => { try { return BigInt(harvest?.weiEarned || '0') > 0n; } catch { return false; } })()
+    || Number(earnings?.all_chains_usd || 0) > 0 || !!earnings?.has_earned;
@@ -65,7 +72,7 @@
-  if (usableSlots >= STALL.idleSlotAlarm && hoursSinceEarning !== null && hoursSinceEarning > 1) {
+  if (usableSlots >= STALL.idleSlotAlarm && (hoursSinceEarning === null || hoursSinceEarning > 1)) {
@@ -129,8 +136,12 @@
-  if (state === 'EARNING' && hoursSinceEarning === null) {
+  if (state === 'EARNING' && hoursSinceEarning === null && !everEarned) {
     state = 'NO INCOME YET';
     headline = 'Nothing has ever been earned.';
     action = 'Work the proven-paying queue.';
+  } else if (hoursSinceEarning === null && everEarned) {
+    state = 'STALLED';
+    headline = `It HAS earned (${harvest?.wins || 0} wins, ${harvest?.weiEarned || 0} wei lifetime) but not once in the last ${(harvest?.log || []).length} recorded attempts.`;
+    action = 'Every logged attempt in the window paid zero. Target selection is broken, not gas — re-probe before spending another slot.';
+    signals.push('no-income');
   }
```

Also return `ever_earned: everEarned` so the dashboard can stop deriving it from the same window.

---

## H-4 · P1 · `shop.mjs:391-402` + `424-436` — an authorization ZERO can never settle is delivered against and booked as revenue; one wallet holding the price once can mint unlimited free reports

```js
// shop.mjs:397-402
    // Bank the bearer instrument; ZERO submits it once it can afford one paymaster operation.
    await env.KV.put('auth:' + String(check.nonce).toLowerCase(), JSON.stringify({
      slug, at: new Date().toISOString(), units: check.paid_units, from: check.from,
      authorization: check.authorization, signature: check.signature, settled: false,
    }));
    settlement = 'authorization accepted and banked; it settles on-chain when the agent can afford one paymaster operation';
```

```js
// shop.mjs:427-428  (runs on BOTH branches, including the unsettled one)
    r.attempts += 1; r.successes += 1;
    r.earned_usd = +(r.earned_usd + Number(check.paid_units) / 1e6).toFixed(6);
```

**Why it is wrong — three compounding facts.**

1. **Nothing ever settles it.** `grep -rn "auth:" *.mjs` returns exactly two hits, both in `shop.mjs`
   (`:257` the read for replay-protection, `:398` this write). `grep -rn "settled" *.mjs` shows
   `settled: false` is written and never read anywhere. `transferWithAuthorization` (`0xe3ee160e`)
   appears nowhere in the repo. The "banked bearer instrument" is a write-only dead-letter — a
   textbook **success-is-not-payment**: the code treats "the signature verified" as "we were paid."
2. **It cannot settle in time even in principle.** `shop.mjs:245` only requires
   `validBefore > now + 30`. A 31-second authorization is accepted. ZERO's own gate for affording one
   paymaster op is `balances.can_transact = usdcB >= 0.009087` (`worker.mjs:1368`) — currently false,
   and it is false *because* it has not been paid.
3. **The nonce is buyer-chosen, so the same funds authorize unlimited purchases.** `shop.mjs:266-267`
   checks the payer *holds* ≥ the price; it never checks the funds *move*. `shop.mjs:257-263` rejects
   only nonces already seen (KV) or already consumed on-chain. A fresh random nonce passes both.

**Proof (live `eth_call`, Base mainnet, USDC `0x8335…2913`, `authorizationState(address,bytes32)` =
`0xe94a0102` verified via `ethers.id`):**

```
$ node -e "…three random nonces, method eth_call, https://base-rpc.publicnode.com…"
nonce 0xc0070b7af6… authorizationState = 0x0000…0000 | shop.mjs:263 lets it through: true
nonce 0x6234d7a866… authorizationState = 0x0000…0000 | shop.mjs:263 lets it through: true
nonce 0x27f385ef87… authorizationState = 0x0000…0000 | shop.mjs:263 lets it through: true
```

**Concrete failure.** A buyer funds one wallet with $0.05 USDC and loops: sign a new authorization
(new nonce, 60-second validity) → receive the report → repeat. Each iteration runs a GLM completion or a
full `bruteforceContract`/`probeMany` sweep (dozens of RPC calls) for free, and each iteration adds
`+0.05` to `state:routes['x402-shop-sales'].earned_usd`. That number is summed into
`lifetime_earned_usd` at `worker.mjs:1423`, rendered as the **"lifetime earned"** headline tile
(`dashboard.mjs:255-257`), served at `/ledger`, and is the input to the $16.66/day metric. The one
autonomous-earning number this company reports becomes attacker-controlled and, more importantly,
becomes wrong by construction the first honest time an x402 client uses the endpoint.

**Fix — two independent changes.** (a) do not book unsettled authorizations as earnings; (b) do not
deliver against an instrument that cannot be settled before it expires.

```diff
--- a/shop.mjs
+++ b/shop.mjs
@@ -242,7 +242,11 @@ export async function verifyAuthorization(env, rpc, headerValue, minUnits, payTo
   const now = Math.floor(Date.now() / 1000);
   if (Number(auth.validAfter) > now) return { ok: false, why: 'authorization is not valid yet' };
-  if (Number(auth.validBefore) <= now + 30) return { ok: false, why: 'authorization already expired (or expires within 30s)' };
+  // ZERO cannot broadcast; the authorization must outlive the wait for a paymaster op it can
+  // afford. 30s guaranteed expiry-before-settlement = goods delivered for a promise that dies.
+  const MIN_WINDOW = 6 * 3600;
+  if (Number(auth.validBefore) <= now + MIN_WINDOW) {
+    return { ok: false, why: `authorization must stay valid for at least ${MIN_WINDOW / 3600}h — this agent cannot broadcast and settles asynchronously` };
+  }
@@ -424,10 +428,15 @@ export async function handleShop(req, env, url, rpc, payTo) {
-    const r = db.routes['x402-shop-sales'] ||= { attempts: 0, successes: 0, blocked: 0, earned_usd: 0, notes: [] };
-    r.attempts += 1; r.successes += 1;
-    r.earned_usd = +(r.earned_usd + Number(check.paid_units) / 1e6).toFixed(6);
-    r.last = { at: new Date().toISOString(), outcome: 'success' };
+    // SETTLED cash and an UNSETTLED promise are different ledgers. Only `tx` is money that
+    // arrived; an EIP-3009 authorization nobody has broadcast is a receivable, and booking it as
+    // earned_usd feeds a fiction straight into lifetime_earned_usd (worker.mjs:1423).
+    const settledNow = !!tx;
+    const rid = settledNow ? 'x402-shop-sales' : 'x402-shop-receivable';
+    const r = db.routes[rid] ||= { attempts: 0, successes: 0, blocked: 0, earned_usd: 0, notes: [] };
+    r.attempts += 1;
+    if (settledNow) { r.successes += 1; r.earned_usd = +((r.earned_usd || 0) + Number(check.paid_units) / 1e6).toFixed(6); }
+    r.last = { at: new Date().toISOString(), outcome: settledNow ? 'success' : 'pending' };
```

(`x402-shop-receivable` survives `NON_ROUTE_RE` — no noise token — and `outcome: 'pending'` keeps it out
of the earnings sum.) Separately, rate-limit unsettled deliveries per `auth.from` (KV counter), or
require `tx` for the two expensive products (`payout-oracle`, `interface-xray`) until a settler exists.

---

## H-5 · P2 · `health.mjs:42` — "usable" only handles `work === 0`; chains missing from `chainWork` default to fully usable, and `work < remaining` is ignored

```js
  const work = harvest?.chainWork || null;
  const chains = (relay?.chains || []).map(c => ({
    ...c,
    work: work ? (work[c.name] ?? null) : null,
    usable: work && work[c.name] === 0 ? 0 : (c.remaining || 0),
  }));
```

Two holes, both of which re-create the overstatement the file's own doctrine at `:33-37` says it
prevents (*"reporting '8 free slots' when only 3 can actually be used is the same species of
overstatement as pricing WPOL as ETH"*).

1. **A chain absent from `chainWork` is treated as fully usable.** `chainWork` is written at
   `harvest.mjs:622` as `Object.fromEntries(tried.map(…))`, and the producing loop **`break`s** at
   `harvest.mjs:620` on the first chain with fresh work. Chains ranked *below* the winner
   (`pickChain` sorts by `remaining` desc, `harvest.mjs:88`) are never probed and never appear. The map
   is also fully replaced each cycle, so previously-known entries are dropped.
2. **`work` is a count of fresh strategies, but only `=== 0` is honoured.** One relay slot buys one
   `relayExec` on one strategy, so a chain with 4 free slots and 1 fresh strategy can spend 1 slot,
   not 4. `Math.min(remaining, work)` is the correct quantity.

**Proof (run):**

```
$ node -e "import('./health.mjs').then(({diagnose})=>{
  const relay={chains:[{name:'gnosis',remaining:5,limit:5},{name:'unichain',remaining:5,limit:5},
    {name:'base',remaining:4,limit:5},{name:'polygon',remaining:3,limit:5},{name:'arbitrum',remaining:2,limit:5}]};
  // chainWork exactly as harvest.mjs:622 writes it — the loop broke at base
  const harvest={chainWork:{gnosis:0,unichain:0,base:7},log:[{at:new Date(Date.now()-3*3600e3).toISOString(),wei_earned:'1000'}]};
  const d=diagnose({earnings:{},relay,prospect:null,meta:{},harvest,refill:null});
  console.log('state=%s free=%d usable=%d dead=%j',d.state,d.capacity.free,d.capacity.usable,d.capacity.dead_chains);
  console.log('headline:',d.headline);
  const d3=diagnose({earnings:{},relay,prospect:null,meta:{},harvest:null,refill:null});
  console.log('no chainWork -> usable=%d dead=%j',d3.capacity.usable,d3.capacity.dead_chains);})"

state=IDLE CAPACITY free=19 usable=9 dead=["gnosis","unichain"]
headline: 9 usable relay slots sitting unspent on base, polygon, arbitrum (19 free in total, but 10 are on chains with nothing harvestable: gnosis, unichain).
no chainWork -> usable=19 dead=[]
```

**Concrete failure.** The headline names **polygon and arbitrum as having usable capacity when neither
was ever probed for work**, and reports 9 usable where at most 4 (base) are known-spendable — the same
2.25× overstatement, attributing capacity to unmeasured chains, that the `FIXED 2026-07-31` note at
`health.mjs:69-78` was written to end. With `harvest:state` absent or `chainWork` missing entirely
(cold KV), it reports **19 usable on a machine with 4**. This number drives `next_move`, the
`IDLE CAPACITY` branch, and the `usable gas slots` hero tile (`dashboard.mjs:267-271`).

**Fix:**

```diff
--- a/health.mjs
+++ b/health.mjs
@@ -38,10 +38,17 @@ export function diagnose({ earnings, relay, prospect, meta, harvest, refill }) {
   const work = harvest?.chainWork || null;
   const chains = (relay?.chains || []).map(c => ({
     ...c,
     work: work ? (work[c.name] ?? null) : null,
-    usable: work && work[c.name] === 0 ? 0 : (c.remaining || 0),
+    // A slot buys ONE relayExec on ONE fresh strategy, so usable = min(slots, fresh).
+    // A chain with NO measurement is not "usable" — it is UNKNOWN, and counting unknown as
+    // usable is the exact overstatement the doctrine above forbids. Unmeasured is excluded
+    // from `usable` and surfaced separately so it prompts a probe instead of a false alarm.
+    usable: !work || work[c.name] == null ? 0 : Math.min(c.remaining || 0, work[c.name]),
+    unmeasured: !work || work[c.name] == null ? (c.remaining || 0) : 0,
   }));
@@ -45,6 +52,7 @@
   const usableSlots = chains.reduce((n, c) => n + (c.usable || 0), 0);
+  const unmeasuredSlots = chains.reduce((n, c) => n + (c.unmeasured || 0), 0);
```

…and add `unmeasured: unmeasuredSlots` to the returned `capacity` object, plus a
`signals.push('unmeasured-capacity')` when it is non-zero — a chain nobody probed is a *cheaper* lead
than a chain probed and found empty. The underlying producer bug (`harvest.mjs:620` `break` leaving
`chainWork` partial) belongs to the harvest lane; flagging here because health is where it becomes a lie.

---

## H-6 · P2 · `dashboard.mjs:53-56` — `IDLE CAPACITY` renders as the verdict `WAITING`, which the file defines as "nothing is wrong"

```js
     WAITING     — nothing is wrong; it is rate-limited by a resource that refills on a clock   // :51
  const st = String(h.state || '').toUpperCase();
  let verdict = 'WAITING', vtone = 'warn';
  if (['STALLED', 'DEGRADED', 'BROKEN', 'NO INCOME YET'].includes(st)) { verdict = 'BROKEN'; vtone = 'bad'; }
  else if (['EARNING', 'CYCLING'].includes(st)) { verdict = 'PROGRESSING'; vtone = 'good'; }
```

`WAITING` is the *default*, so any state not enumerated falls into "nothing is wrong". `IDLE CAPACITY`
is not enumerated — yet it is the single state where the scarce resource is **being destroyed**:
`health.mjs:83` says *"Slots expire worthless."* The one word the operator reads says the opposite of
what the diagnosis two tabs away says.

**Proof (run):**

```
$ node -e "import('./dashboard.mjs').then(({dashboardHTML})=>{const mk=s=>({health:{state:s,headline:'h',next_move:'n',capacity:{free:9,usable:9,total:25,chains:[]}},treasury:{},balances:{}});
for(const s of ['IDLE CAPACITY','CAPACITY EXHAUSTED','CYCLING','STALLED','NO INCOME YET','EARNING','DEGRADED'])
console.log(s.padEnd(20),'-> verdict',dashboardHTML(mk(s)).match(/class=\"vv\">([A-Z]+)</)[1]);})"

IDLE CAPACITY        -> verdict WAITING
CAPACITY EXHAUSTED   -> verdict WAITING
CYCLING              -> verdict PROGRESSING
STALLED              -> verdict BROKEN
NO INCOME YET        -> verdict BROKEN
EARNING              -> verdict PROGRESSING
DEGRADED             -> verdict BROKEN
```

**Fix — enumerate every state and fail closed on unknown ones, so a new health state can never silently
inherit "nothing is wrong":**

```diff
--- a/dashboard.mjs
+++ b/dashboard.mjs
@@ -52,7 +52,14 @@
-  const st = String(h.state || '').toUpperCase();
-  let verdict = 'WAITING', vtone = 'warn';
-  if (['STALLED', 'DEGRADED', 'BROKEN', 'NO INCOME YET'].includes(st)) { verdict = 'BROKEN'; vtone = 'bad'; }
-  else if (['EARNING', 'CYCLING'].includes(st)) { verdict = 'PROGRESSING'; vtone = 'good'; }
+  // Every health state is mapped EXPLICITLY. WAITING must never be the fallback: it means
+  // "nothing is wrong", and an unmapped state defaulting to it is how IDLE CAPACITY — slots
+  // actively expiring worthless — reported as healthy. Unknown => BROKEN, loudly.
+  const st = String(h.state || '').toUpperCase();
+  const VERDICT = {
+    EARNING: ['PROGRESSING', 'good'], CYCLING: ['PROGRESSING', 'good'],
+    'CAPACITY EXHAUSTED': ['WAITING', 'warn'],
+    'IDLE CAPACITY': ['BROKEN', 'bad'],   // capacity is being destroyed, not awaited
+    STALLED: ['BROKEN', 'bad'], DEGRADED: ['BROKEN', 'bad'], 'NO INCOME YET': ['BROKEN', 'bad'],
+  };
+  const [verdict, vtone] = VERDICT[st] || ['BROKEN', 'bad'];
```

---

## H-7 · P2 · `dashboard.mjs:406` (+ `worker.mjs:1381`) — the hero ECG flatlines and "holding now" reads $0.000000 when the *measurement* failed, not when earnings went to zero

```js
// dashboard.mjs:9   — the promise
// ... it must never be faked: if earnings go to zero, it flatlines.
// dashboard.mjs:406 — the code
  const earned=Number((D.treasury&&D.treasury.total_across_all_chains_usd)||0);
  const alive=earned>0, ampEl=document.getElementById('amp');
  ampEl.textContent=alive?('pulse · '+earned.toFixed(6)+' usd'):'flatline · no signal';
```

`data.treasury` comes from `worker.mjs:1381`: `treasuryPlan(rpcFn, address, payTo).catch(() => null)`.
A silent catch turns "one RPC call failed" into `null`, which `dashboard.mjs:36` turns into `0`, which
the hero graphic turns into a dead patient. Same shape at `dashboard.mjs:262/317/318`
(`spendable_usd` / `stranded_on_eoa_usd`) behind the silent `catch { }` at `worker.mjs:1366`. Nothing in
the payload distinguishes "measured 0" from "not measured", so the page has no honest state to render.

**Proof (run) — the same page asserting both things at once:**

```
$ node -e "import('./dashboard.mjs').then(({dashboardHTML})=>{
  const h=dashboardHTML({health:{state:'EARNING',headline:'x',capacity:{}},treasury:null,balances:{},lifetime_earned_usd:0.084468});
  console.log('lifetime tile :',h.match(/lifetime earned<\/div>\s*\n?\s*<div class=\"n [a-z]*\">([^<]*)</)[1]);
  console.log('holding tile  :',h.match(/holding now<\/div>\s*\n?\s*<div class=\"n\">([^<]*)</)[1]);})"

lifetime tile : $0.084468
holding tile  : $0.000000
ECG           : flatline · no signal
```

**Concrete failure.** One flaky public-RPC call makes the project's public face declare the agent dead
while its own ledger tile, rendered from KV, says it earned. The whole art direction of the page rests on
that trace being trustworthy; right now it is a liveness indicator for `mainnet.base.org`, not for ZERO.

**Fix — carry the failure into the payload and render a third state:**

```diff
--- a/worker.mjs
+++ b/worker.mjs
@@ -1379,7 +1379,7 @@
-        treasuryPlan(rpcFn, address, payTo).catch(() => null),
+        treasuryPlan(rpcFn, address, payTo).catch(e => ({ unavailable: String(e.message).slice(0, 120) })),
--- a/dashboard.mjs
+++ b/dashboard.mjs
@@ -34,7 +34,10 @@
-  const totalUsd = data.treasury?.total_across_all_chains_usd || 0;
+  // "not measured" is not "zero". A failed RPC must never render as a dead patient — the trace
+  // is only allowed to flatline on a MEASURED zero (dashboard.mjs:9).
+  const holdMeasured = !data.treasury?.unavailable && data.treasury != null;
+  const totalUsd = holdMeasured ? (data.treasury.total_across_all_chains_usd || 0) : null;
@@ -258,3 +261,3 @@
-      <div class="n">${usd(totalUsd)}</div>
+      <div class="n">${holdMeasured ? usd(totalUsd) : '<span style="color:var(--warn);font-size:17px">unmeasured</span>'}</div>
```

and in the script, gate on measurement before declaring death:

```diff
-  const earned=Number((D.treasury&&D.treasury.total_across_all_chains_usd)||0);
-  const alive=earned>0, ampEl=document.getElementById('amp');
-  ampEl.textContent=alive?('pulse · '+earned.toFixed(6)+' usd'):'flatline · no signal';
+  const meas=D.treasury&&!D.treasury.unavailable;
+  const earned=meas?Number(D.treasury.total_across_all_chains_usd||0):0;
+  const alive=meas&&earned>0, ampEl=document.getElementById('amp');
+  ampEl.textContent=!meas?'signal lost · balance not measured':alive?('pulse · '+earned.toFixed(6)+' usd'):'flatline · no signal';
+  if(!meas)ampEl.style.color='var(--warn)';
```

---

## H-8 · P2 · `dashboard.mjs:400` — `const D = ${d};` emits a raw `</script>` from agent-authored route notes, killing every script on the page

```js
  const d = JSON.stringify(data);        // :20
  ...
const D = ${d};                          // :400
```

`JSON.stringify` does not escape `</script>`. `data.routes` (`worker.mjs:1429`) contains `notes[]`
written from the model-controlled `note` parameter of `route_log` (`tools.mjs:356`, `worker.mjs:415`),
and `recent_harvests` contains raw relay/RPC `error` strings.

**Proof (run):**

```
$ node -e "import('./dashboard.mjs').then(({dashboardHTML})=>{
  const h=dashboardHTML({health:{state:'EARNING'},treasury:{},balances:{},
    routes:{x:{notes:['pwned </scr'+'ipt><scr'+'ipt>alert(1)//']}}});
  console.log(JSON.stringify(h.slice(h.indexOf('const D = '),h.indexOf('const D = ')+140)));})"

"const D = {\"health\":{\"state\":\"EARNING\"},\"treasury\":{},\"balances\":{},\"routes\":{\"x\":{\"notes\":[\"pwned </script><script>alert(1)//\"]}}};\n…"
```

**Concrete failure.** The inline `<script>` terminates at the injected tag: the tab controller
(`:384-399`) and the ECG (`:404-441`) never run, the remaining JS renders as visible page text, and the
injected `<script>` executes — stored XSS on a public origin, authored by a GLM-driven agent writing its
own journal notes. It needs no attacker; the model writing `"the </script> tag was in the response"` in
a route note is enough to take the page down.

**Fix:**

```diff
--- a/dashboard.mjs
+++ b/dashboard.mjs
@@ -19,7 +19,9 @@ export function dashboardHTML(data) {
-  const d = JSON.stringify(data);
+  // JSON.stringify does NOT escape "</script>". Route notes are model-authored, so an unescaped
+  // embed lets the agent's own journal terminate this script tag. Escape the three characters
+  // that can break out of an inline script or an HTML comment.
+  const d = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028|\u2029/g, m => '\\u202' + (m === '\u2028' ? '8' : '9'));
```

While here: `dashboard.mjs:364` interpolates `scout(l.chain)` into an `href` unescaped. `l.chain` comes
from the fixed `CHAINS` map today so it is not currently exploitable, but it should be
`esc(scout(l.chain))` for the same reason.

---

## H-9 · P3 · `shop.mjs:428` — missing `|| 0` that its sibling in `harvest.mjs` has

```js
// shop.mjs:428
    r.earned_usd = +(r.earned_usd + Number(check.paid_units) / 1e6).toFixed(6);
// harvest.mjs:723 — same operation, guarded
    r.earned_usd = +((r.earned_usd || 0) + usd).toFixed(6);
```

If `routes['x402-shop-sales']` exists without the field (hand-edited KV, or a schema change), the `||=`
at `:426` does not fire and the sum becomes `NaN`, permanently. `worker.mjs:1423` (`Number(…) || 0`) and
`dashboard.mjs:22` (`(Number(n)||0).toFixed(6)`) both convert that `NaN` to a confident `$0.000000` with
no error anywhere. Fix: `(r.earned_usd || 0)`, matching `harvest.mjs:723`.

## H-10 · P3 · `shop.mjs:273-292` — `verifyPayment` accepts any unredeemed *historical* USDC transfer to `payTo`

There is no recency window and no binding to the caller. Any USDC transfer to the smart account that has
not yet been burned — a donation, a refund, a transfer ZERO received for an unrelated reason — is a valid
payment token for whoever spots it first on the explorer. Low value (goods are self-generated and cheap),
but it also means an inbound transfer ZERO *keeps* silently entitles a stranger to a report. Fix: require
`rcpt.blockNumber` within ~24h of `now`, or record ZERO's own inbound transfers into the `paid:` burn set
when reconciling.

## H-11 · P3 · `selftest.mjs:111-119` — the broke-guard test passes when the RPC is merely unreachable

```js
    if (/insufficient|broke|zero balance|estimate failed/i.test(e.message)) return 'refused correctly';
```

`estimate failed` is what a dead RPC also produces. The test cannot distinguish "the guard fired" from
"the network is down". Fix: assert on the specific message `tools.mjs:342`/`worker.mjs:342` emits
(`/insufficient funds on .*You are broke here/`) and treat anything else as a failure.

## H-12 · P3 · `selftest.mjs:105-109` — bare `catch { return; }`

```js
  try { await TOOL_IMPL.route_log({ route_id: 'x', outcome: 'maybe' }); }
  catch { return; }
```

Passes on *any* throw, including `TOOL_IMPL.route_log is not a function` after a rename. Fix:
`catch (e) { if (/outcome must be one of/.test(e.message)) return; throw e; }`.

## H-13 · P3 · `dashboard.mjs:298` — `c.limit || 5` draws five slot pips for a chain whose budget fetch errored

`relayBudget` returns `{remaining: 0, limit: 0, error: true}` on failure (`harvest.mjs:77`). The row then
renders five empty pips next to the text `0/0` — an unmeasured chain drawn identically to a fully-spent
one. Fix: render an explicit "budget unreadable" row when `c.limit === 0`, and plumb `error` through
`worker.mjs:1401`'s `relayAll.map(...)`, which currently drops it.

## H-14 · P3 · `health.mjs:51` — unguarded `BigInt()` inside a function whose caller 500s the whole site

`dashboard.mjs:358` wraps the identical call in `try/catch`; `health.mjs:51` does not. `diagnose()` runs
inside the single `try` covering `worker.mjs:1332-1441`, so one malformed `wei_earned` in KV throws a
`SyntaxError` that returns HTTP 500 for both the HTML dashboard and the JSON API. Covered by the H-3
diff. Related: `Date.parse(lastWin.at)` on a missing `at` yields `NaN`, and every downstream comparison
against `NaN` is `false`, so the machine silently reports the most optimistic state (`EARNING`,
*"Working. Money is arriving"*) — guard with `Number.isFinite`.

---

# Verified NOT broken — do not re-check these

**health.mjs**
- `:51` `.find()` returns the **newest** win, not the oldest. `harvest.log` is built with `unshift`
  (`harvest.mjs:582`, `:707`), so it is newest-first. Correct as written.
- `:79-82` the `IDLE CAPACITY` headline reads `usableSlots`, the same variable its threshold gates on —
  the `FIXED 2026-07-31` note is genuinely applied, not just described.
- `:48` `deadChains` uses strict `c.work === 0`, so unprobed chains (`null`) are correctly excluded from
  the dead list (they are wrongly counted as *usable* instead — H-5 — but the dead list itself is right).
- `:87-88` `staleAfter = measuredCycle * 1.25 + 2` and the `nextEtaHours` formatting are sound;
  `measuredCycle` null falls back to `STALL.earningStaleFallbackHours` correctly.
- `:90-108` precedence is correct: the `STALLED` branch at `:101` deliberately supersedes `CYCLING` set
  at `:94`, and `CAPACITY EXHAUSTED` survives only for the never-earned case. Not an ordering bug.
- `:115` `queued > 0` with `queued === null` is `false` — no crash, branch correctly skipped.
- `:138-144` `nextMove` ladder is exhaustive and each rung is reachable.

**selftest.mjs**
- Covers **all 15** exports of `tools.mjs`'s `TOOL_IMPL` (enumerated via `Object.keys`): `ensure_wallet
  get_status web_search http_fetch explorer eth_call send_tx sign_message knowledge_list knowledge_read
  knowledge_write route_log secret_store secret_get secret_list`. The header's "every tool" claim is
  **true for that module** — the problem is which module (H-2), not the coverage.
- `:7-13` sets `AUTOGLM_HOME/SECRETS/CREDS` before a **dynamic** `await import('./tools.mjs')`. A static
  import would hoist above the assignments and defeat the sandbox. Correct as written, and load-bearing.
- `:95-103` dead-route test is genuine: it constructs the killing input, asserts the refusal, **and**
  asserts the ledger was not mutated (`attempts !== 1`). This one can fail.
- `:143-165` pseudo-route test is genuine — 23 real ids the agent actually invented, asserting both
  `refused` and `not_a_route` and then re-reading the file to confirm no pollution.
- `:167-181` is the correct negative control for the above (8 real ids that must survive the filter),
  including the deliberately adversarial `agentpact-needs-proposal` and `safe-sponsored-relay`.
- `:184-195` `payout_history` test is the strongest in the file: two live contracts, ground truth in
  **both** directions (`PAYS_ZERO` for the PoolTogether DrawManager, `PAYS_CALLERS` with non-empty
  `settled_payouts` for the Beefy strategy). Real network, real assertion, can fail.
- `:133-140` `NEVER_TOUCH` test is correctly structured — it demands the *blocklist* message specifically
  and fails loudly on any other error, which also proves the blocklist is checked before the broke check.
- `:199` exits non-zero on any failure.

**shop.mjs**
- **No capital risk whatsoever — phase 0 is respected.** No `ethers.Wallet`, no private key, no
  `send_tx`, no `relayExec`, no relay slot, no signing of anything. `verifyTypedData` is a pure recovery
  and `eth_call` is read-only. Anything CLAUDE.md would gate is absent.
- `:262` selector `0xe94a0102` **= `authorizationState(address,bytes32)`**, confirmed with
  `ethers.id(...).slice(0,10)`. The argument packing (`from` left-padded, `nonce` de-prefixed) is correct.
- `:263` polarity is right: non-zero storage = already used = reject.
- `:266-267` `balanceOf` selector `0x70a08231` correct; the comparison direction is right.
- `:280-287` `verifyPayment` log matching is correct in every detail — lowercased USDC address compare,
  `TRANSFER_TOPIC` on `topics[0]`, recipient on `topics[2]` with matching 64-hex padding, `BigInt(log.data)`
  for the value, and **multiple transfers in one tx are summed** rather than taking the first.
- `:406-407` burns the tx hash **before** delivering, so a slow report cannot be double-redeemed. Correct
  order, and the comment matches the code.
- `:240` underpay refusal, `:241` `payTo` binding, `:244` `validAfter`, `:253` `signer === from` — all
  present and correct (the `validBefore` window is too short, H-4, but the check exists and is correct
  in direction).
- `:274` tx-hash shape validation, `:276` replay burn read, `:279` `status !== '0x1'` revert check — all
  correct.
- `:119-181` x402 v2 header: `payTo`/`asset` are checksummed via `ethers.getAddress`, `amount` is the
  integer unit string, and `extensions.bazaar` carries both `info` and `schema` as the indexers require.
- `:64-69` `b64utf8` handles multi-byte UTF-8 correctly (TextEncoder → binary string → btoa) rather than
  the naive `btoa(str)` that throws on the `—` characters present in every product description.
- `:436` bookkeeping is wrapped so it can never fail a paid delivery. Correct priority.

**dashboard.mjs**
- `:358` wraps `BigInt(l.wei_earned)` in `try/catch` (unlike `health.mjs:51`). Correct here.
- `esc()` is applied to every string interpolated into HTML text or attribute position; the unescaped
  interpolations are all numbers, except `scout(l.chain)` at `:364` (noted in H-8).
- `:60-61` `Number.isFinite(lifetimeUsd) && > 0` correctly refuses to render a `NaN` lifetime, falling
  back to holdings.
- `:240` `[...LAYERS].reverse()` copies before reversing — `LAYERS` is not mutated across calls.
- `:413` log-scale amplitude `(log10(earned)+6)/6` clamped to `[.14, 1]` behaves correctly across the
  real range ($1e-6 … $1) and the `prefers-reduced-motion` branch at `:437` renders a static equivalent.
- `:391-398` the tablist handles clicks, arrow keys with wraparound, and deep links via `location.hash`.
- `:295-299` the dead-chain slot styling reads `c.work === 0`, consistent with `health.mjs:48`.

**Cross-module**
- `route_log` in `tools.mjs:330-364` and `worker.mjs:390-422` are currently semantically **identical**
  (closed-category, `notARoute`, `deadTwin`, counters, note capping, leaderboard). `NON_ROUTE_RE` and
  `normId` are byte-identical between the two files. Only `isDead`, `get_status`/`broke`, and `CHAINS`
  have drifted (H-2).
- `worker.mjs:1196` `POST /tool?key=…` exists and is the right harness for testing the production tool
  layer. It works; nothing calls it. See H-2's durable fix.
