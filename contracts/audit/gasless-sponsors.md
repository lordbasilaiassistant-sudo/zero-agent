# Audit lane: gasless-sponsors

**Scope:** `gasless.mjs` (172 lines), `sponsors.mjs` (164), `gasrouter.mjs` (199).
**Method:** read every line as a claim, then falsify it with live `eth_call` / `eth_getLogs` / HTTP against Base.
**Date:** 2026-07-31. **Read-only** — nothing outside this file was modified, no slot spent, no key touched.

**Headline:** these three modules are ZERO's moat *research* layer, and all three instruments currently
return a measurement that is not the thing they claim to measure.

- `sponsors.mjs` — **30/30** randomly sampled active Base EOAs passed the sponsor screen; **21/30 (70%)**
  got the verdict *"STRONG sponsor signature."* Zero rejections. It is measuring "is an active EOA."
- `gasrouter.mjs` — an RPC that answered **"over rate limit"** was recorded as **`open:false`**, i.e. as a
  paymaster that refused us. The module's own line 29 names this exact trap.
- `gasless.mjs` — **12 of 12** strategies in `contracts/callreward-measurement.json` (the whole $76.14
  claimable set) are 45-byte EIP-1167 clones that `resolveImplementation()` returns `null` for; and
  `scanGasless` reports the **ERC-4337 v0.7 EntryPoint** — the canonical gasless rail, hardcoded as THE
  EntryPoint by `gasrouter.mjs` 20 lines away — as `rails: []`, *"No meta-transaction or signature rail."*

14 findings: 6× P1, 6× P2, 2× P3. No P0 — the existing Safe-relay earning path is untouched by these;
what is broken is our ability to *find* the next rail, which is exactly what these files exist for.

---

## P1-1 · `sponsors.mjs:93-127` — the sponsor fingerprint rejects nothing. 30/30 active EOAs pass.

```js
    if (t.to?.hash && lc(t.to.hash) !== lc(address)) paidForOthers++;   // :107
...
  const score = (isEoa ? 25 : 0)                                        // :115
    + Math.min(30, spread * 2)
    + (concentration > 0.8 ? 25 : concentration > 0.5 ? 12 : 0)
    + Math.min(20, Math.round((paidForOthers / items.length) * 20));
```

**Why it is wrong.** The comment on :106 calls line 107 *"The defining act: it pays a fee to execute a call
against a contract that is not its own."* That is not the defining act of a sponsor — it is the definition of
**every transaction any EOA has ever sent**. An EOA's `to` is essentially never itself, so `paidForOthers /
items.length == 1.0` and that term is a **constant +20**, not a discriminator. What actually separates a
sponsor from a bot — *who benefits from the call* — is never read.

Arithmetic floor for any single-purpose active EOA: `25 (eoa) + 2 (spread=1) + 25 (conc=1.0) + 20 (constant)
= 72 ≥ 70` → **"STRONG sponsor signature — submits one job type for many unrelated parties."** The verdict
string says *"many unrelated parties"* while `distinct_destinations == 1`.

**MEASURED (live, Base Blockscout, 2026-07-31).** 30 EOAs taken from the latest validated-transaction pages,
excluding anything already relayer-shaped (`handleOps` / `execTransaction` / `execute`):

```
sampled 30 random ACTIVE non-relayer Base EOAs (nodata 0)
  scored STRONG sponsor (>=70): 21  (70%)
  scored possible    (45-69)  : 9
  correctly rejected (<45)    : 0        <-- specificity 0%
  scored STRONG *while having exactly ONE distinct destination*: 19
  score histogram: {"47":6,"53":1,"55":1,"59":1,"72":19,"81":1,"92":1}
```

Sample rows:
```
score  72 | eoa=true conc=1 dests= 1 n=50 top=updatePrice  0x1ef9D9240D83a1cf120c6FA7658Ca47D005532d0
      verdict: STRONG sponsor signature — submits one job type for many unrelated parties
score  72 | eoa=true conc=1 dests= 1 n=48 top=0x1667d875   0xd52f194ff7b52AAE71B1485228A50460DA1EaEfC
```
A price-oracle keeper hitting one contract 50 times in a row is not a gas sponsor.

**Concrete failure.** Every research hour spent on `sponsor_discover` output is spent on a list with ~0
enrichment over "recently active Base EOAs." Any "novel sponsor" the module reports is noise, and
`controlTest()` cannot catch it — see P1-2.

**Minimal fix** — measure the actual relation (fee payer ≠ beneficiary) and add a rejection term:
```diff
-    if (t.to?.hash && lc(t.to.hash) !== lc(address)) paidForOthers++;
+    // The defining act is that the BENEFICIARY is someone else, not that `to` is someone else.
+    // Proxy for it on-chain: the tx carries an inner party (4337 sender / 2771 from / Safe exec target)
+    // that is not the submitter. Anything we cannot establish that for is NOT counted.
+    const inner = lc(t.decoded_input?.parameters?.find(p => /sender|from|account|user|safe/i.test(p.name))?.value || '');
+    if (inner && inner !== lc(address)) paidForOthers++;
@@
-  const score = (isEoa ? 25 : 0)
+  if (spread < 5) return { address, is_eoa: isEoa, sampled: items.length, distinct_destinations: spread,
+    sponsor_score: 0, verdict: 'not a sponsor — serves fewer than 5 distinct destinations' };
+  const score = (isEoa ? 25 : 0)
```

---

## P1-2 · `sponsors.mjs:130-146` — the control has no negative arm, so it cannot fail.

```js
  const passed = results.every(r => r.sponsor_score >= 70);              // :137
```

**Why it is wrong.** The file's opening argument (:27-30) is correct — *"a new instrument must reproduce the
known result before its novel results mean anything"* — but a true-positive-only control is passed by an
instrument that returns `sponsor` for every input, which is precisely the instrument we have (P1-1).

**MEASURED.** The control passes cleanly today:
```
passed: true
  0x00ae928d…3c2a score 100 | eoa true | conc 0.92 | dests 20 | method execute
  0xe2d4a7ff…733c score 100 | eoa true | conc 0.96 | dests 18 | method execute
```
…while 30/30 non-sponsors also pass the screen. The control is green and the instrument is broken.

Note the second-order signal in that output: both ground-truth sponsors have `dominant_method = execute`
(Safe relay executors). Everything `discoverSponsors` returns has `dominant_method = handleOps` (see P1-3).
**The control validates the fingerprint on a species the discovery path never returns.**

**Fix** — add the arm that can fail:
```diff
 export const KNOWN_SPONSORS = [ … ];
+// Ground-truth NON-sponsors: high-volume EOAs that only ever operate their own positions.
+// If any of these scores >=70 the fingerprint is not discriminating and its novel output is noise.
+export const KNOWN_NON_SPONSORS = [
+  '0x1ef9d9240d83a1cf120c6fa7658ca47d005532d0',   // price keeper, 1 destination, conc 1.0 — scores 72 today
+  '0xd52f194ff7b52aae71b1485228a50460da1eaefc',   // single-contract bot          — scores 72 today
+];
@@
-  const passed = results.every(r => r.sponsor_score >= 70);
+  const negatives = [];
+  for (const a of KNOWN_NON_SPONSORS) negatives.push(await fingerprint(chain, a));
+  const passed = results.every(r => r.sponsor_score >= 70) && negatives.every(r => r.sponsor_score < 45);
```

---

## P1-3 · `sponsors.mjs:47-52, 61-87` — it enumerates **bundlers**, which are reimbursed, not sponsors, which pay.

```js
 * Enumerate the addresses that submit transactions INTO a hub. For an ERC-4337 EntryPoint this is
 * precisely the set of bundlers operating on the chain …                 // :62-64
```
and `worker.mjs:669`: *"Enumerate the gas SPONSORS operating on a chain — every entity that pays for other
people's transactions."*

**Why it is wrong.** The docstring is accurate and the product claim built on it is not. A bundler calls
`handleOps` and is **reimbursed out of the userOp's own prefund or by the paymaster**. It is the one party in
a 4337 flow structurally guaranteed *not* to pay for us. The entity that actually pays is the **paymaster** —
`topics[3]` of `UserOperationEvent` — which `gasrouter.mjs:115` already extracts. The two modules in this lane
use two different definitions of "sponsor" and only one of them is the payer.

**MEASURED.** `discoverSponsors('base', {top:6})` returns six EOAs, every one of them a bundler:
```
0x211d98242E4C58E9eB17E3CC135a165Bd59dd172 score=76 eoa=true method=handleOps hub_txs=11
0xf279dFcdD57E1571c95E2c5b7E2eE453cbcDF77F score=76 eoa=true method=handleOps hub_txs=4
0xe19635704aE3B77bc993358Ff515D10ccEaE0ce1 score=74 eoa=true method=handleOps hub_txs=9
0x1ea6F78a6DD8487aFA5f1A3638EbCa2e0580F223 score=74 eoa=true method=handleOps hub_txs=4
0xec5b2b400e7293976173883E0c4B555bc50E60E5 score=72 eoa=true method=handleOps hub_txs=4
0xbdBeBD58cC8153Ce74530BB342427579315915B2 score=72 eoa=true method=handleOps hub_txs=4
```

**Verified alongside it:** the tool description's claim *"44% of recent ERC-4337 ops on Base had their gas
paid by a third party"* **reproduces**. Over 400 blocks: `1423 UserOperationEvents, 584 with a non-zero
paymaster = 41.0%, 11 distinct paymasters`. The 41% is real; it just belongs to the paymasters, not to the
handleOps callers this module returns.

**Fix** — take the payer, not the courier:
```diff
 export async function sponsorsOfHub(chain, hub, pages = 2) {
+  // NOTE: for a 4337 EntryPoint this returns BUNDLERS (reimbursed couriers), not sponsors (payers).
+  // The payer is topics[3] of UserOperationEvent — use sponsorsOfEntryPointLogs() for that.
```
and add a `sponsorsOfEntryPointLogs()` that reuses `gasrouter.mjs:107-118`'s log walk, so `sponsor_discover`
returns paymasters. Cross-check: `gasrouter.admissionTestPaymaster` already exists to admission-test them.

---

## P1-4 · `gasrouter.mjs:101-103` — an RPC transport failure is recorded as "the paymaster refused us". **Proven live.**

```js
  } catch (e) {
    return { paymaster, open: false, reason: String(e.message).replace(/execution reverted:?/, '').trim().slice(0, 60) };
  }
```

**Why it is wrong.** The `catch` cannot tell a contract revert from an HTTP 429, a timeout, or an upstream
outage. Every one of them becomes `open: false`, which `checkPaymasters:126` renders as
`note: 'closed (…)'` and `gasSources:188` counts as `open_paymasters: 0`. The module's own line 29 warns
about *"the failed-read-looks-like-a-null trap"* and line 101 implements it.

**MEASURED — this is not hypothetical.** Running the shipped `admissionTestPaymaster` against the 8 busiest
live Base paymasters, the RPC rate-limited and the function reported all 8 as refusing us:
```
0x2cc0c7981d846b9f2a16276556f6e8cb52bfb633  code.open=false  code.reason="over rate limit"
0x777777777777aec03fd955926dbf81597e66834c  code.open=false  code.reason="over rate limit"
0xdcbe0c1a00e4cf24ae77c52125e6e6b4f7c6db4e  code.open=false  code.reason="over rate limit"
…8/8 identical
```
`"over rate limit"` is the public RPC talking, not the paymaster. The module comment at :84 —
*"Measured 2026-07-29: all 17 live paymasters on Base returned closed"* — is a conclusion that this code
path is capable of producing without a single paymaster ever being asked.

**With backoff and multi-upstream retry the honest answer today is still "closed"**, so the substantive
conclusion survives — but it survives by luck, not by measurement:
```
0x886f51115829cb326b74e8a834fb93fe25e85050  RETURNED vd=1 authorizer=0x1 -> genuinely SIG_VALIDATION_FAILED
0x2cc0c798… 0x777777… 0xdcbe0c1a… 0x5fa66dfe… 0xf10247e7… 0x066a5c75… 0x8b1f6cb5…  -> real reverts
```

**Fix:**
```diff
   } catch (e) {
-    return { paymaster, open: false, reason: String(e.message).replace(/execution reverted:?/, '').trim().slice(0, 60) };
+    const m = String(e.message || '');
+    // A failed READ is not a refusal. Never let transport noise be filed as a measurement.
+    if (!/execution reverted|revert|invalid opcode|out of gas/i.test(m)) {
+      return { paymaster, open: null, unmeasured: true, reason: 'READ FAILED (not a refusal): ' + m.slice(0, 80) };
+    }
+    return { paymaster, open: false, reason: m.replace(/execution reverted:?/, '').trim().slice(0, 60) };
   }
```
and in `checkPaymasters:123-127` carry `unmeasured` through so `open_paymasters: 0` cannot be reported off
unmeasured probes.

---

## P1-5 · `gasless.mjs:123-136` — `resolveImplementation` is blind to EIP-1167 clones. **100% of the live target set.**

```js
export async function resolveImplementation(chain, contract) {
  try {
    for (const slot of [IMPL_SLOT, LEGACY_SLOT]) { … }                    // :125
    const beacon = addrFromWord(await rpc(chain, 'eth_getStorageAt', [contract, BEACON_SLOT, 'latest']));
```

**Why it is wrong.** All three shapes it knows are **storage-slot** proxies. The most common proxy on Base —
EIP-1167 minimal proxy / OpenZeppelin `Clones` — stores the implementation **inside the runtime bytecode**,
not in storage. `resolveImplementation` returns `null` for every clone, `scanGasless` then scans a 45-byte
delegatecall stub, finds nothing, and emits the exact verdict the docstring at :77-80 says was the mistake
that *"discarded 90+ discovery candidates."*

**MEASURED.** Every one of the top 12 strategies in `contracts/callreward-measurement.json` — the whole
$76.14 claimable set, 111 vaults with pending fees:

```
addr        bytes  clone      resolveImplementation()  real impl (from bytecode)
0x8B45D51e   45    EIP-1167   null                     0x68ecddba8d4cfca13923fc8d66f2678bf17ab4e1
0xa0dBaE6a   45    EIP-1167   null                     0x68ecddba…
0xc664C800   45    EIP-1167   null                     0x68ecddba…
… 12 of 12 identical
```
And ZERO's **own** smart account, a Safe proxy that keeps its singleton in **slot 0** — a fourth shape none of
the three slots covers:
```
0x510601f59FDa068D70ad6760c9d9085B0F42cbb1  code 171 bytes
  slot0 = 0x…29fcb43b46531bca003ddc8fcb67ffe91900c762   (Safe L2 singleton 1.4.1)
  resolveImplementation() -> null
  scanGasless -> rails: []  scanned: 'runtime bytecode'
  verdict: "No meta-transaction or signature rail in its bytecode."
```

**Concrete failure.** `scanGasless` cannot tell "this contract has no gasless rail" from "this contract is a
clone and I read the stub." On today's target set it is 0-for-12. *(Honest note: I checked the shared Beefy
implementation `0x68ecddba…` directly and it genuinely exposes no rail — so on this particular set the false
negatives happen to cost nothing. The detector was right by accident, which is not the same as right.)*

**Fix** — two lines, both pure bytecode reads, no extra RPC for the 1167 case:
```diff
 export async function resolveImplementation(chain, contract) {
   try {
+    // EIP-1167 minimal proxy: the implementation is IN the code, not in storage. 100% of the current
+    // Beefy strategy target set is this shape and every storage slot below returns null for it.
+    const code = await rpc(chain, 'eth_getCode', [contract, 'latest']).catch(() => '0x');
+    const clone = /363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/.exec(code.toLowerCase());
+    if (clone) return '0x' + clone[1];
     for (const slot of [IMPL_SLOT, LEGACY_SLOT]) {
       const a = addrFromWord(await rpc(chain, 'eth_getStorageAt', [contract, slot, 'latest']));
       if (a) return a;
     }
+    // Safe / GnosisSafeProxy keeps its singleton in slot 0 — ZERO's own smart account is this shape.
+    const slot0 = addrFromWord(await rpc(chain, 'eth_getStorageAt', [contract, '0x' + '0'.repeat(64), 'latest']));
+    if (slot0 && (await rpc(chain, 'eth_getCode', [slot0, 'latest']).catch(() => '0x')) !== '0x') return slot0;
```

---

## P1-6 · `gasless.mjs:27-57` — `RAILS` misses the v0.7 EntryPoint and misses ZERO's own working rail.

```js
  { sig: 'handleOps((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes)[],address)', rail: 'ERC-4337-ENTRYPOINT', note: 'IS an EntryPoint' },   // :48
```

**Why it is wrong.** That string is the **v0.6** `UserOperation` shape → selector `0x1fad948c`. The v0.7
`PackedUserOperation` shape is `0x765e827f` and is absent. `gasrouter.mjs:26` hardcodes
`ENTRYPOINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032`, which is **v0.7**. The two files in the same lane
disagree about which EntryPoint exists. (The `validatePaymasterUserOp` entry on :49 is the opposite mistake —
it is the v0.7 shape `0x90aad79d`, so v0.6 paymasters `0xf465c77e` are invisible too.)

**MEASURED — the decisive one:**
```
scanGasless(base, 0x0000000071727De22E5E9d8BAf0edAc6f37da032)  -> rails: []            gasless_possible: false
scanGasless(base, 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789)  -> rails: ["ERC-4337-ENTRYPOINT"]
```
The detector says the canonical, busiest gasless rail on Base — 1423 userOps in the last 400 blocks — has no
gasless rail.

**Second miss, and it is the one that stings.** ZERO's *production* gasless path is Safe
`execTransaction(...)` relayed by Safe's service. That selector is in the singleton and not in `RAILS`:
```
Safe singleton 0x29fCB43b…C762:
  execTransaction  0x6a761202  present=true   <- NOT in RAILS
  domainSeparator  0xf698da25  present=true   <- RAILS only has DOMAIN_SEPARATOR() 0x3644e515 (absent)
  isValidSignature 0x1626ba7e  present=false
```
So the one specimen we hold ground truth for — the rail that produced the entire $0.08447 — scans as
*"No meta-transaction or signature rail."* `gasless.mjs` has **no control test**, and the obvious control
falsifies it on the first try. `sponsors.mjs` at least tried (:130).

**Third miss:** OpenZeppelin v5 `ERC2771Forwarder.execute` is `0xdf905caf`; `RAILS:32` only carries the v4
`MinimalForwarder` shape `0x47153f82`. Every forwarder deployed from OZ v5 is undetected.

**Fix:**
```diff
   { sig: 'execute((address,address,uint256,uint256,uint256,bytes),bytes)', rail: 'ERC-2771-FORWARDER', … },
+  { sig: 'execute((address,address,uint256,uint256,uint48,bytes,bytes))', rail: 'ERC-2771-FORWARDER', note: 'OpenZeppelin v5 ERC2771Forwarder' },
+  { sig: 'executeBatch((address,address,uint256,uint256,uint48,bytes,bytes)[],address)', rail: 'ERC-2771-FORWARDER', note: 'OZ v5 batch forwarder' },
   { sig: 'handleOps((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes)[],address)', rail: 'ERC-4337-ENTRYPOINT', note: 'IS an EntryPoint (v0.6)' },
+  { sig: 'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)', rail: 'ERC-4337-ENTRYPOINT', note: 'IS an EntryPoint (v0.7) — the live one on Base' },
+  { sig: 'validatePaymasterUserOp((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes),bytes32,uint256)', rail: 'ERC-4337-PAYMASTER', note: 'v0.6 paymaster' },
+  // ZERO's OWN production rail. Any owner signature, any submitter. Detect it or the instrument fails its own control.
+  { sig: 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)', rail: 'SAFE-EXEC', note: 'Safe: owner signatures, ANY submitter — this is how ZERO already transacts' },
+  { sig: 'domainSeparator()', rail: 'EIP-712', note: 'Safe-style typed-data domain (lowercase variant)' },
+  { sig: 'isValidSignature(bytes32,bytes)', rail: 'EIP-1271', note: 'contract-signature verification' },
```
Add `RANK['SAFE-EXEC'] = 70, RANK['EIP-1271'] = 20` in `sweepGasless:156`, and add a `controlTest()` to
`gasless.mjs` asserting the Safe singleton and the v0.7 EntryPoint both come back non-empty.

---

## P1-7 · `gasless.mjs:20-24` — hardcoded 3-chain RPC map in functions that take a `chain` parameter.

```js
const RPCS = {
  base: 'https://base-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
};
…
  if (!url) throw new Error(`no rpc for chain "${chain}"`);               // :63
```

**Why it is wrong.** Every other module in this repo is handed the worker's `rpc(chain, method, params)`
closure, which has a **4-URL fallback** (`worker.mjs:67-93`). `gasless.mjs` alone re-implements a
**single-URL, zero-retry** RPC over a subset of chains — violating CLAUDE.md §8 ("route reads through a
public RPC with your own retry") and capping the moat detector at 3 of the 8 chains the worker knows.

**MEASURED, and the intersection is the painful part:**
```
scanGasless coverage         Safe relay quota right now (safe-client.safe.global, HTTP 200)
  base      OK                 base      {"remaining":0,"limit":5}
  optimism  OK                 optimism  {"remaining":0,"limit":5}
  arbitrum  OK                 arbitrum  {"remaining":0,"limit":5}
  polygon   THROWS             polygon   {"remaining":0,"limit":5}
  gnosis    THROWS             gnosis    {"remaining":5,"limit":5}   <-- FREE
  unichain  THROWS             unichain  {"remaining":5,"limit":5}   <-- FREE
```
**The only two chains with free capacity today are the two the gasless detector cannot scan**, and polygon —
one of ZERO's three measured earning chains — is a third. The header comment at :4-5 ("zero slots to call
them with") is also stale: there are **10 free slots** sitting on gnosis + unichain as of this audit.

Separately, the single hardcoded upstream is a live failure mode: `base-rpc.publicnode.com` answered
`"Archive requests require a personal token"` to `eth_getLogs` during this audit. With no fallback,
`gasless.mjs` has no way past that; the worker's RPC would have rolled to `base.drpc.org`.

**Fix** — stop owning an RPC; accept the one the worker already has:
```diff
-export async function scanGasless(chain, contract) {
-  const code = await rpc(chain, 'eth_getCode', [contract, 'latest']);
+// `rpcFn` is the worker's rpc(chain, method, params) with its 4-upstream fallback. Falling back to the
+// module-local single-URL map means 3 chains and no retry — including neither chain that has free quota.
+export async function scanGasless(chain, contract, rpcFn = rpc) {
+  const code = await rpcFn(chain, 'eth_getCode', [contract, 'latest']);
```
(thread `rpcFn` through `resolveImplementation` / `resolveForwarder` / `sweepGasless`; pass
`(c,m,p) => ctx.rpc(c,m,p)` at `worker.mjs:559`.)

---

## P2-1 · `gasrouter.mjs:170,197` — the gas-source cache key is not chain-scoped.

```js
  const cached = await env.KV.get('gas:sources', 'json').catch(() => null);   // :170
…
  await env.KV.put('gas:sources', JSON.stringify(out)).catch(() => {});       // :197
```
`gasSources` takes `chain` (:169), uses it for `chainId` (:173), `checkPaymasters` (:177) and every
`checkSponsorApi` (:180) — then caches all of it under one global key. `/gas?chain=arbitrum` within 10
minutes of `/gas?chain=base` returns **Base's** paymaster set and Base's sponsor-API verdicts labelled as
Arbitrum's, with `cached: true`. Same shape as a state key written in one casing and read in another.
```diff
-  const cached = await env.KV.get('gas:sources', 'json').catch(() => null);
+  const key = `gas:sources:${chain}`;
+  const cached = await env.KV.get(key, 'json').catch(() => null);
@@
-  await env.KV.put('gas:sources', JSON.stringify(out)).catch(() => {});
+  await env.KV.put(key, JSON.stringify(out), { expirationTtl: 3600 }).catch(() => {});
```

## P2-2 · `gasrouter.mjs:144-166` — a `pm_getPaymasterStubData` result is not a sponsorship, and the wall classifier is inert and wrong today.

```js
    if (j.result) return { source: 'sponsor-api', id: api.id, available: true, capacity: Infinity, cost_usd: 0, note: 'ACCEPTED — free sponsored gas', result: j.result };   // :157
```
**Bug class 1.** A *stub* is by definition a placeholder returned so the client can estimate gas; ERC-7677
providers routinely return one and then refuse at `pm_getPaymasterData`. "It did not error" is being read as
"it will pay." Nothing here reads a balance, a policy, or a signature.

**And the "keep varying the op" advice is never executed and is empirically dead.** :162 emits
`'TECHNICAL — policies exist, keep varying the op'`, but (a) `gasSources:180` calls
`checkSponsorApi(a, chainId, safe)` with `callData` defaulted to `'0x'` (:144) and never varies anything, and
(b) `wall_type` is not read by `gasSources` or by any caller — grep returns only its own definition.

**MEASURED.** Candide's live refusal today is `"sponsored-validator: callData reverts"` — which names
`callData` and so classifies as TECHNICAL, "keep varying." I varied it eight ways:
```
0x  (what gasSources actually sends)       available=false  note="sponsored-validator: callData reverts"
execute(WETH,0,0x) 0xb61d27f6              available=false  note="sponsored-validator: callData reverts"
executeUserOp-ish 0x541d63c8               available=false  note="sponsored-validator: callData reverts"
Safe execTransactionFromModule 0x468721a7  available=false  note="sponsored-validator: callData reverts"
0x00 (single zero byte)                    available=false  note="sponsored-validator: callData reverts"
sender=ZERO's Safe / a live 4337 account / 0x…01  -> identical string in all three cases
pimlico-public: AUTH — "Sponsorship policy ID is required for this API key"   (correctly classified)
```
Identical response to every variation including a valid ERC-4337 sender ⇒ this is an unconditional refusal
wearing technical wording. The classifier is a regex over English prose being reported as a measurement.
```diff
-    if (j.result) return { source: 'sponsor-api', id: api.id, available: true, capacity: Infinity, cost_usd: 0, note: 'ACCEPTED — free sponsored gas', result: j.result };
+    // A STUB is a gas-estimation placeholder, not a sponsorship. Only pm_getPaymasterData is a commitment.
+    if (j.result) return { source: 'sponsor-api', id: api.id, available: false, stub_ok: true, capacity: 0,
+      note: 'STUB ONLY — re-ask with pm_getPaymasterData before calling this capacity', result: j.result };
@@
-      wall_type: authWall ? 'AUTH — needs a key, do not re-probe' : 'TECHNICAL — policies exist, keep varying the op',
+      wall_type: authWall ? 'AUTH — needs a key, do not re-probe'
+        : 'TECHNICAL-WORDING — unproven. Measured 2026-07-31: 8 callData/sender variations returned the identical string. Treat as closed until a variation changes the message.',
```

## P2-3 · `gasless.mjs:87-91,103` — `scanned: 'proxy + implementation'` is printed when the implementation was never read.

```js
    const icode = await rpc(chain, 'eth_getCode', [impl, 'latest']).catch(() => '0x');   // :89
    if (icode && icode !== '0x') hay += icode.toLowerCase();
…
    scanned: impl ? 'proxy + implementation' : 'runtime bytecode',                        // :103
```
The label keys off `impl` being *resolved*, not off the code being *fetched*. A failed second `eth_getCode`
(single upstream, no retry — P1-7) yields "no rails, scanned proxy + implementation," which is the report a
future session will trust and not re-check.
```diff
-  let hay = code.toLowerCase();
+  let hay = code.toLowerCase();
+  let implScanned = false;
   const impl = await resolveImplementation(chain, contract);
   if (impl) {
     const icode = await rpc(chain, 'eth_getCode', [impl, 'latest']).catch(() => '0x');
-    if (icode && icode !== '0x') hay += icode.toLowerCase();
+    if (icode && icode !== '0x') { hay += icode.toLowerCase(); implScanned = true; }
   }
@@
-    scanned: impl ? 'proxy + implementation' : 'runtime bytecode',
+    scanned: implScanned ? 'proxy + implementation' : (impl ? 'proxy ONLY — implementation read FAILED, result is not conclusive' : 'runtime bytecode'),
```

## P2-4 · `gasless.mjs:138-152,167` — `resolveForwarder` never checks that the forwarder is open, and never runs at all.

The comment at :138-140 states the requirement — *"an OPEN forwarder (no allowlist on the submitter) means
anyone can carry our signed request"* — and :30 repeats it. `resolveForwarder` returns an **address** and
stops. Nothing anywhere calls `getNonce`, submits a dummy `verify(...)`, or checks a submitter allowlist.
Presence is being reported as admission — the same shape as P2-2.

Worse: its only call site is `sweepGasless:167`, and **`sweepGasless` is imported at `worker.mjs:20` and never
invoked** (grep: one import, zero calls). The entire ERC-2771 branch of the moat is dead code.

Also demonstrates the ranking gap: Gelato's live ERC-2771 relay forwarder on Base scores **1/100**.
```
scanGasless(base, 0xd8253782c45a12053594b9deB72d8e8aB2Fca54c)  4791 bytes  rails: ["EIP-712"]
  -> RANK['EIP-712'] = 1, gasless_possible = false
```
```diff
 export async function resolveForwarder(chain, contract) {
+  // Presence is not admission. A forwarder that allowlists submitters is worth nothing to us.
+  // Test it: ask for our own nonce (must answer) and simulate verify() from an unrelated address.
```
Add an `isForwarderOpen(chain, forwarder, from)` that `eth_call`s `getNonce(address)`/`nonces(address)` for
an address the forwarder has never seen and simulates `verify(...)` **from a random submitter**, and gate
`PERSISTENT-RECIPIENT`/`ERC-2771` scoring on it. Then either call `sweepGasless` from a worker tool or delete
the import.

## P2-5 · `sponsors.mjs:159` — slice before rank; 20 addresses are structurally unreachable.

```js
  for (const c of Object.values(seen).slice(0, top)) {                    // :159
…
  return out.sort((a, b) => b.sponsor_score - a.sponsor_score);           // :163
```
`seen` is in **hub insertion order**, so `slice(0, top)` keeps whichever hub is listed first in `HUBS` and the
final `.sort` only ranks the survivors. Same defect as `worker.mjs:454`.

**MEASURED:**
```
v0.7 hub callers: 59   v0.6 hub callers: 27
overlap: 7 / 27  ->  20 addresses reachable ONLY via the v0.6 hub, dropped every run
dropped, by hub tx count: 0x1278C1E4…(18)  0x048ef106…(16)  0xAF2bFB6b…(14)  0x501EF174…(7)
```
The three busiest v0.6 callers all out-rank every v0.7 caller that *did* survive (max hub_txs 11).
```diff
-  for (const c of Object.values(seen).slice(0, top)) {
+  // Rank the WHOLE candidate set, then cut. Slicing on insertion order silently deletes one hub.
+  const cands = Object.values(seen).sort((a, b) => b.txs - a.txs).slice(0, top * 2);
+  for (const c of cands) {
@@
-  return out.sort((a, b) => b.sponsor_score - a.sponsor_score);
+  return out.sort((a, b) => b.sponsor_score - a.sponsor_score).slice(0, top);
```

## P2-6 · `sponsors.mjs:95-98` — an unreachable chain reports "no outbound transactions". **Proven.**

```js
  const txs = await j(`${base}/api/v2/addresses/${address}/transactions?filter=from`).catch(() => ({ items: [] }));
  if (!items.length) return { address, sponsor_score: 0, why: 'no outbound transactions' };
```
`SCOUT` (:32-36) has three chains. For anything else `base` is `undefined`, the URL becomes
`"undefined/api/v2/…"`, the `.catch` swallows it, and the function states a fact about the chain that is false.

**MEASURED** — a known ground-truth sponsor, on a chain with no SCOUT entry:
```
fingerprint('polygon', 0x00ae928d…3c2a)
  -> {"address":"0x00ae928d…","sponsor_score":0,"why":"no outbound transactions"}
discoverSponsors('optimism')  ->  []      (HUBS has only `base`; empty array reads as "no sponsors here")
```
```diff
 export async function fingerprint(chain, address) {
   const base = SCOUT[chain];
+  if (!base) return { address, chain, sponsor_score: null, unmeasured: true, why: `no Blockscout endpoint configured for "${chain}" — NOT a measurement` };
-  const txs = await j(`${base}/api/v2/addresses/${address}/transactions?filter=from`).catch(() => ({ items: [] }));
+  let txs; try { txs = await j(`${base}/api/v2/addresses/${address}/transactions?filter=from`); }
+  catch (e) { return { address, chain, sponsor_score: null, unmeasured: true, why: 'explorer read failed: ' + String(e.message).slice(0, 60) }; }
```
Same treatment for `discoverSponsors:149` when `HUBS[chain]` is missing.

---

## P3-1 · `gasrouter.mjs:125,157` — `capacity: Infinity` becomes `null` on the KV round-trip.

`JSON.stringify({capacity: Infinity})` → `{"capacity":null}` (verified). An OPEN paymaster or sponsor API —
the single most valuable result this module can produce — is cached and re-served with `capacity: null`, and
any downstream `capacity > 0` gate silently rejects it. Use a large sentinel or a boolean:
```diff
-      available: t.open, capacity: t.open ? Infinity : 0, cost_usd: 0,
+      available: t.open, unlimited: !!t.open, capacity: t.open ? Number.MAX_SAFE_INTEGER : 0, cost_usd: 0,
```

## P3-2 · `gasrouter.mjs:62-78,192-195` — `best` picks our own ETH over free slots, contradicting `advice` two lines below; and a zero gas price yields an absurd capacity.

```js
        available: wei > perTx, capacity: Number(wei / (perTx || 1n)),     // :72
…
    best: usable.sort((a,b) => (b.capacity===Infinity?1:0)-(a.capacity===Infinity?1:0) || (b.capacity-a.capacity))[0] || null,   // :192
    advice: usable.length ? 'Spend FREE capacity first and keep any native ETH — …'                                             // :194
```
Sorting purely by capacity means a funded EOA always outranks free relay slots. At today's Base gas price
(0.006 gwei): `0.001 ETH → capacity 666` vs a free relay's `5` → `best = own-native-gas`, i.e. the router
recommends spending Anthony's ETH ahead of ten free slots, while the string underneath says the opposite.
Dormant only because the wallet has never been funded — it arms itself the moment it is. The `(perTx || 1n)`
guard is also wrong: `gasPrice 0` → `capacity 10000000000000000`.
```diff
-    best: usable.sort((a, b) => (b.capacity === Infinity ? 1 : 0) - (a.capacity === Infinity ? 1 : 0) || (b.capacity - a.capacity))[0] || null,
+    // Free-and-revocable BEFORE our own irreplaceable ETH — this must match `advice` below.
+    best: usable.sort((a, b) => (a.source === 'own-native-gas') - (b.source === 'own-native-gas')
+      || (b.capacity === Infinity ? 1 : 0) - (a.capacity === Infinity ? 1 : 0)
+      || (b.capacity - a.capacity))[0] || null,
```
```diff
-      const perTx = gp * 250000n;
+      const perTx = gp * 250000n;
+      if (perTx === 0n) continue;          // a zero gas price is a failed read, not infinite capacity
```

---

# Verified NOT broken — do not re-check these

| # | Checked | Result |
|---|---|---|
| 1 | `IMPL_SLOT` / `BEACON_SLOT` / `LEGACY_SLOT` (`gasless.mjs:115-117`) | **All three correct.** `keccak("eip1967.proxy.implementation")-1` = `0x360894a1…2bbc` ✔ · `keccak("eip1967.proxy.beacon")-1` = `0xa3f0ad74…3d50` ✔ · `keccak("org.zeppelinos.proxy.implementation")` = `0x7050c9e0…f8c3` ✔ |
| 2 | Substring scan vs a proper PUSH4 opcode walk (`gasless.mjs:96`) | **No false positives on 16 real contracts.** 12 Beefy strategies + USDC(proxy+impl) + UniversalRouter + WETH + the Gelato forwarder: substring hits `== ` PUSH4 hits, every time; zero odd-nibble-only matches. USDC found the same 5 rails both ways. The alignment/PUSH4 defect from `bruteforce.mjs:41` **does not materialise here** because only 20 specific selectors are searched (P(random 8-hex match) ≈ 1e-5/selector/20KB). Worth hardening eventually, not worth a session. |
| 3 | Proxy → implementation scanning for **EIP-1967** (`gasless.mjs:87-91`) | **Works.** USDC on Base `0x833589fC…2913`: 1852-byte proxy, impl resolved, 5 rails found (EIP-3009 + EIP-2612 + EIP-712). The documented USDC regression at :77-80 is genuinely fixed for this shape. (EIP-1167 and Safe-slot-0 are not — P1-5.) |
| 4 | Safe relay quota endpoint + parsing (`gasrouter.mjs:21,42-58`) | **Correct.** Live shape is exactly `{"remaining":0,"limit":5}`; the `typeof q.limit !== 'number'` guard, `available`, `capacity`, `ceiling` and the 160 ms sequential pacing all behave. Chains with no relayer answer HTTP 403 `{"message":"No relayer defined"}` and are correctly skipped. The "5/chain/day" cap in `gasless.mjs:4` is real. **Live quota 2026-07-31: gnosis 5/5, unichain 5/5, base/op/arb/polygon 0/5 → 10 free slots available right now.** |
| 5 | `UserOperationEvent` topic0 + paymaster extraction (`gasrouter.mjs:108,115`) | **Correct.** `0x49628fd1…419f` matches on the live v0.7 EntryPoint; `topics[3].slice(26)` yields well-formed paymaster addresses. 400 blocks → 1423 events, 11 distinct paymasters. |
| 6 | `worker.mjs:669` claim "44% of recent ERC-4337 ops had gas paid by a third party" | **Reproduces.** Measured 584/1423 = **41.0%** over 400 blocks. Honest number. |
| 7 | `admissionTestPaymaster` calling `from: ENTRYPOINT` (`gasrouter.mjs:98`) | **Correct and necessary** — paymasters gate on `_requireFromEntryPoint`. The v0.7 `PackedUserOperation` ABI on :87 is the right struct for this EntryPoint. |
| 8 | Are Base paymasters actually closed? | **Yes, today.** With backoff + 3 upstreams: 1 returns `validationData = 1` (SIG_VALIDATION_FAILED, authorizer `0x1`), 7 revert. The *conclusion* at :84 holds; the *method* that produced it does not (P1-4). |
| 9 | `checkSponsorApi` refusal classifier on Pimlico | **Correct.** `"Sponsorship policy ID is required for this API key"` → `AUTH — needs a key, do not re-probe`. Right call. (Candide's side is wrong — P2-2.) |
| 10 | `sponsorsOfHub` Blockscout pagination + `filter=to` (`sponsors.mjs:66-87`) | **Correct.** Returns exactly the addresses that submitted *into* the hub, deduped, tx-counted, `next_page_params` walked properly. 59 callers on v0.7, 27 on v0.6. The plumbing is fine; the *interpretation* is not (P1-3). |
| 11 | `controlTest` reproducing ground truth (`sponsors.mjs:134`) | **Passes.** Both known sponsors score 100 (`conc` 0.92/0.96, dests 20/18). The positive arm works; there is no negative arm (P1-2). |
| 12 | `selectorOf` (`gasless.mjs:59`) | Correct — `ethers.id(sig).slice(0,10)`, verified against 8 known selectors including `0x6a761202`, `0x1fad948c`, `0x3644e515`. |
| 13 | Every module is read-only | Confirmed by inspection: no `eth_sendRawTransaction`, no signing, no relay POST anywhere in the three files. `gasrouter.mjs:18`'s claim holds. |

---

## Reproduction

All measurements above came from standalone scripts under
`%LOCALAPPDATA%\Temp\claude\…\scratchpad\t1–td.mjs`, importing the repo's real modules unmodified via
`file:///C:/Users/drlor/OneDrive/Desktop/AutoGLMwallet/<module>.mjs`. Base RPCs used with fallback:
`mainnet.base.org`, `1rpc.io/base`, `base.drpc.org` (note `base-rpc.publicnode.com`, the module-local
default, **refuses `eth_getLogs`** with *"Archive requests require a personal token"*).

## Suggested fix order

1. **P1-4** (transport ≠ refusal) — one `catch`, and it invalidates a recorded "measurement" until fixed.
2. **P1-1 / P1-2** (fingerprint + negative control) — until this lands, all sponsor output is noise.
3. **P1-6** (RAILS: v0.7 EntryPoint + Safe `execTransaction`) — pure data, and gives `gasless.mjs` a control.
4. **P1-5** (EIP-1167 + Safe slot 0) — six lines, unblocks 100% of the live target set.
5. **P1-7** (accept the worker's `rpcFn`) — unblocks gnosis + unichain, where the only free slots are.
