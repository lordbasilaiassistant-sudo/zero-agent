# Lane audit: discovery-prospect

**Modules:** `discover.mjs` (395) · `prospect.mjs` (176) · `bruteforce.mjs` (158)
**Date:** 2026-07-31 · READ-ONLY audit. Nothing outside this file was modified.
**Method:** every claim below is either (a) executed against the live module, or (b) measured with
`eth_call` / `eth_getCode` against public RPCs, or (c) a direct file:line citation. Nothing is asserted
from reading alone unless it is labelled as such.

---

## THE HEADLINE, measured

> **All 6 contracts in `KNOWN_PAYERS` — every contract ZERO has personally harvested, on all three
> chains — are 45-byte EIP-1167 minimal proxies. `resolveImpl()` resolves 0 of them.
> `extractSelectors()` returns 0 selectors for all of them. `inspect()` returns `"no source"` and never
> runs a single `eth_call`. `bruteforceContract()` returns `functions: 0, "no dispatch table found"`.**
>
> The discovery engine is structurally incapable of re-deriving its own income source.

```
arbitrum 0x3DAfB52975faB6B02eA6Cf4ead926E409Fa23ca0 bytes 45 eip1167 true -> 0x95c3228308e02f4defc4e8c339907ab19a4f62cd
optimism 0x01087C3419CDf589b55c086AAF006D5D8e54f7a1 bytes 45 eip1167 true -> 0x83ff748c4dad196944ded62c998ddc87a57a4198
optimism 0x20051a36204d4136E32D92e5b1015a311ee1a708 bytes 45 eip1167 true -> 0x83ff748c4dad196944ded62c998ddc87a57a4198
optimism 0xD7E0Cde3479AFbF63ed7B7AD850A857db8629a32 bytes 45 eip1167 true -> 0x83ff748c4dad196944ded62c998ddc87a57a4198
base     0xc664C800bC54229034A629335A231f279320a605 bytes 45 eip1167 true -> 0x68ecddba8d4cfca13923fc8d66f2678bf17ab4e1
base     0x8B45D51e015Dac924EeAEa754e6f768943206F05 bytes 45 eip1167 true -> 0x68ecddba8d4cfca13923fc8d66f2678bf17ab4e1
```

Whole-universe tally over `_beefy_base.json` (the same 241-entry list `worker.mjs:454` ranks):

```
vaults    : {"n":241,"eip1167_clones":241,"non_clone":0,"no_code":0,"distinct_impls":1}
strategies: {"n":241,"eip1167_clones":215,"non_clone":26,"no_code":0,"distinct_impls":5}
```

456 addresses. **6 distinct implementations behind all of them.** Six `eth_getCode` calls — or zero,
since the target address is literally inside the 45 bytes — would unlock the entire family.

---

# P0 findings

## D1 — `blindSeed()` throws `ReferenceError` on every single call; the whole "break the closed loop" fix is dead code

**`discover.mjs:59`**
```js
export async function blindSeed(chain, rpcRaw, blocks = 12) {
  const TRANSFER = ethers.id('Transfer(address,address,uint256)');
```

`discover.mjs` has **no top-level import of `ethers`**. The only `ethers` in scope anywhere in the file
is a *function-local* dynamic import inside `simulateCandidate` (`discover.mjs:232`). `blindSeed` is a
different function; `ethers` is undefined there.

**Proven by execution:**
```
$ node -e "import('./discover.mjs').then(m => m.blindSeed('base', rpcRaw, 2).catch(e => ...))"
THREW: ReferenceError :: ethers is not defined
```

The throw happens on the **first line of the function body**, before any RPC call, so it fails
identically on every chain, every pass. And it is swallowed:

**`discover.mjs:284-292`**
```js
  if (rpcRaw && (state.passes % 3 === 0 || !seeds.length)) {
    try {
      const blind = await blindSeed(chain, rpcRaw, 12);
      ...
    } catch { /* blind seeding is an enhancement, never a blocker */ }
  }
```

**Why it is wrong:** the 40-line comment block at `discover.mjs:39-57` correctly identifies the closed
Beefy loop as the reason "months of 48 proven streams was really one stream with 48 taps", declares
`blindSeed` THE FIX, and quotes measured results from it ("Measured on Base, 14 blocks: 66 paid callers,
47 paying contracts... MerkleDistributor, ERC20SignatureClaim, ConditionalTokens, BaseBulker"). Those
measurements were real — but they were taken somewhere else. In this file, on this code path, the
function has never once completed. Bug class 2 in its purest form: the comment is right and the code
disagrees.

**Concrete failure:** `state.blindSeeded` never increments, `fresh` is never computed, and
`discoveryPass` falls straight through to the Beefy self-seed at `:293`. Every candidate ZERO has ever
generated is from one family. On gnosis/unichain — chains with no `SEED_KEEPERS` and no `KNOWN_PAYERS` —
the `!seeds.length` branch fires, blindSeed throws, and the function returns
`{skipped: 'no seed keepers and no known payers for gnosis'}` at `:296`. Those two chains cannot produce
a candidate by any path.

**Severity: P0** — breaks earning (permanently caps discovery at one family; blocks two chains entirely).

**Fix (1 line):**
```diff
--- a/discover.mjs
+++ b/discover.mjs
@@ -1,4 +1,5 @@
 // discover.mjs — the teat-finder. Turns one proven income family into many.
+import { ethers } from 'ethers';
```
(and delete the now-redundant dynamic import at `:232`, or leave it — it is harmless.)

Second, the `catch` at `:291` must not be silent — a programming error is not "an enhancement failing":
```diff
-    } catch { /* blind seeding is an enhancement, never a blocker */ }
+    } catch (e) { state.blindSeedError = String(e.message).slice(0, 120); }
```
`state.blindSeedError` would have said `ethers is not defined` on pass 1.

---

## D2 — No EIP-1167 resolution anywhere: 100% of KNOWN_PAYERS and 89% of the Beefy strategy universe are invisible

**`discover.mjs:202-224` (`resolveImpl`)** checks EIP-1967 impl slot → OZ legacy slot → EIP-1967 beacon
slot → `implementation()`. **`bruteforce.mjs:60-68` (`implOf`)** checks the same three, minus legacy.
Neither checks the 45-byte minimal-proxy runtime, which holds the target as a plain PUSH20 immediate.

A clone has **no storage slots set** and **no `implementation()` function**, so all four probes return
null. Its runtime has **no dispatch table**, so the PUSH4 scan finds nothing — the file's own comment
says so and then does not handle it:

**`bruteforce.mjs:59`**
```js
/** A proxy's own bytecode has no dispatch table — resolve the implementation or find nothing. */
```

**Measured, 40 Beefy Base vaults:**
```
SUMMARY sample=40  eip1167_clones=40  zero_implOf_resolved=0  clones_yielding_zero_selectors=40
```

**Measured, 12 Beefy Base strategies (the actual harvest targets):** 11/12 are clones,
`zeroImplOfStrat: null` and `zeroSelsOnStrat: 0` for all 11. The one non-clone (`0x97f0609d…`, a Morpho
strategy) resolves fine via 1967.

**Measured, what resolution would recover:**
```
strategy 0x11dd6940 (the "success for every sig" one)
  clone -> 0x68ecddba8d4cfca13923fc8d66f2678bf17ab4e1
  ZERO sees 0 selectors on the clone; the 1167 target has 89
strategy 0x9bd7a4b5 (aerodrome weth-usdc)
  clone -> 0x4a9e42102d11f6c0a59d77722887e6a104c53636
  ZERO sees 0 selectors on the clone; the 1167 target has 92
vault 0x01F1A592
  clone -> 0x9818df1bdce8d0e79b982e2c3a93ac821b3c17e0
  ZERO sees 0 selectors on the clone; the 1167 target has 47
```

**Measured, is the recovered interface actually worth money?** I re-ran the full bruteforce screen with
the clone target resolved, against 4 clone strategies and a 3-token basket. Every one of them has a
paying function that ZERO currently cannot see:

| clone strategy | selectors after fix (before: 0) | paying selector | WETH delta to the caller (wei) |
|---|---|---|---|
| `0x11dd6940…` | 89 | `0x0e5c011e` = `harvest(address)` | 44,113,455,572 |
| `0x9bd7a4b5…` | 92 | `0x0e5c011e` | 641,730,347,427 |
| `0x68d24f7c…` | 86 | `0x0e5c011e` | 527,579,296,139 |
| `0xde0b7820…` | 89 | `0x0e5c011e` | 29,088,449,066 |

(Balance-delta of Multicall3 across an isolated `harvest(address)` at head. These are the same
sub-cent amounts ZERO already earns — the point is not the size, it is that `bruteforceContract`
currently reports `functions: 0` and `"no dispatch table found"` for all four.)

**Also measured — the resolution was already in an API the code calls.** Blockscout's
`/api/v2/addresses/{addr}` returns it directly:
```json
{"a":"0x11dd6940…","blockscout_name":null,"blockscout_implementations":["0x68Ecddba8D4CfCa13923fC8d66f2678BF17aB4e1"],"bytes":45,"eip1167":true}
```
`inspect()` calls `/api/v2/smart-contracts/{target}` and never looks at `implementations`. But the
bytecode regex is strictly better — free, no network, works on chains with no explorer.

**Severity: P0** — makes income permanently invisible across the only family ZERO earns from.

**Fix — `discover.mjs`, add step 0 to `resolveImpl`:**
```diff
+const EIP1167 = /^0x363d3d373d3d3d363d(?:73|6f)([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;
+
 export async function resolveImpl(chain, contract) {
   const rpc = RPCS[chain];
   if (!rpc) return null;
   try {
+    // 0. EIP-1167 minimal proxy — the target is a PUSH20 immediate in the 45-byte runtime. No
+    //    storage slot is set and implementation() does not exist, so every other probe returns null.
+    //    Measured 2026-07-31: 6/6 KNOWN_PAYERS, 241/241 Beefy Base vaults, 215/241 strategies.
+    const m = EIP1167.exec(String(await rawCall(rpc, 'eth_getCode', [contract, 'latest']) || '').toLowerCase());
+    if (m) return '0x' + m[1];
     // 1. direct EIP-1967 / legacy implementation slots
     for (const slot of [IMPL_SLOT, LEGACY_SLOT]) {
```

**Fix — `bruteforce.mjs`, same in `implOf` (it already fetches the code one line later, so pass it in):**
```diff
+const EIP1167 = /^0x363d3d373d3d3d363d(?:73|6f)([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;
+
 export async function implOf(rpc, chain, c) {
   try {
+    const m = EIP1167.exec(String(await rpc(chain, 'eth_getCode', [c, 'latest']).catch(() => '') || '').toLowerCase());
+    if (m) return '0x' + m[1];
     const a = word(await rpc(chain, 'eth_getStorageAt', [c, IMPL_SLOT, 'latest']).catch(() => null));
```
No other change is needed in `bruteforceContract` — it already unions the selectors of `contract` and
`impl` (`:80`) and correctly sends the probes to the **proxy** address (`:96`), which is right: the
clone `DELEGATECALL`s, so the storage the impl reads is the clone's. Verified the clone does forward:
`eth_call 0xdeadbeef` on `0x11dd6940…` → `execution reverted` (it is not a "returns success for
anything" fallback proxy; it dispatches into the impl's real table).

---

## D3 — `RPCS` covers 3 of 6 chains, and the 3 missing ones are exactly the 3 the cron rotation hits first

**`discover.mjs:172-176`**
```js
const RPCS = {
  base: 'https://base-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
};
```

`SCOUT` (`discover.mjs:10-20`) has six chains and the comment there explicitly celebrates adding
gnosis/unichain/polygon: *"These three were MISSING for the project's whole life"*. `RPCS` was not
updated. Consequences on those three chains:

- `resolveImpl` → `if (!rpc) return null` (`:204`) — no proxy is ever resolved.
- `simulateCandidate` → `{ callable: false, why: 'no rpc for chain' }` (`:228`) — **no candidate can
  ever become `callable_now`**, which is the only signal worth 1000 points in the ranking at `:369`
  and the only thing `prospect.mjs:39` will ever payout-check.

And the cron prioritises precisely those chains:

**`worker.mjs:1138-1139`**
```js
const DISCOVERY_ROTATION = ['gnosis', 'unichain', 'polygon', 'base', 'optimism', 'arbitrum'];
const dChain = DISCOVERY_ROTATION[Math.floor(tickNo / 3) % DISCOVERY_ROTATION.length];
```

Half of all discovery passes are spent on chains where the decisive test is hardwired to fail. Worse:
`discoveryPass` is *handed* a working chain-bound RPC (`rpcRaw`, `worker.mjs:1141`) and
`inspect`/`simulateCandidate`/`resolveImpl` ignore it in favour of this hardcoded map. That is the
"hardcoded chain constant inside a function that takes a chain parameter" pattern.
`worker.mjs:51,56` proves working endpoints already exist in the codebase.

**Severity: P0** — three chains, including polygon where ZERO already earns, can never produce a
callable candidate.

**Minimal fix:**
```diff
 const RPCS = {
   base: 'https://base-rpc.publicnode.com',
   optimism: 'https://optimism-rpc.publicnode.com',
   arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
+  polygon: 'https://polygon-bor-rpc.publicnode.com',
+  gnosis: 'https://gnosis-rpc.publicnode.com',
+  unichain: 'https://unichain-rpc.publicnode.com',
 };
```
**Better fix** (removes the whole class): thread the caller's `rpcRaw` into `inspect` /
`simulateCandidate` / `resolveImpl` and use `RPCS` only as a fallback — the worker already has retrying,
multi-endpoint RPCs per chain and this module reimplements a worse one.

---

# P1 findings

## D4 — `callable_now === undefined` is never true, so the entire triage grind is dead and the progress counters lie

Four separate places use `callable_now === undefined` to mean "never triaged":

**`prospect.mjs:41`** `const unscored = pending.filter(c => c.callable_now === undefined);`
**`prospect.mjs:54`** `if (c.callable_now === undefined) {` ← the whole Stage-1 resolve+simulate block
**`prospect.mjs:135,139,160`** the progress/intel counters
**`discover.mjs:332`** `const stale = Object.values(state.candidates).filter(c => c.callable_now === undefined && !c.tried);`

But **every** write site coerces it to an array:

**`discover.mjs:321`** `callable_now: ins.callable_now || [],`
**`discover.mjs:341`** `c.callable_now = ins.callable_now || [];`
**`discover.mjs:346`** `catch { c.callable_now = []; ... }`
**`prospect.mjs:61,69`** `c.callable_now = ins.callable_now || [];`

`inspect()` omits `callable_now` entirely on both early-return paths (`:137`, `:139`) — which, per D2,
is what happens for 100% of the clone universe — and `|| []` turns that omission into a defined empty
array. So a candidate that was never simulated is indistinguishable from one that was simulated and
found un-callable.

**Proven by execution** — 214 candidates constructed exactly as `discover.mjs:313-324` writes them:
```
A) 214 never-simulated candidates, written exactly as discoveryPass writes them:
   prospectTick -> {"skipped":"backlog empty — every known candidate is triaged","triaged":214}
   prospectIntel.grind -> {"total_candidates":214,"triaged":214,"still_queued":0,
                           "callable_now":0,"PROVEN_PAYING":0,"eliminated_forever":0,"prospect_ticks":0}
```

**Concrete failure:** this is bug class 3 sitting on top of bug class 2. The prospector — the thing
whose entire header comment says it exists because *"214 candidates sat untouched for eleven sessions"*
— reports the backlog as fully triaged and does nothing, forever, on every cron tick. The dashboard
shows `still_queued: 0`. `discover.mjs:378` reports `still_unscored: 0`. Every number says the work is
done and none of it has been started. The `stale` re-inspection at `discover.mjs:332`, whose comment
promises the list "self-heals whenever inspection gets smarter", will not re-inspect a single candidate
after the D2 fix lands.

**Severity: P1** (P0 in effect, but it is downstream of D2/D3 producing anything worth triaging).

**Fix — make "not yet triaged" an explicit, non-coercible state.** Do not use `undefined`; use a
`triaged_at` stamp that only a completed inspection sets:
```diff
--- a/discover.mjs
@@ -318,6 +318,7 @@
         callable_now: ins.callable_now || [],
+        triaged_at: ins.verified ? new Date().toISOString() : null,   // null = inspect() bailed early
         functions: ins.candidate_functions || [], verdict: ins.verdict || null,
@@ -332
-  const stale = Object.values(state.candidates).filter(c => c.callable_now === undefined && !c.tried);
+  const stale = Object.values(state.candidates)
+    .filter(c => !c.triaged_at && !c.tried)
+    .sort((a, b) => String(a.first_seen || '').localeCompare(String(b.first_seen || '')));  // "oldest first", as the comment claims
--- a/prospect.mjs
@@ -41
-  const unscored = pending.filter(c => c.callable_now === undefined);
+  const unscored = pending.filter(c => !c.triaged_at);
@@ -54
-  if (c.callable_now === undefined) {
+  if (!c.triaged_at) {
@@ -61,63
     c.callable_now = ins.callable_now || [];
+    c.triaged_at = new Date().toISOString();
@@ -135,139,160  (counters)
-    triaged: all.filter(x => x.callable_now !== undefined).length,
+    triaged: all.filter(x => x.triaged_at).length,
```
Note the sort added above: `discover.mjs:331` claims *"any candidate never scored for callability,
oldest first"* — there is no sort in the current code either, and `first_seen` is never recorded.
Both halves of that comment are false today.

---

## D5 — a failing payout check leaves no marker, so the prospector re-picks the same contract forever

**`prospect.mjs:76-88`**
```js
    try {
      const p = await payoutHistory(fetcher, { chain: c.chain, contract: c.contract, sample: 5 });
      c.payout_verdict = p.verdict;
      ...
    } catch (e) {
      out.stage = 'payout check failed';
      out.error = String(e.message).slice(0, 120);
    }
```
The catch writes nothing to `c`. `pickNext` (`:39-40`) selects `c.callable_now?.length && !c.payout_verdict`,
sorted by `payouts_seen` descending — a deterministic max. So a candidate whose explorer lookup fails
is re-selected on the very next tick, and every tick after.

**Proven by execution** (fetcher always throws):
```
B) tick 0 -> picked 0x…0009 | stage payout check failed | err explorer 503
B) tick 1 -> picked 0x…0009 | stage payout check failed | err explorer 503
B) tick 2 -> picked 0x…0009 | stage payout check failed | err explorer 503
B) tick 3 -> picked 0x…0009 | stage payout check failed | err explorer 503
```
The lower-ranked candidate `0x…0008` in the same state was never reached.

**Concrete failure:** one contract whose Blockscout page 500s (or one chain whose explorer is down)
head-of-line-blocks the entire prospector at 30 ticks/hour, indefinitely. Note `discover.mjs:346` gets
this right for its own loop (`catch { c.callable_now = []; /* mark attempted so it does not block the
queue forever */ }`) — the same author already knew the failure mode.

**Severity: P1** — the grind silently stops.

**Fix:**
```diff
     } catch (e) {
+      c.payout_fails = (c.payout_fails || 0) + 1;
+      c.payout_retry_after = Date.now() + Math.min(6 * 3600e3, 300e3 * 2 ** c.payout_fails); // backoff
       out.stage = 'payout check failed';
       out.error = String(e.message).slice(0, 120);
     }
```
and in `pickNext`:
```diff
-  const needsPayout = pending.filter(c => c.callable_now?.length && !c.payout_verdict);
+  const needsPayout = pending.filter(c => c.callable_now?.length && !c.payout_verdict
+    && !(c.payout_retry_after > Date.now()));
```

---

## D6 — `discoveryPass` and `prospectTick` run concurrently and both read-modify-write `discover:state`; one clobbers the other every 3rd tick

**`worker.mjs:1125`** `c.waitUntil( prospectTick(env, …) )`
**`worker.mjs:1140`** `c.waitUntil( discoveryPass(env, { chain: dChain, … }) )`

Two independent, un-awaited `waitUntil` promises in the same `scheduled()` invocation. Both do the same
unguarded read-modify-write on one KV key:

| | read | write |
|---|---|---|
| `discoveryPass` | `discover.mjs:276` | `discover.mjs:351` |
| `prospectTick` | `prospect.mjs:47` | `prospect.mjs:130` |

`discoveryPass` holds its in-memory copy across up to 4 keeper lookups + 48 `inspect()` calls, each of
which is several `fetch`es — many seconds. `prospectTick` is short. So the normal ordering is:
prospect reads → prospect writes verdicts → discovery writes its *stale* snapshot on top.

**Concrete failure:** every 6 minutes (`crons = ["*/2 * * * *"]`, `tickNo % 3 === 0` at
`worker.mjs:1137`), the last discovery write erases whatever the prospector learned during that pass —
`payout_verdict`, `settled_examples`, `retired`, `state.families`, and the `train:probes` linkage. The
reverse ordering loses newly discovered candidates. Cloudflare KV also has no read-after-write
guarantee across colos, so this can bite even without true concurrency.

**Severity: P1** — silently destroys triage work, which then looks like "the prospector isn't making
progress".

**Fix (minimal, no DO required): re-read and merge immediately before the write.**
```diff
--- a/discover.mjs
@@ -349,7 +349,12 @@
   state.passes += 1;
   state.lastPass = new Date().toISOString();
-  await env.KV.put('discover:state', JSON.stringify(state));
+  // prospectTick writes this same key concurrently (worker.mjs:1125 vs :1140). Re-read and merge, or
+  // a long discovery pass silently reverts every verdict the prospector recorded while it ran.
+  const fresh = (await env.KV.get('discover:state', 'json')) || {};
+  const merged = { ...fresh, ...state,
+    candidates: { ...state.candidates, ...(fresh.candidates || {}), ...Object.fromEntries(found.map(c => [`${c.chain}:${c.contract.toLowerCase()}`, c])) },
+    families: fresh.families || state.families };
+  await env.KV.put('discover:state', JSON.stringify(merged));
```
(Same shape on the `prospect.mjs:130` side — merge only the one candidate it touched plus `families`.)
The clean fix is to serialise them: `await prospectTick(...)` then `await discoveryPass(...)` inside one
`waitUntil`.

---

## D7 — the ranking that decides relay slots ignores `retired`; the prospector's eliminations are advisory only

**`prospect.mjs:81`**
```js
      if (p.verdict === VERDICT.ZERO) c.retired = true; // eliminated: never spend a slot here
```

**`discover.mjs:365-372`** — the ranked list returned to the agent:
```js
  const scored = Object.values(state.candidates)
    .filter(c => c.callable_now?.length || !c.access_controlled)
```
**`worker.mjs:532`** — `discover_list`, the tool the agent actually reads:
```js
      const scored = c.filter(x => (x.callable_now?.length || !x.access_controlled) && !x.tried)
```

Neither filters `retired`. A candidate the prospector *proved* pays zero still scores 1000+ (it is
`callable_now`, which is the top signal) and appears in `top` / `untried_promising`, described to the
model as *"Work DOWN this list… and only then a relay slot"*. `pickNext` (`prospect.mjs:38`) is the
only consumer that honours `retired`.

**Severity: P1** — this is a path from "we measured that it pays nothing" to spending one of five daily
relay slots on it. Also inverse: the elimination work compounds nowhere.

**Fix:**
```diff
--- a/discover.mjs:365
-  const scored = Object.values(state.candidates)
-    .filter(c => c.callable_now?.length || !c.access_controlled)
+  const scored = Object.values(state.candidates)
+    .filter(c => !c.retired && (c.callable_now?.length || !c.access_controlled))
--- a/worker.mjs:532
-      const scored = c.filter(x => (x.callable_now?.length || !x.access_controlled) && !x.tried)
+      const scored = c.filter(x => (x.callable_now?.length || !x.access_controlled) && !x.tried && !x.retired)
```

---

## D8 — the seed set is deterministic and truncated, so every pass walks the same 4 keepers forever

**`discover.mjs:277`**
```js
  let seeds = [...(SEED_KEEPERS[chain] || []), ...Object.keys(state.keepers).filter(k => state.keepers[k] === chain)];
```
**`discover.mjs:304`**
```js
  for (const keeper of seeds.slice(0, 4)) {
```

With D1 dead, `seeds` on arbitrum is always `[3 hardcoded SEED_KEEPERS, …state keepers in insertion
order]`. `slice(0, 4)` therefore always yields the same 3 seeds plus *the first state keeper ever
recorded*. Object key order for string keys is insertion order and is stable across `JSON.stringify` /
`JSON.parse`, so this set never changes. There is no cursor, no rotation, no "least recently walked"
marker, and no `visited` field on `state.keepers`.

Combined with `discover.mjs:310` (`if (state.candidates[key]) { …seen += 1; continue; }`), pass 2 and
every pass after re-derives the identical payer list, finds every entry already stored, and returns
`new_candidates: 0`. `bootstrapKeepers` collects up to 6 keepers into `state.keepers` (`:298`) and 5 of
them are never used.

**Severity: P1** — burns ~6 explorer subrequests per pass to learn nothing, and caps the candidate
universe at whatever the first pass found.

**Fix — round-robin with a persisted cursor:**
```diff
-  for (const keeper of seeds.slice(0, 4)) {
+  // Rotate: a fixed slice(0,4) over a stable key order walks the SAME keepers every pass forever and
+  // returns new_candidates:0 from pass 2 onward.
+  state.seedCursor = (state.seedCursor || 0);
+  const wheel = seeds.length ? Array.from({ length: Math.min(4, seeds.length) },
+    (_, i) => seeds[(state.seedCursor + i) % seeds.length]) : [];
+  state.seedCursor = (state.seedCursor + wheel.length) % Math.max(1, seeds.length);
+  for (const keeper of wheel) {
```

---

## D9 — `inspect()` returns before ever simulating whenever the source is missing, gating "the only thing that cannot lie" behind explorer verification

**`discover.mjs:167-171`** (the comment)
> *"An eth_call from our own address cannot lie… Free, unlimited, and the ONLY thing that should ever
> promote a candidate to 'worth a relay slot'."*

**`discover.mjs:136-139`** (the code)
```js
  try { meta = await j(`${base}/api/v2/smart-contracts/${target}`); }
  catch { return { contract, verified: false, verdict: 'source not verified — cannot confirm caller is unrestricted' }; }
  const src = meta.source_code || '';
  if (!src) return { contract, verified: false, verdict: 'no source' };
```
Both returns exit **before** the `simulateCandidate` loop at `:150`. The ABI is only ever taken from
Blockscout (`:140`), never from the bytecode — even though `bruteforce.mjs` in the same repo recovers a
full interface from bytecode alone.

**Measured on our own proven payers:**
```
{"label":"known payer 0xc664 (KNOWN_PAYERS.base[0])","hasSource":false,…}
{"label":"known payer 0x8B45 (KNOWN_PAYERS.base[1])","hasSource":false,…}
$ inspect('base','0x01F1A592…')  ->  { contract, verified:false, verdict:"no source" }
```
No `eth_call` was issued in any of those runs.

**Concrete failure:** for the entire clone universe (D2), `callable_now` is `[]` not because anything
reverted but because nothing was tried, and D4 then makes that indistinguishable from a real negative.
`verdict: "no source"` is also reported to the model as if it were a finding about the contract.

**Severity: P1** — the decisive test is skipped for the majority of real candidates.

**Fix — fall back to the dispatch table when there is no ABI:**
```diff
+import { extractSelectors } from './bruteforce.mjs';
+// 4-byte → signature for the maintenance shapes we can safely encode. Anything else stays unprobed.
+// selectors verified with ethers.id(), 2026-07-31 — do not copy these from memory
+const KNOWN_SIGS = { '0x4641257d': 'harvest()', '0x0e5c011e': 'harvest(address)', '0x322e9f04': 'work()',
+  '0x4585e33b': 'performUpkeep(bytes)', '0x440368a3': 'tend()', '0x18178358': 'poke()',
+  '0x2606a10b': 'report()' };
@@
-  try { meta = await j(`${base}/api/v2/smart-contracts/${target}`); }
-  catch { return { contract, verified: false, verdict: 'source not verified …' }; }
-  const src = meta.source_code || '';
-  if (!src) return { contract, verified: false, verdict: 'no source' };
-  const abi = meta.abi || [];
+  try { meta = await j(`${base}/api/v2/smart-contracts/${target}`); } catch { meta = null; }
+  const src = meta?.source_code || '';
+  let abi = meta?.abi || [];
+  if (!abi.length) {
+    // No verified ABI (100% of EIP-1167 clones). The bytecode dispatch table cannot hide, and an
+    // eth_call is still free — never return without at least trying the decisive test.
+    const code = await rawCall(RPCS[chain], 'eth_getCode', [target, 'latest']);
+    abi = extractSelectors(code || '0x').filter(s => KNOWN_SIGS[s]).map(s => {
+      const sig = KNOWN_SIGS[s], name = sig.slice(0, sig.indexOf('('));
+      const types = sig.slice(sig.indexOf('(') + 1, -1).split(',').filter(Boolean);
+      return { type: 'function', name, stateMutability: 'nonpayable', inputs: types.map(t => ({ type: t, name: '' })) };
+    });
+  }
```
(The rest of `inspect` already handles an empty `src` — `GATE_RE.test('')` is `false`, which is honest:
"we did not read a gate", and D7's ranking no longer treats that as a promotion.)

---

## D10 — `hits.slice(0, 8)` re-measures the first 8 hits in bytecode order, not the 8 largest

**`bruteforce.mjs:116`**
```js
  for (const hit of hits.slice(0, 8)) {
```
`hits` is appended in `variants` order (`:86-89`), which is `extractSelectors` order, which is byte
offset order in the runtime — arbitrary with respect to payout size. The sort happens at `:130`,
**after** the truncation, on the survivors only.

**Honest measurement: this did not fire on the family I tested.** All 4 clone strategies produced
exactly 1 screened hit per token, so nothing was lost. It is a latent bug, not an observed loss. It
becomes real on any contract with >8 screened hits — and the 89–92-selector impls unlocked by D2 are
exactly where that will happen, since D2 raises the probe count from 0 to ~178 per contract.

**Severity: P1** (hides income once D2 lands; P3 today).

**Fix:**
```diff
-  for (const hit of hits.slice(0, 8)) {
+  // Rank BEFORE truncating — `hits` is in bytecode order, so slicing first drops the biggest payer
+  // whenever it sits past index 8.
+  const ranked = [...hits].sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : BigInt(b.wei) < BigInt(a.wei) ? -1 : 0));
+  for (const hit of ranked.slice(0, 8)) {
```

---

## D11 — one token is measured; the verdict claims the contract pays nothing at all

**`bruteforce.mjs:74`** `export async function bruteforceContract(rpc, chain, contract, token, …)`
**`bruteforce.mjs:141`**
```js
      : 'no function on this contract pays an arbitrary caller right now',
```
The screen only ever reads `balanceOf(MULTICALL3)` on the single `token` argument (`:94, :97, :118, :120`).
Callers pass one hardcoded default per chain — `worker.mjs:620` and `shop.mjs:477` both default to WETH
(`0x4200…0006` on OP-stack chains). There is no native-ETH leg either, although Multicall3 exposes
`getEthBalance(address)` and it would cost one extra call per batch.

**Measured** on the 4 clone strategies, same probe, three tokens:

| token | screened hits |
|---|---|
| WETH | 1 on each of 4 |
| USDC | 0 on all 4 |
| AERO | 0 on all 4 |

WETH happened to be the right guess for this family. Any strategy whose `callFee` is paid in USDC, AERO,
OP, or native ETH is reported with the sentence above — a flat claim about "an arbitrary caller",
measured against one ERC-20. That verdict then feeds `sweep()` (`:152`, only pushes when `hits.length`)
and the model's decision to drop the contract.

**Severity: P1** — a measuring instrument whose null result is stated far more broadly than what it
measured.

**Fix — take a basket, and say what you measured:**
```diff
-export async function bruteforceContract(rpc, chain, contract, token, { argShapes = true, batch = 25 } = {}) {
+export async function bruteforceContract(rpc, chain, contract, token, { argShapes = true, batch = 25, tokens = null } = {}) {
+  const basket = tokens && tokens.length ? tokens : [token];
```
…measure each basket entry in its own pass (or interleave `balanceOf` reads for all of them around each
call), and change the null verdict to name the scope:
```diff
-      : 'no function on this contract pays an arbitrary caller right now',
+      : `no function paid MULTICALL3 in [${basket.join(', ')}] at head — NOT a claim about other tokens or native ETH`,
```

---

# P2 findings

## D12 — `payouts_seen` is frozen at first sighting while `seen` counts something meaningless

**`discover.mjs:310`**
```js
      if (state.candidates[key]) { state.candidates[key].seen += 1; continue; }
```
`payersOf` returns a fresh, live `p.n` (payout count) and `p.tokens` every pass, and they are thrown
away for every already-known candidate. `seen` — which counts how many times *discovery re-walked the
same keeper*, i.e. a constant of the loop, per D8 — increments instead. The ranking at `:369` uses
`(c.payouts_seen || 0) * 10`, so a contract that has paid 400 times since discovery still ranks as
whatever it had on day one, and a contract that has stopped paying entirely keeps its old score.
**Severity: P2.**
```diff
-      if (state.candidates[key]) { state.candidates[key].seen += 1; continue; }
+      if (state.candidates[key]) {
+        const ex = state.candidates[key];
+        ex.seen += 1; ex.payouts_seen = p.n; ex.tokens = p.tokens; ex.last = p.last;  // live, not frozen
+        continue;
+      }
```

## D13 — elimination is permanent with no expiry, and `NO_EVIDENCE` freezes a candidate in limbo

**`prospect.mjs:81`** `if (p.verdict === VERDICT.ZERO) c.retired = true;` — no timestamp, no re-check.
A strategy with nothing accrued right now pays zero; the same strategy an hour later pays. `PAYS_ZERO`
is a statement about a sample of recent history (`payouts.mjs:123`), not a property of the contract.

Worse, `NO_EVIDENCE` — documented at `payouts.mjs:50` as *"unknown, treat as unproven"* — is written to
`c.payout_verdict` at `prospect.mjs:78` all the same. That makes `!c.payout_verdict` false forever, so
`pickNext` never re-selects it, yet `retired` is false so it stays in every "promising" list and every
`total`. It is neither eliminated nor queued. **Severity: P2.**
```diff
-      c.payout_verdict = p.verdict;
+      // NO_EVIDENCE is "we did not see anything", not a property of the contract — re-check later.
+      if (p.verdict === VERDICT.NONE) { c.payout_retry_after = Date.now() + 24 * 3600e3; }
+      else { c.payout_verdict = p.verdict; }
       c.checked_at = new Date().toISOString();
-      if (p.verdict === VERDICT.ZERO) c.retired = true; // eliminated: never spend a slot here
+      if (p.verdict === VERDICT.ZERO) { c.retired = true; c.retired_at = Date.now(); } // re-open after 30d
```
and in `pickNext`: `const pending = Object.values(candidates).filter(c => !c.retired || Date.now() - c.retired_at > 30*86400e3);`

## D14 — `NOISE_NAME` discards `…Pool` and `…Vault` payers before they are ever recorded

**`discover.mjs:36`**
```js
const NOISE_NAME = /Pool$|Pair$|Router|Swap|Quoter|Vault$|WETH|Token$|ERC20|Bridge|Multicall/i;
```
**`discover.mjs:308`** `if (isNoise(p.name)) continue;` — `continue` before the `state.candidates[key]`
write, so a rejected payer leaves **no record at all**: it is silently re-fetched and re-rejected every
pass, and never appears in any count.

**Honest measurement: this does NOT currently fire on the Beefy family**, because Blockscout returns
`name: null` for unverified clones and `isNoise(null)` is `false` (`:37`). But the implementation behind
`0x11dd6940…`, `0xde0b7820…` **and both of our own `KNOWN_PAYERS.base`** is named **`StrategyRewardPool`**
— it matches `Pool$`. The moment a non-clone instance of that shape appears as a payer, or Blockscout
starts labelling proxies by implementation name, the engine will silently discard the exact family it
earns from. `Vault$` has the same problem for every ERC-4626 that pays a claim caller.
**Severity: P2 (latent, one label-change away from P0).**
```diff
-const NOISE_NAME = /Pool$|Pair$|Router|Swap|Quoter|Vault$|WETH|Token$|ERC20|Bridge|Multicall/i;
+// Deliberately does NOT include /Pool$/ or /Vault$/: `StrategyRewardPool` is the implementation behind
+// our own KNOWN_PAYERS, and ERC-4626 vaults pay claim callers. Match the DEX plumbing only.
+const NOISE_NAME = /Pair$|Router|Quoter|^WETH|Multicall|SwapRouter|Bridge$/i;
```
…and record the rejection instead of dropping it silently:
```diff
-      if (isNoise(p.name)) continue;
+      if (isNoise(p.name)) { (state.noise ||= {})[key] = p.name; continue; }
```

## D15 — the maintenance-name regex has no `work` / `performUpkeep` / `tend` / `report`

**`discover.mjs:142`**
```js
  const CANDIDATE = /harvest|claim|settle|finish|start|poke|update|compound|rebalance|liquidat|distribute|checkpoint|sync|execute|trigger|process|finalize/i;
```
Missing the canonical entry points of two entire keeper ecosystems: Keep3r/Yearn `work()` and `tend()`,
Chainlink Automation `performUpkeep(bytes)` / `checkUpkeep(bytes)`, and the common `report()`, `kick()`,
`refill()`, `ping()`, `run()`. These are precisely the "mechanism classes we do not already know" that
`discover.mjs:46-51` says the engine exists to find. Measured: on the Beefy family this costs nothing
(`harvest` matches, rank 0), so it is a blind spot rather than an active loss today.
**Severity: P2.**
```diff
-  const CANDIDATE = /harvest|claim|settle|finish|start|poke|update|compound|rebalance|liquidat|distribute|checkpoint|sync|execute|trigger|process|finalize/i;
+  const CANDIDATE = /harvest|claim|settle|finish|start|poke|update|compound|rebalance|liquidat|distribute|checkpoint|sync|execute|trigger|process|finalize|^work$|^tend$|upkeep|^report$|^kick$|^ping$|^run$|refill|sweep|skim|redeem/i;
```
Note `simulateCandidate` will still reject `performUpkeep(bytes)` at `:231`/`:238` ("takes arguments we
cannot safely guess" → "could not encode"). That is a *loud* negative, which is fine; today it is a
silent one.

## D16 — `implOf` does not fall through when the beacon lookup fails; no diamond or slot-0 proxy support

**`bruteforce.mjs:64-66`**
```js
    const b = word(await rpc(chain, 'eth_getStorageAt', [c, BEACON_SLOT, 'latest']).catch(() => null));
    if (b) return word(await rpc(chain, 'eth_call', [{ to: b, data: '0x5c60da1b' }, 'latest']).catch(() => null));
    return word(await rpc(chain, 'eth_call', [{ to: c, data: '0x5c60da1b' }, 'latest']).catch(() => null));
```
If the beacon slot is set but the beacon's `implementation()` reverts (some beacons use
`childImplementation()` — `discover.mjs:181` knows this, `bruteforce.mjs` does not), the function
returns `null` and never tries line 66. `resolveImpl` in `discover.mjs:213-218` gets this right. Also
neither resolver handles EIP-2535 diamonds (selectors live in storage, not in the dispatch table — those
return "no dispatch table found") or slot-0 singleton proxies (GnosisSafeProxy). **Severity: P2.**
```diff
-    if (b) return word(await rpc(chain, 'eth_call', [{ to: b, data: '0x5c60da1b' }, 'latest']).catch(() => null));
-    return word(await rpc(chain, 'eth_call', [{ to: c, data: '0x5c60da1b' }, 'latest']).catch(() => null));
+    for (const [to, sel] of [[b, '0x5c60da1b'], [b, '0xda525716'], [c, '0x5c60da1b']]) {
+      if (!to) continue;
+      const a2 = word(await rpc(chain, 'eth_call', [{ to, data: sel }, 'latest']).catch(() => null));
+      if (a2) return a2;
+    }
+    return null;
```

## D17 — `bootstrapKeepers`'s comment promises an EOA filter that does not exist

**`discover.mjs:264-265`**
```js
      // EOAs receiving repeated fee payments are exactly what a keeper bot looks like
      keepers[to] = (keepers[to] || 0) + 1;
```
Nothing checks `it.to.is_contract`, although `payersOf` checks the mirror field at `:110`. A treasury,
a fee splitter, or a router that receives ≥2 transfers is returned as a "keeper" and then walked by
`payersOf`, whose payer list is by construction garbage. **Severity: P2.**
```diff
       const to = it.to?.hash;
       if (!to || to.toLowerCase() === c.toLowerCase()) continue;
+      if (it.to?.is_contract === true) continue;   // a fee splitter is not a keeper
```

## D18 — `state.keepers` keys are not case-normalised, so the same keeper is stored twice

`blindSeed` returns `rc.from` (lowercase, from `eth_getBlockReceipts`); `bootstrapKeepers` returns
`it.to.hash` (checksummed, from Blockscout); `SEED_KEEPERS` is checksummed. All three land in the same
`state.keepers` map (`:288`, `:298`) and `:277` reads the keys straight back out. The dedupe at `:287`
(`blind.filter(a => !state.keepers[a])`) misses across casings. `state.candidates` *is* normalised
(`:309` lowercases), so this is the only key-casing gap. **Severity: P2 (wasted subrequests, duplicate
seeds).** Fix: `.toLowerCase()` on every write and read of `state.keepers`.

---

# P3 findings

- **`prospect.mjs:27`** — `.replace(/(Strategy|Vault|Pool|Gauge)$/i, '$1')` replaces the match with
  itself. It is a no-op. The comment says "with trailing specifics stripped". Either delete the line or
  make it `.replace(/(Strategy|Vault|Pool|Gauge)\w*$/i, '$1')`.
- **`prospect.mjs:23-28`** — `familyOf(null) === 'unknown'`, and per D2/D9 `c.name` is null for the
  entire clone universe. So `families_by_evidence` (`prospect.mjs:173`), sold as "the pattern layer
  [that] generalises", will be dominated by one `unknown` bucket with a computed `pay_rate`. Suggest
  excluding `unknown` from `families_by_evidence` rather than reporting a rate for it.
- **`bruteforce.mjs:48`** — `if (/^0x0{4,}/.test(s)) continue;` discards any selector beginning
  `0x0000`, which is what gas-golfed keeper functions deliberately mine for. **Measured: 0 of the 228
  selectors across the three impls I recovered were affected**, so this is latent, not an observed loss.
  Tighten to `/^0x0{8}$/` (only the true all-zero padding).
- **`bruteforce.mjs:130` and `:156`** — `(BigInt(b.wei) > BigInt(a.wei) ? 1 : -1)` never returns 0, so
  it is not a valid comparator; equal elements order inconsistently. Use the 3-way form given in D10.
- **`prospect.mjs:18`** — `resolveImpl` is imported and never used.
- **`bruteforce.mjs:26-28`** — `aggregate3` is declared `view`; the real Multicall3 function is
  `payable`. Harmless here (encode/decode only, always via `eth_call`), noted so nobody "fixes" it and
  assumes behaviour changed.
- **`discover.mjs:230-231`** — `types.length > 1` bails, and `/address/.test(types[0])` also matches
  `address[]`, which then throws in `encodeFunctionData` and is reported as "could not encode". Cosmetic:
  the negative is loud, not silent. Prefer `types[0] === 'address'`.

---

# Verified NOT broken — do not re-check these

Each of these looked like a bug from the outside and is correct. Checked so the next session does not
spend a round on them.

1. **`bruteforce.mjs:106` balance-delta indexing.** `before = rows[k*2]`, `call = rows[1+k*2]`,
   `after = rows[2+k*2]` — correct interleaving for the `[bal, fn, bal, fn, bal…]` layout built at
   `:94-98`. `k=0` reads the seed balance at `rows[0]`; each subsequent `before` is the previous
   `after`. No off-by-one.
2. **`bruteforce.mjs:96` probes the PROXY, not the implementation.** Correct — a clone/proxy
   `DELEGATECALL`s, so calling the impl directly would read the impl's (empty) storage. Only the
   *selector recovery* needs the implementation; the *calls* must go to the proxy, and they do.
   `discover.mjs:151` does the same thing correctly (`simulateCandidate(chain, contract, …)`, not
   `target`).
3. **`bruteforce.mjs` measuring `balanceOf(MULTICALL3)`.** Inside `aggregate3`, `msg.sender` for each
   sub-call *is* Multicall3, so measuring Multicall3's balance is the right instrument for "does this
   pay whoever called it". Verified the clone is not a permissive fallback proxy:
   `eth_call 0xdeadbeef → execution reverted`.
4. **`payouts.mjs` verdict strings match `prospect.mjs:31`'s `VERDICT` constants exactly**
   (`PAYS_CALLERS` / `PAYS_ZERO` / `NO_EVIDENCE`, `payouts.mjs:47,115,123`). No casing or naming drift —
   `p.verdict === VERDICT.ZERO` really does fire.
5. **`state.candidates` key casing is consistent.** Written `${chain}:${contract.toLowerCase()}`
   (`discover.mjs:309`), read the same way (`:310`). `prospect.mjs` addresses candidates only through
   `Object.values`, never by key. (`state.keepers` is the one that is inconsistent — see D18.)
6. **`prospect.mjs` mutates live references.** `Object.values(state.candidates)` returns the same
   objects, so the `c.*` writes at `:57-64` / `:78-81` are persisted by the `KV.put` at `:130`. Correct.
   (Whether that put survives is D6, a different bug.)
7. **The cron rotation arithmetic at `worker.mjs:1136-1139` is correct.** `crons = ["*/2 * * * *"]` and
   `Math.floor(scheduledTime / 120000)` means `tickNo` increments by exactly 1 per tick, so
   `tickNo % 3 === 0` fires every 6 minutes and `Math.floor(tickNo/3) % 6` advances one chain each time.
   All six chains get equal turns. No skipping.
8. **`payersOf` pagination and sorting** (`discover.mjs:103-122`) are correct, and `payers.slice(0, maxPayers)`
   at `:307` slices **after** the `sort((a,b) => b.n - a.n)` at `:122`. Not a truncate-before-rank.
   Likewise `scored.slice(0, 8)` at `:384` and `sweep`'s `found.sort` at `:156` both rank first.
9. **`discover.mjs:150` `fns.slice(0, 6)`** truncates candidate functions before simulating, in ABI
   order. Looked like a truncate-before-rank; **measured and it does not fire on this family**: all
   three Beefy strategy impls expose exactly 3 CANDIDATE-matching functions and `harvest(address)` — the
   one I proved pays — is at ABI rank **0**. Leaving it as a note rather than a finding.
10. **`discover.mjs:366`'s `!c.access_controlled`** does not discard callable contracts: `access_controlled`
    is `null` for anything unverified, `!null === true`. And the `callable_now?.length ||` short-circuit
    means a simulating contract is never excluded for matching `GATE_RE`. Confirmed `GATE_RE` matches
    all three verified Beefy impls (`access_controlled_regex: true`) — the comment at `:362-364` is
    accurate and the code honours it.
11. **`bruteforce.mjs:80` unions proxy and implementation selectors** — correct, and it is what makes
    the D2 fix a one-line change rather than a restructure.

---

## Reproduction

All probes are read-only (`eth_call`, `eth_getCode`, `eth_getBlockReceipts`, Blockscout GETs) and live in
the session scratchpad, not in the repo:
`…/scratchpad/probe1.mjs` (clone tally, 40 vaults) · `probe4.mjs` (post-fix selector recovery + 3-token
basket) · `probe5.mjs` (241-vault/241-strategy universe tally) · `dp_lane_probe6.mjs` (D4 + D5, pure
in-memory KV, no network) · `dp_lane_probe7.mjs` (ABI/regex/slice measurement) · `dp_lane_probe8.mjs`
(Blockscout `implementations` field). Note the scratchpad is shared with other agents this session and
`probe2/3/5.mjs` were overwritten by another lane after I ran them; the outputs quoted above are verbatim
from my runs.
