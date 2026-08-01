# RESEARCH — two money-losing bugs in ZERO's own tooling

Read-only audit. **No ZERO source file was modified.** All fixes below are proposals only.
Companion to `contracts/RESEARCH-onchain.md`. Date: 2026-07-31, Base head ≈ 49,376,111.

---

## ⚠️ FIRST: a correction to my own previous memo

`RESEARCH-onchain.md` priced everything at **ETH = $3,000, which I explicitly flagged as UNVERIFIED. It was wrong.** Measured this session from two independent sources:

- `https://api.beefy.finance/prices` → `ETH = 1861.96547515`
- `https://api.coinbase.com/v2/prices/ETH-USD/spot` → `1861.075`

**Every USD figure in `RESEARCH-onchain.md` is overstated by 1.611×.** The WETH figures there are correct — only the USD column is wrong. Corrected economics:

| | RESEARCH-onchain.md (ETH=$3000) | **corrected (ETH=$1,861.97)** |
|---|---|---|
| total instantaneous pool | $0.1725 | **$0.10705** |
| best single strategy | $0.02442 | **$0.01516** (`aerodrome-usdc-mai`) |
| mean payer | $0.00083 | **$0.00051** |
| median payer | $0.00007 | **$0.00004** |
| top-26 batch | $0.1439 | **$0.08929** (83.4 % of pool, **5.9× best-single**) |

The batching multiple (5.9×) is unchanged — it is a ratio, so the price error cancels. **`RESEARCH-onchain.md` still contains the wrong USD column; I did not edit it because this task scoped me to one file. It should be corrected.**

---

# ROOT CAUSE 1 — the scan path and the run path look at DIFFERENT CHAINS

**`harvest_scan` is Base-only. `harvest_run` excludes Base.** They examine disjoint chain sets, which is the entire reported symptom.

### The scan side — Base and nothing else
`worker.mjs:452`
```js
      const strategies = await loadStrategies(ctx.env, (c, m, p) => ctx.rpc(c, m, p));
```
The third parameter is omitted, so it takes the default in `harvest.mjs:142`:
```js
export async function loadStrategies(env, rpc, chainName = 'base') {
```
**`harvest_scan` therefore only ever reports Base candidates.**

### The run side — every chain EXCEPT Base
`worker.mjs:479-481`
```js
      const hs = (await ctx.env.KV.get('harvest:state', 'json')) || {};
      const chains = ['optimism', 'arbitrum', 'polygon', 'unichain', 'gnosis'];
      if (hs.escaped) chains.unshift('base');
```
Base is **absent from the literal** and is only prepended when `hs.escaped` is truthy. `escaped` is set in exactly two places, both inside the WETH→ETH escape (`harvest.mjs:419`, `harvest.mjs:468`). **Until the escape completes, `harvest_run()` cannot touch Base at all** — the one chain `harvest_scan` just reported 11 callable payers on.

That is the bug, in two lines, in one file.

### The scheduled path already has it right — which is why this went unnoticed
`worker.mjs:1077-1078`
```js
      for (const chain of ['base', 'optimism', 'arbitrum', 'polygon', 'unichain', 'gnosis']) {
        if (chain === 'base' && escapeNeedsBase) { console.log('batch: base reserved for the escape'); continue; }
```
Base **is** first here, and the guard is a different, narrower flag (`worker.mjs:1056`):
```js
        escapeNeedsBase = !!(esc && (esc.ready || esc.relayed) && esc.step !== 'done');
```
So the cron harvests Base normally while the manual tool refuses to. **Two chain lists and two different escape flags for the same decision** — `escapeNeedsBase` ("escape is mid-flight, reserve Base") vs `hs.escaped` ("escape has finished"). They are near-opposites, and the manual path got the wrong one.

### Minimal fix — make `harvest_run` delegate to the same list the cron uses
```diff
--- a/worker.mjs
+++ b/worker.mjs
@@ -479,3 +479,3 @@
-      const hs = (await ctx.env.KV.get('harvest:state', 'json')) || {};
-      const chains = ['optimism', 'arbitrum', 'polygon', 'unichain', 'gnosis'];
-      if (hs.escaped) chains.unshift('base');
+      // Base is where 241 of our strategies live and is the only chain harvest_scan reports on.
+      // It is reserved ONLY while the escape is mid-flight — never because the escape is unfinished.
+      const esc = (await ctx.env.KV.get('escape:state', 'json')) || {};
+      const chains = ['base', 'optimism', 'arbitrum', 'polygon', 'unichain', 'gnosis'];
```
plus, inside the loop, the same skip the cron uses. **UNVERIFIED:** the exact KV key for the escape state — the cron derives `escapeNeedsBase` from a live `escapeCycle()` return value (`worker.mjs:1052-1056`), not from KV. The safe fix is to call `escapeCycle()` the same way, or simply reuse `escapeNeedsBase`. Do not copy `hs.escaped`.

---

## The journal's "missing Aerodrome COW vaults" diagnosis is FALSE — do not inherit it

`knowledge/journal.md` claims *"The harvester appears to only look for Beefy Finance strategies, missing Aerodrome COW vaults entirely."* **Measured against `_beefy_base.json`, the same feed `loadStrategies()` fetches (`https://api.beefy.finance/vaults`, `harvest.mjs:146`):**

```
active base vaults in the Beefy API dump : 241
ids matching /^aero(drome)?-cow/           : 134
entries carrying a .strategy field         : 241  (100%)
platformId tally: aerodrome 208, pancakeswap 15, morpho 7, curve 6, stakedao 3, aave 1
```

**Aerodrome COW vaults ARE Beefy vaults**, they are 134 of 241 ids, Aerodrome is 208/241 (86 %) of the platform tally, and every one has the `.strategy` field `loadStrategies` filters on. The harvester's universe is *overwhelmingly* Aerodrome. There is no Aerodrome blind spot. **The journal invented a plausible-sounding cause for a symptom whose real cause was the chain list. That entry should be struck** — it is exactly the kind of unverified inherited claim that sends the next session down a dead end.

---

## Three further scanner defects found while verifying (all real, all measured)

### (a) `harvest_scan` only ever looks at the first 80 of 241 strategies — the single largest loss here
`worker.mjs:454`
```js
      const ranked = await rankByCallReward((c, m, p) => ctx.rpc(c, m, p), strategies.slice(0, 80));
```
The slice is applied **before** ranking, so it is not "the top 80" — it is the first 80 in Beefy API order, which is arbitrary. **Measured against my full 241-strategy payout sweep:**

```
payers inside the first 80          : 72 of 208
value visible to harvest_scan       : 43.8% of the total pool
```
**6 of the 10 highest real payers are invisible to the scanner**, including `aerodrome-cbbtc-edge` (index 162), `aero-cow-eurc-cbbtc-vault` (194), `aerodrome-weth-lrds` (175), `aerodrome-cow-base-cbbtc-usdc-vault` (116), `aerodrome-usdc-aero` (174), `aero-cow-weth-usdc-vault` (147).

**Fix:** drop the slice. `rankByCallReward` already batches 40 per `aggregate3` (`harvest.mjs:158`), so all 241 cost ~6 subrequests, not 241 — the slice was never buying what it was meant to buy.
```diff
-      const ranked = await rankByCallReward((c, m, p) => ctx.rpc(c, m, p), strategies.slice(0, 80));
+      const ranked = await rankByCallReward((c, m, p) => ctx.rpc(c, m, p), strategies);
```

### (b) `rankByCallReward` silently drops payers whose `callReward()` reads 0
`harvest.mjs:170`
```js
        if (v > 0n) out.push({ ...batch[k], callReward: v.toString() });
```
**Measured:** of the 25 Base strategies with `callReward() == 0`, **3 actually pay right now** — total 0.000000262687502294 WETH = **$0.00049** (0.5 % of the pool). Small, but it is a *silent* discard of proven-paying targets:

| id | strategy | measured fee |
|---|---|---|
| `morpho-base-steakhouse-prime-eurc` | `0x97F0609d2d1fAdeD374FDACDf5fDf912fF0f656a` | 0.000000222960880039 WETH |
| `morpho-v2-base-gauntlet-balanced-weth` | `0x07421Db65caE0df71c5c173AdAB37282098eB6ef` | 0.000000039269003035 WETH |
| `morpho-v2-base-clearstar-reactor-usdc` | `0x8839494227ff33fCb3a4f2338C7826Fbc396634a` | 0.00000000045761922 WETH |

These are Morpho strategies — a different implementation family whose `callReward()` reads 0 while `_chargeFees` still pays. **Do not filter on a getter that has already been proven to lie.**

### (c) `rankByCallReward` is hardcoded to Base — latent, will bite on the multi-chain path
`harvest.mjs:161`
```js
      const ret = await rpc(HARVEST_CFG.chain, 'eth_call', [{ to: HARVEST_CFG.multicall, data }, 'latest']);
```
`HARVEST_CFG.chain` is the constant `'base'` (`harvest.mjs:35`). The function takes no chain parameter. If it is ever called with strategies from another chain it will `eth_call` those addresses **on Base**, where they are almost certainly not contracts, and return an empty list — reading as "nothing pays here". Today it is only called with Base data (`worker.mjs:454`), so this is latent, not live. **Fix:** thread a `chainName` parameter through, defaulting to `'base'`.

### Not a bug — I checked and it is fine
- **Cooldown key casing.** `harvestCycle` reads `state.cooldowns[s.strategy]` (checksummed, from `ethers.getAddress` at `harvest.mjs:150`); `batchHarvest` writes `state.cooldowns[g.contract]` (`harvest.mjs:556`) where `g.contract` is `slice[k]` from `probeMany` (`oracle.mjs:170`), which is passed `strategies.map(s => s.strategy)` — also checksummed. **Keys match.** No silent cooldown miss.
- **`simulate()` vs real payout.** I tested `simulate()`'s exact logic (`harvest.mjs:184-199`) against measured balance deltas on 12 strategies: it said callable on 2, and exactly those 2 paid. The theoretical "succeeds but pays zero" path (`if (native.balanceOf(this) > 0)`) did not occur once in 216 sweeps. `simulate()` is an honest gate.

---

# ROOT CAUSE 2 — `callReward()` is denominated in the REWARD TOKEN, never converted to native

## Where it feeds decisions: only ONE place, and it is not the money path

I grepped every `callReward` reference in the repo. **The good news is large: `callReward()` does not influence a single relay slot.** Both spending paths measure real payouts via `probeMany` (`oracle.mjs:147`), which simulates the settlement and takes a balance delta.

| site | file:line | role | corrupted by 4,481×? |
|---|---|---|---|
| `rankByCallReward` sort | `harvest.mjs:174` `out.sort((a,b) => BigInt(b.callReward) > BigInt(a.callReward) ? 1 : -1)` | orders `harvest_scan` output | **YES — cross-family mis-ranking** |
| `rankByCallReward` filter | `harvest.mjs:170` `if (v > 0n)` | drops candidates | **YES — see (b) above** |
| `harvest_scan` display | `worker.mjs:458` `callReward_wei: c.callReward` | **the number the agent reads** | **YES — inflated 4,481×** |
| `harvestCycle` selection | `harvest.mjs:604-618` `probeMany(...)` | picks the strategy for a slot | **NO — measured delta** |
| `batchHarvest` selection | `harvest.mjs:498` `probeMany(...)` | picks the batch | **NO — measured delta** |
| earnings ledger | `harvest.mjs:648`, `harvest.mjs:538` `wethBalance` before/after | logged USD | **NO — real balance delta** |

**So the 4,481× does not steal money directly. It corrupts the agent's own worldview** — `harvest_scan` is described to the model as *"YOUR BREAD AND BUTTER"* (`worker.mjs:639`) and hands it a `callReward_wei` field inflated ~4,481×. The existing mitigation at `worker.mjs:462` (*"callReward is a RANKING signal only"*) is a prose warning attached to a number that is still wrong by three and a half orders of magnitude.

**The ranking itself is also wrong across reward-token families** (see the formula below): sorting AERO-denominated against CAKE-denominated values mis-orders them by the ratio of the two token prices, ~3.5×. Confirmed in my sweep — `pancakeswap-cow-base-sol-cbbtc` ranked **#14 by `callReward()` but #7 by measured payout**.

## WHY — derived from verified source, then proven numerically

`0x68Ecddba8D4CfCa13923fC8d66f2678BF17aB4e1` (`StrategyRewardPool`, verified) lines 304-313:
```solidity
    /// @notice Unclaimed reward amount from the underlying platform
    function rewardsAvailable() public view returns (uint256 unclaimedReward) {
        unclaimedReward = IRewardPool(rewardPool).earned(address(this), rewards[0]);
    }

    /// @notice Estimated call fee reward for calling harvest
    /// @return callFee Amount of native reward a harvest caller could claim
    function callReward() public view returns (uint256 callFee) {
        IFeeConfig.FeeCategory memory fees = getFees();
        callFee = rewardsAvailable() * fees.total / DIVISOR * fees.call / DIVISOR;
    }
```
versus what actually pays, line 190-197:
```solidity
    function _harvest(address _callFeeRecipient) internal whenNotPaused {
        IRewardPool(rewardPool).getReward();
        _swapToNative();                                    // <-- REWARD TOKEN -> WETH
        if (IERC20Metadata(native).balanceOf(address(this)) > 0) {
            ...
    function _chargeFees(address _callFeeRecipient) internal {
        uint256 nativeBal = IERC20Metadata(native).balanceOf(address(this)) * fees.total / DIVISOR;
        uint256 callFeeAmount = nativeBal * fees.call / DIVISOR;
        IERC20Metadata(native).safeTransfer(_callFeeRecipient, callFeeAmount);
```

**`rewardsAvailable()` is `earned(..., rewards[0])` — units of the REWARD token (AERO, Cake). `callReward()` applies the fee fractions to that and returns it directly.** `_chargeFees` applies the *same* fractions to the **WETH balance after `_swapToNative()`**. The docstring "Amount of native reward" is simply false: the swap never happens in the view function. **It is not a fee-split error, not a projection, and not a period estimate — it is a missing unit conversion.**

### Numerical proof — two different reward tokens, two different ratios, both explained
The fee fractions cancel out exactly, confirming the only remaining difference is price:

| strategy | `rewards[0]` | `callReward/rewardsAvailable` | measured overstatement | token price | **implied ETH** | measured ETH |
|---|---|---|---|---|---|---|
| `aero-cow-eurc-cbbtc` `0x9D15Bae4…` | AERO `0x940181a9…` | `1.0000e-4` | **4,478.4×** | $0.41642 | **$1,865** | $1,861.97 |
| `pancakeswap-cow-sol-cbbtc` `0xafF4f20E…` | Cake `0x3055913c…` | `1.0000e-4` | **1,284.2×** | $1.45743 | **$1,872** | $1,861.97 |

Both recover the true ETH price to within **0.5 %**. `1.0000e-4` is exactly `fees.total × fees.call` = `0.095 × 0.00105263`. **The hypothesis is confirmed: overstatement factor = price(rewards[0]) ÷ price(native).** It is not a fixed 4,481× — the team lead's 4,481× is the AERO number specifically, and it drifts with the AERO/ETH price.

### The correct formula
Exact, from source:
```
callerFee_native = balanceOf(native, strategy) AFTER _swapToNative()  ×  fees.total/1e18  ×  fees.call/1e18
```
**This is not derivable from any view function**, because it depends on realised swap output through `IBeefySwapper(unirouter)`. Two usable substitutes:

1. **Corrected estimate (cheap, good to ~1 %):**
   ```
   callerFee_native ≈ callReward() × price(rewards[0]) / price(native)
   ```
   Both prices are one free call to `https://api.beefy.finance/prices`, already used elsewhere. **This makes `callReward()` comparable across families and off by only the swap slippage.**
2. **Exact (what ZERO already does, and should keep doing):** `probeMany` / `probePayout` in `oracle.mjs` — simulate `harvest(address)` inside a Multicall3 balance-delta sandwich. This is the ground truth and it costs nothing.

### Minimal fix — stop showing the agent a number that is wrong by 3.5 orders of magnitude
The cheapest correct change is to make `harvest_scan` report the **measured** fee it already has the machinery to compute, rather than the getter:
```diff
--- a/worker.mjs
+++ b/worker.mjs
@@ -453,10 +453,12 @@
-      const ranked = await rankByCallReward((c, m, p) => ctx.rpc(c, m, p), strategies.slice(0, 80));
+      // callReward() is denominated in the REWARD token and is NOT converted to native — it overstates
+      // by price(rewards[0])/price(native): ~4,478x on AERO, ~1,284x on Cake. Never rank on it and
+      // never show it. probeMany simulates the settlement and returns the real wei. Same cost.
+      const ranked = await probeMany((c, m, p) => ctx.rpc(c, m, p), 'base',
+                                     strategies.map(s => s.strategy), HARVEST_CFG.weth);
       const top = [];
       for (const c of ranked.slice(0, Math.min(Number(limit) || 10, 15))) {
-        top.push({ id: c.id, strategy: c.strategy, callReward_wei: c.callReward, callable: sim.ok });
+        top.push({ id: c.id, strategy: c.contract, measured_fee_wei: c.wei, callable: sim.ok });
```
This deletes defects (a), (b), (c) and the 4,481× display in one edit, because `probeMany` has no chain hardcode, no `callReward > 0` filter, and already prices the whole 241-strategy universe in ~10 requests (`oracle.mjs:141`). `rankByCallReward` would then have **no remaining callers** and can be deleted.

---

## What I could NOT verify

1. **Live KV state.** I never read `harvest:state`, so I cannot say whether `hs.escaped` is currently true or false, i.e. whether `harvest_run()` is skipping Base *right now*. The code path is proven; its current activation state is not. Reading `GET /harvest` or `KV.get('harvest:state')` on the deployed Worker would settle it in one call.
2. **That the journal's "11 callable strategies" run was `harvest_run` and not `harvestCycle`.** The journal's other quoted string, *"no fresh strategy"*, is verbatim from `harvest.mjs:597` — which is `harvestCycle`, a **third** path reachable only via the HTTP debug route `worker.mjs:1315`, not from the cron and not from `harvest_run`. **The journal conflates at least two code paths**, so my Root Cause 1 explains the `harvest_run` symptom exactly but I cannot prove it is the one the journal observed. If `harvestCycle` was the path, its chain walk (`harvest.mjs:598`) *does* include Base and the cause would instead be the cooldown filter at `harvest.mjs:591-595` — which I could not test without live `state.cooldowns`.
3. **Revert selector `0xb317087b`** (from `0xA7cf5A6844fbd128C6b301d6B5acF46629407D66`) remains unresolved against every error signature in the four fetched Beefy sources.
4. **Cooldown exhaustion arithmetic.** `batchHarvest` cools up to `max` (12) strategies per relayed batch (`harvest.mjs:556`) and `cooldownMs` is 6 h (`harvest.mjs:42`). Whether that can starve the 241-strategy Base set depends on the real relay-slot refill rate, which `relayResetSummary` says is measured in KV — I did not read it. **Plausible, unproven.**
5. **`nativeUsd` has no `unichain` entry** (`harvest.mjs:253-259`), so a Unichain harvest logs `earned_usd: 0`. Noted from code; no Unichain harvest observed to confirm.
6. All payout figures are a **single-block snapshot**. `isCalm()` flips between blocks (see `RESEARCH-onchain.md` §2c), so the exact per-strategy numbers move; the ratios and the structural findings do not.
