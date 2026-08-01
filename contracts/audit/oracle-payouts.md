# ZERO audit — lane `oracle-payouts`
**Modules:** `oracle.mjs` (200 lines), `payouts.mjs` (128), `sweep.mjs` (151)
**Excluded by brief:** `probeMany`'s shared-state contamination (filed as #140). Everything else in `probeMany` is in scope.
**Date:** 2026-07-31 · **Method:** read + live `eth_call` / Blockscout v2 against Base, Optimism, Arbitrum mainnet. Every number below was measured tonight, none recalled.

**Score: 18 findings — 7×P1, 7×P2, 4×P3, 0×P0.** No finding breaks the running harvest loop; the P1s blind the discovery instrument, overstate what a contract will pay us, and strand or risk swept value.

---

## Standing facts measured for this audit (reusable)

| thing | measured value |
|---|---|
| Safe | `0x510601f59FDa068D70ad6760c9d9085B0F42cbb1` |
| EOA | `0x50624F7790732f9767180871D03A304756200dB9` |
| lifetime earned (live `/harvest`) | `$0.0289863` |
| spendable | `$0.01403679` = arbitrum `$0.01114537` + polygon `$0.00289142` |
| base safe WETH / optimism safe WETH | `0` / `0` |
| optimism safe **USDC** | **299 units** ← stranded, see F3 |
| base safe USDC | `9,780` units |
| live Base Beefy strategies | 238 active |

---

# P1 — hides income / risks a scarce slot

## F1 — `resolveImpl` is blind to EIP-1167 minimal proxies, so `probeContract` reports "no money-shaped function" for **88.3% of the Base strategy universe**
**`oracle.mjs:69-82`** (`resolveImpl`), consumed by `oracle.mjs:84-96` (`selectorsPresent`) and `oracle.mjs:181-200` (`probeContract`).

```js
export async function resolveImpl(rpc, chain, contract) {
  try {
    for (const s of [IMPL_SLOT, LEGACY_SLOT]) { ... }        // EIP-1967 storage slots
    const beacon = addrWord(await rpc(chain, 'eth_getStorageAt', [contract, BEACON_SLOT, ...
    return addrWord(await rpc(chain, 'eth_call', [{ to: contract, data: '0x5c60da1b' }, ...
```

**Why it is wrong.** All four probes assume the implementation address lives in *storage* or behind an `implementation()` getter. An EIP-1167 minimal proxy stores it in **runtime code** — `363d3d373d3d3d363d73<impl>5af43d82803e903d91602b57fd5bf3`, 45 bytes, no storage, no getter, no beacon. Every branch returns `null`.

This is the *third* recurrence of the trap the comment at `oracle.mjs:56-60` claims to have closed forever:

> *"three Beefy strategies we have really been paid by all read as 'no money-shaped function' … That is the third time today this exact trap has fired, so the resolution lives inside the primitive now and cannot be forgotten at a call site."*

The resolution was written for **BeaconProxy** only. The clone shape — the majority shape — was never handled. Class #2 verbatim: the comment is right about the danger and the code does not implement the claim.

**Measured failure.** Same contract, same token, same block. `0x11dD6940AeA57aAC6aC4D204E13161BB6E5Bf0A8` (the contract the brief cites):

```
--- probeContract WITHOUT impl (what worker.mjs payout_oracle actually does) ---
{ "contract":"0x11dD6940…","exposed":0,"paying":[],
  "verdict":"no money-shaped function in its bytecode" }

--- probeContract WITH the EIP-1167 impl supplied ---
{ "exposed":2, "callable_now":["harvest()","harvest(address)"],
  "paying":[{"sig":"harvest(address)","paid":"0.000000046165896263"}],
  "verdict":"PAYS AN ARBITRARY CALLER RIGHT NOW: harvest(address) → 0.000000046165896263" }
```
`resolveImpl()` → `null`. Its real implementation is `0x68ecddba8d4cfca13923fc8d66f2678bf17ab4e1`, sitting in plain sight in the 45 bytes of runtime code.

**Population (sampled 60 of 238 live Base Beefy strategies, `eth_getCode` each):**
```
EIP-1167 clones = 53   resolveImpl BLIND on them = 53   resolveImpl resolved = 7
=> 88.3% of the sampled Base strategy universe reads as "no money-shaped function"
```
Optimism is the same shape (`0x01087C3419…` → clone → `resolveImpl` null → 0 selectors; with the impl, `harvest()` + `harvest(address)`).

**Concrete consequence.** (a) The payout oracle — the instrument for finding *undiscovered* routes — is blind to ~88% of the exact contract class ZERO already earns from; a genuine new payer scanned this way is filed as a non-payer. (b) `shop.mjs:458` sells `probeContract` output through the paid `/api/contract-audit` x402 endpoint, so a paying customer auditing any clone gets a confidently wrong answer. (c) `worker.mjs:589` `payout_oracle` feeds this into the agent's reasoning as fact.
The running harvest loop is **not** affected — `harvest.mjs:526/649` use `probeMany`, which calls the proxy directly and never needs impl resolution. That is why this has stayed invisible.

**Fix** (non-anchored so it also catches clones with prepended bytes):
```diff
--- a/oracle.mjs
+++ b/oracle.mjs
@@
 const addrWord = (v) => {
   if (!v || v.length < 42) return null;
   const a = '0x' + v.slice(-40);
   return /^0x0+$/.test(a) ? null : a;
 };
+// EIP-1167 minimal proxy keeps the implementation in RUNTIME CODE, not in any storage slot and not
+// behind implementation() — so every slot probe below reads zero and every getter reverts. MEASURED
+// 2026-07-31: 53 of 60 live Base Beefy strategies are 1167 clones, i.e. 88.3% of the universe was
+// answering "no money-shaped function in its bytecode" while exposing harvest()+harvest(address).
+// The BeaconProxy fix above was written for a different proxy shape and never covered this one.
+const EIP1167 = /363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/;
 export async function resolveImpl(rpc, chain, contract) {
   try {
+    const code = await rpc(chain, 'eth_getCode', [contract, 'latest']).catch(() => '0x');
+    const clone = String(code).toLowerCase().match(EIP1167);
+    if (clone) return '0x' + clone[1];
     for (const s of [IMPL_SLOT, LEGACY_SLOT]) {
```

---

## F2 — `payoutHistory` counts value paid to **hardcoded protocol recipients** as a caller payout, contradicting its own header comment. Measured overstatement: **899x**
**`payouts.mjs:100-110`**, comment at **`payouts.mjs:18-20`**.

The comment states the law:
> *"Value moving to another CONTRACT is ignored: that is protocol plumbing, not a caller fee."*

The code implements no such check:
```js
const senders = new Set(moves.map(m => m.from));
for (const m of moves) {
  if (m.from !== C) continue;             // value must leave the contract under test
  if (!m.to || m.to === C) continue;      // self-transfers are not payouts
  if (senders.has(m.to)) continue;        // round-trip hop → plumbing
  paid.push({ ..., beneficiary: m.to === caller ? 'caller' : 'named-recipient', ... });
}
```
The only plumbing test is *"did this address also send in this tx"*. An address that **only receives** — which is exactly what a fee sink does — is waved through and labelled `named-recipient`, a label the header defines as *"a fee recipient the caller named"*. Nothing named it. It is immutable state on the contract.

**Proven live.** `payoutHistory(base, 0x11dD6940…, sample 6)` → `PAYS_CALLERS`, and its `settled_payouts` list, with each recipient's code checked by `eth_getCode`:

```
payout -> 0x03d9964f4D93a24B58c0Fc3a8Df3474b59Ba8557 [EOA]      beneficiary="caller"           0.00000089 WETH
payout -> 0xdad00eCa971D7B22e0dE1B874fbae30471B75354 [EOA]      beneficiary="named-recipient"  0.00004476 WETH
payout -> 0x02Ae4716B9D5d48Db1445814b0eDE39f5c28264B [CONTRACT] beneficiary="named-recipient"  0.00080478 WETH
```
Those two "named recipients" are hardcoded getters on the strategy — verified by `eth_call`:
```
strategist()        -> 0xdad00eCa971D7B22e0dE1B874fbae30471B75354
beefyFeeRecipient() -> 0x02Ae4716B9D5d48Db1445814b0eDE39f5c28264B
```
Blockscout even hands us the answer inline: `to.is_contract = true`, `to.name = "ERC1967Proxy"` on `0x02Ae47…`.

**Why it matters.** The function's own closing note says:
> *"Size your expectation on THESE numbers, never on a getter."*

Doing that on this output overstates what an arbitrary caller receives by **899x** (0.00080478 / 0.00000089) on the contract measured, and 50x for the strategist line. This is `callReward()`'s 4,481x lie reproduced *inside the function written to kill it* — class #3, the measuring instrument lying. Same shape on every strategy tested (`0x8B45D51e…` 0.00841763 vs 0.00000936 caller = 899x; `0x16d722a0…` 0.00195139 vs 0.00000217 = 899x).

**Downstream.** `prospect.mjs:79` `c.settled_examples = (p.settled_payouts || []).slice(0, 2)` takes the first two entries — measured, that captures the fee-batcher figure — and `prospect.mjs:110-125` writes it into `train:probes` labelled **GROUND TRUTH**. The lie is being compounded into a corpus.

**Fix** — use the field Blockscout already returns, and never let a non-caller line set the headline:
```diff
--- a/payouts.mjs
+++ b/payouts.mjs
@@ token-transfers loop
-        moves.push({ from: lc(x.from?.hash), to: lc(x.to?.hash), toRaw: x.to?.hash, amount: fmt(...), token: ... });
+        moves.push({ from: lc(x.from?.hash), to: lc(x.to?.hash), toRaw: x.to?.hash,
+          toIsContract: !!x.to?.is_contract, toName: x.to?.name || null,
+          amount: fmt(x.total?.value, x.total?.decimals), token: x.token?.symbol || 'ERC20' });
@@ internal-transactions loop
-        moves.push({ from: lc(x.from?.hash), to: lc(x.to?.hash), toRaw: x.to?.hash, amount: fmt(x.value, 18), token: 'native' });
+        moves.push({ from: lc(x.from?.hash), to: lc(x.to?.hash), toRaw: x.to?.hash,
+          toIsContract: !!x.to?.is_contract, toName: x.to?.name || null,
+          amount: fmt(x.value, 18), token: 'native' });
@@ classification
   for (const m of moves) {
     if (m.from !== C) continue;
     if (!m.to || m.to === C) continue;
+    if (m.to === '0x0000000000000000000000000000000000000000') continue;   // a burn is not a payout
     if (senders.has(m.to)) continue;
+    // THE HEADER COMMENT'S LAW, NOW ACTUALLY ENFORCED. A contract that only receives is a fee sink
+    // (measured: beefyFeeRecipient() took 899x the caller fee and was labelled "named-recipient",
+    // i.e. "a fee recipient the caller named" — nothing named it, it is immutable state).
+    if (m.toIsContract) continue;
     paid.push({ ... });
   }
+  // Only the line the CALLER received is money we could ever have. A hardcoded strategist EOA is
+  // not obtainable either, so it is reported but never used to size an expectation.
+  const toCaller = paid.filter(p => p.beneficiary === 'caller');
@@ PAYS_CALLERS return
       settled_payouts: paid.slice(0, 8),
+      caller_obtainable: toCaller.slice(0, 8),
+      size_expectation_on: toCaller.length ? toCaller[0].amount + ' ' + toCaller[0].token
+        : 'NOTHING — no line in this history went to the address that made the call. Every amount '
+          + 'above went to a recipient hardcoded in the contract. DO NOT size a slot on them.',
```
and `prospect.mjs:79` should read `caller_obtainable`, not `settled_payouts`.

---

## F3 — `sweepCycle` permanently strands the slippage buffer of every sweep. **299 USDC units are stranded on Optimism right now**
**`sweep.mjs:120, 126, 129`**, comment at **`sweep.mjs:50`**.

```js
slippage: 0.97,   // amountOutMinimum = spot * this; burn amount = the same (residue re-sweeps)
...
const outMin = BigInt(Math.floor(Number(bal) / 1e18 * price * SWEEP_RAIL.slippage * 1e6));
...
[cfg.usdc, I('function approve(address,uint256)').encodeFunctionData('approve', [SWEEP_RAIL.tokenMessenger, outMin])],
[SWEEP_RAIL.tokenMessenger, ... .encodeFunctionData('depositForBurn', [outMin, SWEEP_RAIL.baseDomain, ...])],
```

**Why it is wrong.** `outMin` is the *floor* on the swap output. The swap delivers whatever the pool gives, which is more. The burn leg then reuses `outMin` — the floor — as the **exact** amount, so `actualOut − outMin` stays behind. The comment asserts "residue re-sweeps"; nothing in the file can re-sweep it. `sweepCycle` triggers only on `wethBalance` (`sweep.mjs:116`) and never reads a USDC balance on a source chain; the next cycle's `outMin` is derived from the new WETH amount, so the residue is never included. It is unreachable by any code path in the repo.

**Proven on-chain.** The one sweep that has executed, OP tx `0x6839a5fbd1d972aa75923980baf7382a9a7a810c940645e0d2ff30bfa8c09c1e` (2026-07-31T02:24:43Z):
```
WETH  5,295,623,959,499  safe            -> 0x1fb3cf6e48… (pool)
USDC             10,079  0x1fb3cf6e48…   -> safe            <- what the swap actually returned
USDC              9,780  safe            -> 0xfd78EE9196… (TokenMessenger, burned)
```
`10,079 − 9,780 = 299` units left behind = **2.967%**, i.e. exactly `1 − slippage`. Live `balanceOf` on Optimism USDC right now: **`299n`**. It has sat there since, and always will.

At the current sweep size that is $0.0003, but it is 3% of *every* consolidation forever, and $0.0003 against a lifetime of $0.029 is 1% of everything ZERO has ever earned.

**Fix** — the Safe's pre-existing USDC balance is knowable before the batch is built, and adding it is provably safe because the balance at execution time is `usdcBefore + actualOut ≥ usdcBefore + outMin`:
```diff
--- a/sweep.mjs
+++ b/sweep.mjs
@@
       const outMin = BigInt(Math.floor(Number(bal) / 1e18 * price * SWEEP_RAIL.slippage * 1e6));
       if (outMin <= 0n) continue;
+      // Sweep the RESIDUE of every previous cycle too. amountOutMinimum is a FLOOR, but the burn leg
+      // used to reuse it as the exact amount, so (actualOut - outMin) was left behind with no code
+      // path able to reach it — measured 299 units stranded on Optimism from the 2026-07-31 sweep
+      // (pool returned 10,079, burn took 9,780). Safe because the balance at execution time is
+      // usdcBefore + actualOut >= usdcBefore + outMin, so this can never over-draw.
+      let usdcBefore = 0n;
+      try { usdcBefore = await wethBalance(rpc, safe, chain, cfg.usdc); } catch { /* treat as 0 */ }
+      const burnAmt = outMin + usdcBefore;
       const legs = [
         [weth, I('function approve(address,uint256)').encodeFunctionData('approve', [cfg.router, bal])],
         [cfg.router, ... [[weth, cfg.usdc, cfg.poolFee, safe, bal, outMin, 0]])],
-        [cfg.usdc, I('function approve(address,uint256)').encodeFunctionData('approve', [SWEEP_RAIL.tokenMessenger, outMin])],
+        [cfg.usdc, I('function approve(address,uint256)').encodeFunctionData('approve', [SWEEP_RAIL.tokenMessenger, burnAmt])],
         [SWEEP_RAIL.tokenMessenger, I('function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)')
-          .encodeFunctionData('depositForBurn', [outMin, SWEEP_RAIL.baseDomain, ...])],
+          .encodeFunctionData('depositForBurn', [burnAmt, SWEEP_RAIL.baseDomain, ...])],
       ];
@@
-        const p = { chain, taskId: sent.taskId, tx: null, usd: +usd.toFixed(6), burn_units: outMin.toString(), ... };
+        const p = { chain, taskId: sent.taskId, tx: null, usd: +usd.toFixed(6), burn_units: burnAmt.toString(), ... };
```
(`wethBalance` is already imported and is a generic `balanceOf` despite the name — see F16.)

---

## F4 — the CCTP mint is recorded as `minted: true` on **HTTP 201 from the relay**, and the pending record is deleted. A failed mint burns the USDC with no retry path
**`sweep.mjs:95-101`**

```js
const sent = await relayExec(env, rpc, safe, SWEEP_RAIL.messageTransmitter, data, 'base', 8453, 0);
if (sent.ok) {
  state.done.unshift({ ...p, minted: true, mintTaskId: sent.taskId, at: new Date().toISOString() });
  state.done = state.done.slice(0, 20);
  state.pending.shift();
  out.minted = true;
} else out.mint_error = sent.error;
```

**Why it is wrong.** `relayExec` (`harvest.mjs:239-246`) returns `{ok:true, taskId}` for `res.status === 201` — *the relay accepted the task*. Nothing has executed. Class #1 exactly: no exception is being read as "it worked". The record is then written as `minted: true` and `pending.shift()` **destroys the only copy of the burn's tx hash and source domain**.

**Concrete failure.** The relay task reverts, is cancelled, or is dropped (Safe's relayer does all three). `state.pending` is already empty, so the next tick's LEG B has nothing to retry and LEG A proceeds to the next burn. The USDC is destroyed on Optimism and never minted on Base. CCTP attestations do not expire, so the value is theoretically recoverable — but only by a human reading the chain, because no code in the repo retains the message. At today's sizes that is the *entire* swept balance of a cycle.

Note the contrast with `sweep.mjs:91`, which correctly `eth_call`-simulates `receiveMessage` before spending the slot — the pre-flight is right, the post-flight is missing.

**Fix** — keep the record until the mint is confirmed on-chain:
```diff
-            if (sent.ok) {
-              state.done.unshift({ ...p, minted: true, mintTaskId: sent.taskId, at: new Date().toISOString() });
-              state.done = state.done.slice(0, 20);
-              state.pending.shift();
-              out.minted = true;
-            } else out.mint_error = sent.error;
+            if (sent.ok) {
+              // 201 means the RELAY ACCEPTED THE TASK, not that anything executed. Keep the pending
+              // record (it holds the burn tx hash and source domain — the only way to re-derive the
+              // attestation) until receiveMessage is seen on-chain. Dropping it here destroys the
+              // only retry path for USDC that has already been burned on the source chain.
+              p.mintTaskId = sent.taskId;
+              p.mintSentAt = Date.now();
+              out.mint_submitted = sent.taskId;
+            } else out.mint_error = sent.error;
+          } else if (p.mintTaskId) {
+            // Already submitted on a previous tick: confirm, or fall through and re-submit next tick.
+            const st = await relayStatus(p.mintTaskId, 8453).catch(() => ({}));
+            if (st.tx) {
+              const rc = await rpc('base', 'eth_getTransactionReceipt', [st.tx]).catch(() => null);
+              if (rc && BigInt(rc.status) === 1n) {
+                state.done.unshift({ ...p, minted: true, mintTx: st.tx, at: new Date().toISOString() });
+                state.done = state.done.slice(0, 20);
+                state.pending.shift();
+                out.minted = st.tx;
+              } else if (rc) { p.mintTaskId = null; out.mint_reverted = st.tx; }  // retry next tick
+            }
```
(the `m` branch above needs restructuring so the confirm path runs before the submit path; the point of the diff is the invariant: **nothing leaves `pending` without a status-1 receipt.**)

---

## F5 — one failed burn relay task deadlocks the sweep rail permanently. `relayStatus.status` is fetched and never read
**`sweep.mjs:81-83`** and **`sweep.mjs:111`**

```js
if (!p.tx && p.taskId) {
  try { const st = await relayStatus(p.taskId, CHAINS[p.chain].chainId); if (st.tx) p.tx = st.tx; } catch { /* next tick */ }
}
...
// ── LEG A: burn on a ready tributary. One in-flight burn at a time keeps this auditable.
if (state.pending.length) return out;
```

**Why it is wrong.** Three compounding gaps:
1. `relayStatus` returns `{status, tx}` (`harvest.mjs:249-256`). `status` is **never inspected anywhere in sweep.mjs**. A task in `ExecReverted` / `Cancelled` is indistinguishable from one still pending.
2. `relayStatus`'s own `catch { return {status:null, tx:null} }` makes a network blip indistinguishable from a dead task.
3. There is **no timeout, no attempt counter, and no expiry** on a `pending` entry. `sweep.mjs:111` then hard-blocks LEG A on `pending.length`.

**Concrete failure.** A burn task fails and never produces a tx hash. Every subsequent tick re-polls `relayStatus`, gets `tx: null`, does nothing, and returns at line 111. The consolidation rail is dead forever, and the only symptom is `{"pending": 1}` in a `console.log` nobody reads. The file's own opening paragraph is about exactly this class of silent stall (*"Optimism sat at 147% of its sweep threshold with nothing moving"*).

**Fix:**
```diff
     const p = state.pending[0];
+    p.polls = (p.polls || 0) + 1;
     if (!p.tx && p.taskId) {
-      try { const st = await relayStatus(p.taskId, CHAINS[p.chain].chainId); if (st.tx) p.tx = st.tx; } catch { /* next tick */ }
+      try {
+        const st = await relayStatus(p.taskId, CHAINS[p.chain].chainId);
+        if (st.tx) p.tx = st.tx;
+        p.lastStatus = st.status;
+        // A dead task must not hold the rail hostage. relayStatus reports the terminal states and
+        // we were throwing that field away, so a reverted burn looked exactly like a slow one.
+        if (/revert|cancel|fail/i.test(String(st.status || ''))) p.dead = true;
+      } catch { /* next tick */ }
     }
+    // No tx hash after ~2h of polling (cron is */2min) means the burn never landed. Retire the
+    // record so LEG A is not blocked forever; keep it in done[] flagged so it is auditable.
+    if (p.dead || (!p.tx && p.polls > 60)) {
+      state.done.unshift({ ...p, abandoned: true, reason: p.dead ? 'relay task ' + p.lastStatus : 'no tx hash after 60 polls', at: new Date().toISOString() });
+      state.done = state.done.slice(0, 20);
+      state.pending.shift();
+      out.abandoned = p.taskId;
+      await env.KV.put('sweep:state', JSON.stringify(state));
+      return out;
+    }
```

---

## F6 — 100% of ZERO's spendable value sits on chains `SWEEP_RAIL.sources` has no entry for; the one configured source is empty
**`sweep.mjs:41-48`**

```js
sources: {
  optimism: { domain: 2, usdc: '0x0b2C…', router: '0x68b3…', poolFee: 500 },
},
```

**Measured tonight:**
| chain | safe wrapped-native | USD | in `sources`? |
|---|---|---|---|
| arbitrum | 5,978,472,554,961 WETH | **$0.01114537** | ✗ |
| polygon | 40,561,401,695,793,559 WPOL | **$0.00289142** | ✗ |
| base (home) | 0 | $0 | n/a (destination) |
| optimism | **0** | $0 | ✓ (only entry) |

`$0.01114537 + $0.00289142 = $0.01403679` = **exactly** the `spendable_usd` the live `/harvest` endpoint reports. Every dollar ZERO can spend is on a chain the consolidation rail cannot reach, and the single chain it *can* reach has been drained to zero. Arbitrum alone is 2.2x `minSweepUsd`.

This is not a code defect — the header comment honestly says *"add a chain only after its router+pool+USDC are VERIFIED the same way"* — it is an **unfinished config that has become the binding constraint**. Both chains are CCTP-native (arbitrum domain 3, polygon domain 7). Filing at P1 because it is the difference between the rail working and the rail being decorative.

**Fix** — verify then add (addresses below are the well-known ones and **must be bytecode-verified before use**, per the file's own standard; I did not verify them and am not asserting them):
```diff
   sources: {
     optimism: { domain: 2, usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', poolFee: 500 },
+    // UNVERIFIED PLACEHOLDERS — do not enable until router+pool+USDC are bytecode-verified on-chain
+    // exactly as optimism's were. Measured 2026-07-31: arbitrum holds $0.01115 and polygon $0.00289,
+    // together 100% of spendable_usd, and neither has a path home.
+    // arbitrum: { domain: 3, usdc: '0x…', router: '0x…', poolFee: 500 },
+    // polygon:  { domain: 7, usdc: '0x…', router: '0x…', poolFee: 500 },   // note: WPOL, not WETH
   },
```
Polygon additionally needs a WPOL→USDC pool, not WETH→USDC — `sweep.mjs:113` reads `CHAINS[chain].weth`, which on polygon is WMATIC/WPOL. The swap tuple is token-agnostic so this works, but the `weth` variable name will mislead the next reader.

---

## F7 — `probePayout` cannot distinguish "measured zero" from "the measurement itself failed"
**`oracle.mjs:126-134`**

```js
let before = 0n, after = 0n;
try { before = BigInt(rows[0].returnData); after = BigInt(rows[2].returnData); } catch { /* keep zeros */ }
const delta = after - before;
return { sig, ok: true, callable: true, paid_wei: delta.toString(), paid: ethers.formatEther(delta), pays: delta > 0n };
```

**Why it is wrong.** `rows[1].success` is checked (line 124) but `rows[0].success` and `rows[2].success` never are, and `returnData` is never validated. Both balance legs carry `allowFailure: true`.

**Proven live.** A `CALL` to an address with no code **succeeds** and returns empty — confirmed against Base Multicall3:
```
0x4200…0006 (WETH)  -> success=true returnData="0x000…000"
0x0000…DeaDBeef     -> success=true returnData="0x"
```
`BigInt('0x')` throws, the catch keeps both at `0n`, and the function returns a confident measurement:
```
probePayout(base, 0x11dD6940…, 'harvest(address)', 0x…DeaDBeef)
  -> {"sig":"harvest(address)","ok":true,"callable":true,"paid_wei":"0","paid":"0.0","pays":false}
```
Byte-identical to a genuine zero. `probeContract` then emits `"callable but pays zero at this moment (state-dependent — worth re-probing)"` — a sentence describing the contract, about a failure of our own instrument.

There is a second shape: if `rows[0]` decodes and `rows[2]` throws, `before` is assigned and `after` stays `0n`, producing a **negative** `paid_wei` string (e.g. `"-46165896263"`) that no caller expects.

**Fix:**
```diff
-  let before = 0n, after = 0n;
-  try { before = BigInt(rows[0].returnData); after = BigInt(rows[2].returnData); } catch { /* keep zeros */ }
-  const delta = after - before;
+  // A CALL to a codeless address SUCCEEDS and returns "0x" (verified on Base Multicall3), and
+  // BigInt('0x') throws — so the old catch turned a BROKEN MEASUREMENT into an indistinguishable
+  // "pays zero". An instrument must never report a number it did not read.
+  const word = (r) => (r?.success && typeof r.returnData === 'string' && r.returnData.length >= 66)
+    ? BigInt(r.returnData.slice(0, 66)) : null;
+  const before = word(rows[0]), after = word(rows[2]);
+  if (before === null || after === null) {
+    return { sig, ok: false, reason: `balance probe failed — "${token}" did not return a uint256 (wrong token address, or not an ERC-20 on this chain)` };
+  }
+  const delta = after - before;
```

---

# P2 — correctness, no direct money loss

## F8 — the oracle measures ONE token, but its verdict strings claim a general result, and native ETH is invisible
**`oracle.mjs:102` / `oracle.mjs:184, 195-198`**

`probePayout(rpc, chain, contract, sig, token)` measures the delta in exactly one ERC-20. `probeContract` then returns:
```js
verdict: paying.length ? `PAYS AN ARBITRARY CALLER RIGHT NOW: …`
  : callable.length ? 'callable but pays zero at this moment (state-dependent — worth re-probing)'
    : 'every money-shaped function reverts for an arbitrary caller',
```
Neither the middle nor the top verdict mentions the token. The honest statement is *"pays zero **in WETH**"*. A contract paying its caller in USDC, OP, ARB, a governance token, or **native ETH** is filed as a non-payer. Native is the worst case: `balOf()` (`oracle.mjs:50`) is `balanceOf(address)`; Multicall3's own ETH balance is never read even though `Multicall3.getEthBalance(address)` (`0x4d2301cc`) exists in the same contract already being called. Measured: `MC WETH bal = 0`, `MC native = 0`, so the baseline is clean and the extra leg is free.

The file header (`oracle.mjs:12-17`) promises *"it simulates the settlement itself … that is the only way to price a mechanism before anyone has proven it"* — the mechanism is priced in one denomination out of all of them.

```diff
+// Also read Multicall3's NATIVE balance: getEthBalance lives on the same contract we are already
+// calling, so it costs no extra request, and a function that pays its caller in ETH is currently
+// invisible to this oracle. Zero in one ERC-20 is not zero.
+const ethBalOf = (addr) => '0x4d2301cc' + addr.slice(2).toLowerCase().padStart(64, '0');
   const calls = [
     { target: token, allowFailure: true, callData: balOf(MULTICALL3) },
+    { target: MULTICALL3, allowFailure: true, callData: ethBalOf(MULTICALL3) },
     { target: contract, allowFailure: true, callData },
     { target: token, allowFailure: true, callData: balOf(MULTICALL3) },
+    { target: MULTICALL3, allowFailure: true, callData: ethBalOf(MULTICALL3) },
   ];
```
and both verdicts must name the token: `` `callable but pays zero IN ${token} and zero native at this moment` ``.

---

## F9 — `probeMany` silently discards an entire 30-contract batch on any RPC failure
**`oracle.mjs:160-164`**

```js
try {
  const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
  [rows] = AGG.decodeFunctionResult('aggregate3', ret);
} catch { continue; }
```
`per = 30` means 61 sub-calls per `aggregate3`, well past the gas ceiling of several public nodes. One overrun and 30 contracts vanish from the result with no counter, no field, and no distinction from "none of these 30 pay". `harvest.mjs:162-166` documents this exact hazard for its own batcher (*"a batch that overruns is swallowed by the catch below and disappears silently, so do not raise it without measuring the chain you raise it on"*) — `oracle.mjs` has neither the note nor the counter, and its callers (`harvest.mjs:526`, `harvest.mjs:649`) treat the array as complete.

```diff
 export async function probeMany(rpc, chain, contracts, token, sig = 'harvest(address)', per = 30) {
   const out = [];
+  const skipped = [];
   ...
-    } catch { continue; }
+    } catch (e) { skipped.push({ from: i, n: slice.length, err: String(e.message).slice(0, 80) }); continue; }
   ...
-  return out.sort(...);
+  const ranked = out.sort(...);
+  // A dropped batch is NOT "these contracts do not pay" — say so out loud rather than returning a
+  // short list that reads as complete.
+  if (skipped.length) ranked.skipped = skipped;
+  return ranked;
 }
```

---

## F10 — `payouts.mjs fmt()` treats a 0-decimal token as 18 decimals
**`payouts.mjs:33-41`**

```js
const d = BigInt(10) ** BigInt(Number(dec) || 18);
```
`Number(0) || 18` → `18`. Proven:
```
fmt("5000", 0)   = "0"      <-- should be "5000"
fmt("5000", "0") = "0"
fmt("5000", 6)   = "0.005"  (correct)
```
A 0-decimal ERC-20 payout is under-reported by 10^18 and reads as zero — the same units bug that logged a WPOL fee as $0.20 (`harvest.mjs:270-275`), inverted. `fmt(undefined, 18)` also returns the string `"undefined"`, which happens live: the `AERO-CL-POS` transfers in Base tx `0xdf73ace0bab3f8f0…` are ERC-721 and carry `total: {token_id}` with no `value`.

```diff
-const fmt = (raw, dec) => {
+const fmt = (raw, dec) => {
+  // Number(0) || 18 === 18 — a 0-decimal token was being divided by 1e18 and read as zero. Use a
+  // null check, not falsiness, and refuse to invent a number when there is no value (ERC-721 items
+  // carry total:{token_id} and no total.value).
+  if (raw === undefined || raw === null) return null;
+  const D = (dec === undefined || dec === null || dec === '') ? 18 : Number(dec);
   try {
-    const d = BigInt(10) ** BigInt(Number(dec) || 18);
+    if (!Number.isInteger(D) || D < 0 || D > 36) return null;
+    const d = BigInt(10) ** BigInt(D);
     const v = BigInt(raw);
     const whole = v / d;
-    const frac = (v % d).toString().padStart(Number(dec) || 18, '0').slice(0, 8).replace(/0+$/, '');
+    const frac = D === 0 ? '' : (v % d).toString().padStart(D, '0').slice(0, 8).replace(/0+$/, '');
     return frac ? `${whole}.${frac}` : `${whole}`;
-  } catch { return String(raw); }
+  } catch { return null; }
 };
```
(and skip moves whose `amount` is `null` rather than pushing `"undefined"` into `settled_payouts`).

---

## F11 — a price-feed failure is reported as "accumulating", indistinguishable from a genuinely small balance
**`sweep.mjs:117-118`**

```js
const price = await nativeUsd(chain);
const usd = Number(bal) / 1e18 * (price || 0);
if (usd < SWEEP_RAIL.minSweepUsd) { out[chain] = `accumulating ($${usd.toFixed(6)})`; continue; }
```
`nativeUsd` (`harvest.mjs:283-290`) returns `0` for an unknown chain, a fetch failure, a non-200, or an unparseable body — four different conditions, one indistinguishable value. With `price = 0`, `usd = 0` unconditionally and the rail reports `accumulating ($0.000000)` **no matter how much WETH is sitting there**. The rail would stay silently frozen for as long as Blockscout's `/api/v2/stats` is unhappy, reporting a reassuring string.

Note `NATIVE_STATS` also has no `unichain` entry while `CHAINS` does, so unichain is permanently `price = 0` — pre-broken for any future `sources` entry.

```diff
-      const price = await nativeUsd(chain);
-      const usd = Number(bal) / 1e18 * (price || 0);
+      const price = await nativeUsd(chain);
+      // nativeUsd returns 0 for "unknown chain", "fetch failed", "non-200" AND "unparseable" — so a
+      // dead price feed used to render as `accumulating ($0.000000)` regardless of the real balance,
+      // freezing the rail behind a reassuring message. Zero price is a BROKEN INSTRUMENT, not a
+      // small balance.
+      if (!price) { out[chain] = `PRICE FEED DOWN for ${chain} (nativeUsd returned 0) — holding ${bal} wei, cannot decide`; continue; }
+      const usd = Number(bal) / 1e18 * price;
```

---

## F12 — sweep LEG B takes a Base relay slot without honouring `escape:needsBase`
**`sweep.mjs:76, 92-95`** vs **`worker.mjs:1069-1076, 1116`**

The cron's own comment is unambiguous:
> *"SEQUENTIAL, AND THE ESCAPE HAS ABSOLUTE PRIORITY ON BASE … hold Base back from the harvesters until the escape is done with it."*

`worker.mjs:1116` honours it (`if (chain === 'base' && escapeNeedsBase) continue;`). `sweepCycle` runs between the escape and the harvesters (`worker.mjs:1104`) and gates only on `hs.escaped`:
```js
if (state.pending.length && hs.escaped) { ... relayExec(env, rpc, safe, …, 'base', 8453, 0) ... }
```
`hs.escaped` and `escapeNeedsBase` are near-opposites — `worker.mjs:489-491` says so in as many words. `escaped` is set the instant the unwrap leg is *relayed* (`harvest.mjs:492`), while the escape is not *done* until `eoaEth > 0 && eoaWeth === 0` (`harvest.mjs:456`). Measured right now: `EOA base native = 0`, `EOA base WETH = 8,017,928,993,051` → the escape is mid-flight, and `escaped` has been true long enough for a mint to have already gone through (9,780 USDC on the Base Safe). So the overlap window is real and has been occupied. With 5 Base slots/day the sweep can take the slot the escape was explicitly reserved.

```diff
   const hs = (await env.KV.get('harvest:state', 'json')) || {};
-  if (state.pending.length && hs.escaped) {
+  // hs.escaped means "an unwrap leg was RELAYED once", which is nearly the opposite of the cron's
+  // escapeNeedsBase ("the escape is mid-flight, reserve Base"). Honour the same reservation the
+  // batch loop honours — the cron's comment says the escape has ABSOLUTE priority on Base and this
+  // was the one Base consumer not reading the flag.
+  const escv = (await env.KV.get('escape:needsBase', 'json')) || null;
+  const escapeNeedsBase = !!(escv && escv.v === true && Date.now() - (escv.at || 0) < 15 * 60 * 1000);
+  if (state.pending.length && hs.escaped && !escapeNeedsBase) {
```

---

## F13 — `probeContract` truncates the recipient-taking signatures first
**`oracle.mjs:183-186`**

```js
const sigs = [...found.zeroArg, ...found.withRecipient];
...
for (const s of sigs.slice(0, 14)) results.push(await probePayout(rpc, chain, contract, s, token));
```
`ZERO_ARG_FNS` has 40 entries and `RECIPIENT_FNS` 12, concatenated in that order and then cut at 14. The `(address)` forms — including `harvest(address)`, the single signature ZERO has actually been paid by, and the *only* form that pays a caller who is not `msg.sender` — are always last and always the first to be dropped. Same shape as `worker.mjs:454` slicing 80 of 241 before ranking.

**Honest scope:** this does **not** currently fire. Measured over 60 Base strategy implementations, the matcher found ~2 signatures per contract (126 total), never more than a handful. It is a latent trap that will bite the first rich contract the prospector meets, and it makes the `14` cap unsafe to reason about. Filed P2 for the ordering, not for present loss.

```diff
-  const sigs = [...found.zeroArg, ...found.withRecipient];
+  // withRecipient FIRST. These are the forms that can pay an address the caller names — the only
+  // signature ZERO has ever actually been paid by is harvest(address) — and concatenating them
+  // after 40 zero-arg candidates put them permanently on the wrong side of the slice(0,14) below.
+  const sigs = [...found.withRecipient, ...found.zeroArg];
```

---

## F14 — the internal-transactions loop shares one `try`, so one bad item drops every later move in that transaction
**`payouts.mjs:88-94`**

```js
try {
  const r = await fetcher(`${scout}/api/v2/transactions/${t.hash}/internal-transactions`);
  for (const x of (JSON.parse(r.text).items || [])) {
    if (!(BigInt(x.value || '0') > 0n)) continue;
    moves.push({ ... });
  }
} catch { /* same */ }
```
`BigInt(x.value)` throws on any non-numeric string (Blockscout has returned `null`, `""`, and decimal-with-exponent forms). Because the `try` wraps the **whole loop**, one bad item aborts iteration and every remaining internal transfer in that tx is silently lost — including, potentially, the caller's own native fee. Same shape for the token-transfers loop above it. The comment on the token-transfers catch (`payouts.mjs:87`) states the intent correctly — *"a single tx failing to decode must not poison the verdict"* — and the granularity is one level too coarse to deliver it.

```diff
     for (const x of (JSON.parse(r.text).items || [])) {
-        if (!(BigInt(x.value || '0') > 0n)) continue;
-        moves.push({ ... });
+        // per-ITEM guard: the outer try wrapped the whole loop, so one unparseable value silently
+        // discarded every remaining move in the transaction.
+        try {
+          if (!(BigInt(x.value || '0') > 0n)) continue;
+          moves.push({ ... });
+        } catch { continue; }
     }
```

---

# P3 — cosmetic / hygiene

## F15 — `sweepCycle` blocks the cron for up to 30 seconds
**`sweep.mjs:141`**
```js
try { for (let i = 0; i < 6 && !p.tx; i++) { await new Promise(r => setTimeout(r, 5000)); const st = await relayStatus(...); if (st.tx) p.tx = st.tx; } } catch { /* resolved next tick */ }
```
Six 5-second sleeps inside a `*/2 * * * *` cron, ahead of `escapeCycle`'s successors and all six `batchHarvest` calls in the same `waitUntil`. The loop is also unnecessary — line 81-83 already re-resolves `p.tx` on the next tick, and the comment says so. Drop it to 2 attempts (or none) and let the tick loop do its job.

## F16 — `wethBalance` is a generic `balanceOf` with a chain-specific name, imported into sweep for non-WETH use
**`sweep.mjs:32, 115`** / `harvest.mjs:258`. `wethBalance(rpc, addr, chain, weth)` takes the token as a parameter and just calls `balanceOf` — the name is the only thing tying it to WETH. F3's fix uses it to read USDC, which is correct and reads as a bug. Rename to `erc20Balance` with a `wethBalance` alias so no call site breaks.

## F17 — `addrWord` accepts any non-zero storage word as an address
**`oracle.mjs:64-68`**
```js
const addrWord = (v) => { if (!v || v.length < 42) return null; const a = '0x' + v.slice(-40); return /^0x0+$/.test(a) ? null : a; };
```
The upper 12 bytes are discarded without checking they are zero, so any storage variable that happens to occupy `LEGACY_SLOT` (an unstructured-storage collision, or a contract that simply uses that slot) is silently reinterpreted as an implementation address. The consequence is one wasted `eth_getCode` returning `0x`, not a wrong answer — but it will mislead whoever debugs the next proxy shape.
```diff
-const addrWord = (v) => { if (!v || v.length < 42) return null; const a = '0x' + v.slice(-40); return /^0x0+$/.test(a) ? null : a; };
+const addrWord = (v) => {
+  if (!v || v.length !== 66) return null;
+  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(v)) return null;   // upper 12 bytes MUST be zero, or it is not an address
+  const a = '0x' + v.slice(-40);
+  return /^0x0+$/.test(a) ? null : a;
+};
```

## F18 — the chain→wrapped-native map is duplicated as a nested ternary in two places
**`worker.mjs:614` and `worker.mjs:620`**
```js
const t = token || (chain === 'polygon' ? '0x0d50…' : chain === 'gnosis' ? '0xe91D…' : chain === 'arbitrum' ? '0x82aF…' : '0x4200…0006');
```
A third copy of `harvest.mjs:23-32 CHAINS[*].weth`, with no `optimism` or `unichain` case — both happen to be correct by fallthrough today, and both silently become wrong the moment a chain whose wrapped-native is not `0x4200…0006` is added. Import `CHAINS` and read `CHAINS[chain]?.weth`.

---

# Verified NOT broken — do not re-check these

1. **`eth_call` state-override is honoured on every Optimism upstream.** `sweep.mjs:61-68 simulateAsSafe` depends entirely on the non-standard 3rd `eth_call` param; if a node ignored it, the call would hit the real Safe's fallback, return `0x`, and pass vacuously. Probed with `{to: 0x…BeeF, data:'0x'}` + override `code: 0x602a60005260206000f3` (returns `0x2a`):
   - optimism: `optimism-rpc.publicnode.com` **HONORED**, `optimism.drpc.org` **HONORED**, `mainnet.optimism.io` **HONORED**
   - base: publicnode **HONORED**, drpc **HONORED** (1rpc + base.org were rate-limited, not unsupported)
   - arbitrum: publicnode **HONORED**, `arb1.arbitrum.io` **HONORED**
   The sweep's whole-batch simulation is real.
2. **`selectorsPresent`'s naive hex-substring matching produces ZERO ghost selectors** on our population. Compared `hay.includes(selector)` against a proper PUSH4 opcode-walk (skipping PUSHn immediates) over 60 Base strategy implementations: naive matched **126**, dispatch-table walk matched **126**, ghosts **0 (0.0%)**. The `bruteforce.mjs:41` defect does **not** reproduce in `oracle.mjs`. Nibble-misaligned matches are theoretically possible but did not occur; also, `codes.join('')` inserts `'0x'` between the two blobs, and `x` is not a hex digit, so a match cannot straddle the junction.
3. **`probePayout`'s `[bal, fn, bal]` ordering is correct** and free of the `probeMany` shared-state contamination (#140) — a single contract's call sits between its own two reads with nothing else in the batch.
4. **`probeMany`'s index arithmetic is correct.** `before = rows[k*2]`, `call = rows[1+k*2]`, `after = rows[2+k*2]` maps exactly onto `[bal, c0.fn, bal, c1.fn, bal, …]`. No off-by-one.
5. **The `paid_wei` / `wei` sort comparators (`oracle.mjs:174`, `oracle.mjs:187`) do not misorder.** They are formally inconsistent (return `-1` for equal values — the exact pattern `harvest.mjs:192-198` fixed with a comment), so I tested rather than assumed: 400 randomized trials each at n = 10, 24, 30, 64, 241 with heavy ties → **0/400 non-descending results, 0/400 differing from a correct comparator** at every size. V8's sort tolerates it. **Not filed as a bug.** Worth normalising to `y>x?1:y<x?-1:0` for consistency, but it is style, not a defect.
6. **All 7 `SCOUT` hosts in `payouts.mjs:22-30` answer.** base / optimism / arbitrum / gnosis / polygon / unichain / base-sepolia all returned HTTP 200 with parseable `items`. Note `payouts.mjs` covers every chain in `harvest.mjs CHAINS`, unlike `NATIVE_STATS` (see F11).
7. **The `payouts.mjs:62` `t.method` filter is not currently discarding valid data.** Blockscout returned a non-null `method` on **195/195** successful transactions across four contracts (unverified proxies included). The theoretical risk on a contract Blockscout cannot decode remains, but it does not fire today.
8. **`probePayout`'s delta measurement itself is correct.** It reads a real payer accurately: `0x11dD6940…` `harvest(address)` → **46,165,896,263 wei WETH**, measured live. Multicall3's baseline balances are clean (`WETH 0`, `native 0`).
9. **`hs.escaped` is read from the same KV key `harvest.mjs` writes.** `sweep.mjs:76` reads `harvest:state`; `harvest.mjs:445/493` write `harvest:state`. No key or casing mismatch. (The *semantics* are wrong — see F12 — but the plumbing is right.)
10. **The CCTP v2 encoding in `sweep.mjs:127-129` matches what actually executed.** `depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)` with `maxFee=0, minFinalityThreshold=2000`, and SwapRouter02's 7-field `exactInputSingle` tuple with no deadline — both confirmed by the live sweep tx `0x6839a5fbd1d972aa75923980baf7382a9a7a810c940645e0d2ff30bfa8c09c1e`, which swapped and burned successfully.
11. **`payoutHistory` does not double-count.** `paid` accumulates one entry per distinct value movement per transaction; no entry is emitted twice and nothing sums the list. The problem is *what* is in the list (F2), not arithmetic.
12. **`sweep.mjs:91` correctly simulates `receiveMessage` before spending the mint slot.** The pre-flight guard is right; only the post-flight confirmation is missing (F4).

---

## Reproduction scripts
All measurements above were produced by throwaway scripts in the session scratchpad (`m1`–`m12.mjs`) which import the repo's real `oracle.mjs` / `payouts.mjs` rather than reimplementing them. No file in `AutoGLMwallet/` outside this directory was modified.
