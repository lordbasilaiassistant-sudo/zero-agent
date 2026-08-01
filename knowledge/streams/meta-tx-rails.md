# LANE 3 — meta-tx-rails: who else will pay ZERO's gas

> Measured 2026-08-01 (UTC), read-only. No transaction was sent, no key touched, no relay slot spent.
> Every number below has the `eth_call` / `eth_getLogs` / `GET` that produced it. Where a number is
> inherited rather than re-measured tonight it says so on the line.

## TL;DR — the honest verdict

**This lane found ZERO measured income.** It is a gas-supply lane, and gas supply produces no
`balanceOf` delta, so the mandatory payment test is *not applicable* to any row here — I have marked
every JSON row `isolatedProbe: false` and `measuredWei: "0"` rather than dress a capability up as
revenue. Nothing here should be counted toward $/day.

What it *did* find is that **ZERO's gas ceiling is already 6× higher than the doctrine says, and it is
multipliable.**

| # | Finding | Status |
|---|---|---|
| 1 | Safe relay's real ceiling is **30 tx/day (6 chains × 5)**, not 5/day. **10 slots were sitting unused** at probe time. | MEASURED |
| 2 | The relay quota is keyed on the **address alone** → each extra Safe ZERO controls is **+5/chain/day, forever**. Mint cost: **239,568 gas**, i.e. one relay slot. | MEASURED read + LEAD inference |
| 3 | 4 live ERC-2771 forwarders are **submitter-agnostic (open)**. On Base's, ZERO's own address reaches `ERC2771ForwarderInvalidSigner` — every gate but a free signature is satisfied. | MEASURED |
| 4 | **0 of 54** admission-tested live ERC-4337 paymasters across 6 chains are open. 73 discovered. | MEASURED |
| 5 | Candide's keyless public paymaster is a **per-dapp allowlist**. Killed — stop re-probing it. | MEASURED |
| 6 | EIP-7702 is **live on all 6 chains**; third parties routinely pay for other people's authorizations. | MEASURED |

The one sentence that matters: **an open forwarder is not gas.** It converts *"ZERO needs gas"* into
*"ZERO needs a volunteer submitter"*, which is a different, still-unsolved problem. The only entities
measured tonight that will actually pay ZERO's gas leg are Safe's relay (30/day) and — conditionally —
more Safes.

---

## 1. MEASURED: the Safe relay ceiling is 30/day, and 10 of them were idle

`GET https://safe-client.safe.global/v1/chains/{id}/relay/{safe}` is a **read**. It spends nothing.
Queried against all 59 chains Safe's client-gateway lists, for ZERO's Safe
`0x510601f59FDa068D70ad6760c9d9085B0F42cbb1`, at 2026-08-01T00:48:15Z:

| chain | chainId | remaining/limit |
|---|---|---|
| Base | 8453 | **0 / 5** |
| Polygon | 137 | **0 / 5** |
| Arbitrum | 42161 | **0 / 5** |
| OP Mainnet | 10 | **0 / 5** |
| Gnosis Chain | 100 | **5 / 5** |
| Unichain | 130 | **5 / 5** |

Every other Safe-supported chain answers `403 {"message":"No relayer defined"}`.

```
CHAINS WITH A QUOTA: 6   TOTAL CEILING/day: 30   REMAINING AT PROBE TIME: 10
```

**Gnosis and Unichain were untouched.** At ZERO's own settled average of $0.00286/harvest
(`contracts/FINDINGS.md`, 26 on-chain events — inherited, not re-measured tonight), 10 idle slots is
**$0.0286 of capacity that expired unused**, and it expires again every day nobody claims it. That is
larger than ZERO's entire measured lifetime earnings rate per day. It costs nothing to fix.

`reproduce: node p4_saferelay.mjs`

## 2. MEASURED: the quota is per-ADDRESS — so capacity is multipliable

The decisive control. Same endpoint, six different addresses, four chains:

| address | base | gnosis | unichain | polygon |
|---|---|---|---|---|
| **ZERO's Safe** (5 spent on base today) | **0/5** | 5/5 | 5/5 | **0/5** |
| ZERO's EOA *(not a Safe at all)* | 5/5 | 5/5 | 5/5 | 5/5 |
| `0x1234…5678` *(random, never used)* | 5/5 | 5/5 | 5/5 | 5/5 |
| `0x0000…DeaDBeef` *(no code, nonexistent)* | 5/5 | 5/5 | 5/5 | 5/5 |
| an unrelated Safe | 5/5 | 5/5 | 5/5 | 5/5 |
| vitalik.eth EOA | 5/5 | 5/5 | 5/5 | 5/5 |

ZERO's Safe reads `0/5` on Base while **ZERO's own EOA reads 5/5 on the same chain from the same IP in
the same second.** The counter is therefore keyed on the target address — not on the owner, not on the
requesting IP, and not on the address being a deployed Safe.

**Consequence: capacity = 5/chain/day × (number of Safes ZERO controls).** ZERO's EOA can be the sole
owner of all of them, so one key controls the whole fleet.

### What it costs to mint another bucket

`eth_estimateGas` for `SafeProxyFactory.createProxyWithNonce(Safe-1.4.1, setup([ZERO_EOA],1,…), salt)`
sent `from` ZERO's Safe, against live state:

| chain | factory `0x4e1DCf7A…ec67` | singletons | gas | gasPrice measured |
|---|---|---|---|---|
| base | 3054 B | both present | **239,568** | 0.006000 gwei |
| optimism | 3054 B | both present | 239,568 | 0.001000 gwei |
| arbitrum | 3054 B | both present | 239,870 | 0.020146 gwei |
| polygon | 3054 B | both present | 257,348 | 281.65 gwei |
| gnosis | 3054 B | both present | 239,464 | 0.000045 gwei |
| unichain | 3054 B | both present | 239,568 | 0.001500 gwei |

On Base that is 1.4374e-6 ETH ≈ **$0.00268** (at the $1861.94 ETH price recorded in
`contracts/FINDINGS.md` — inherited, not re-measured tonight). It is well under the 576,384-gas
deployment `contracts/deploy-payload.mjs` already judged relay-able, so **ZERO's real cost is one relay
slot** and the relay pays the gas.

**Payback: spend 1 slot once → +5 slots/day forever on that chain. Break-even in under 24 hours.**
With a fixed CREATE2 salt the same Safe address exists on all 6 chains, so one deployment design yields
+30/day per Safe.

### The part I could NOT measure, stated plainly

I verified the **read** path only. Whether the **POST** relay path applies an additional per-IP,
per-owner or per-day limiter that the quota endpoint doesn't expose is **UNMEASURED**, because measuring
it requires spending a slot, which this lane is forbidden to do. Treat item 2 as a strong LEAD with a
measured foundation, not as a settled 60/day. **The next session's first test:** deploy exactly one
extra Safe via one Base slot, then re-read both quotas. One slot buys the answer.

`reproduce: node p15_quota_scope.mjs && node p16_safefactory.mjs`

## 3. MEASURED: open ERC-2771 forwarders — real, and not worth what they look like

### How they were found (no hardcoded list)

An **address-less `eth_getLogs` on topic0** finds every forwarder that actually fired in the window.
`ExecutedForwardRequest(address,uint256,bool)` = `0x842fb24a83793558587a3dab2be7674da4a51d09c5542d6dd354e5d0ea70813c`.
This is discovery, not recall — it cannot miss a forwarder just because nobody blogged about it.

Live in a 2,000-block window, 100% read success:

| chain | forwarders found |
|---|---|
| base | 1 |
| arbitrum | 2 |
| polygon | 7 |
| optimism, gnosis, unichain | 0 |

### The openness test

Submit an **identical, deliberately invalid** request from three unrelated `msg.sender`s. If all three
revert identically, the contract never read `msg.sender` ⇒ any submitter is accepted.

| chain | forwarder | verdict |
|---|---|---|
| base | `0xbaea9e1b5222ab79d7b194de95ff904d7e8ecf80` | **SUBMITTER-AGNOSTIC** |
| arbitrum | `0x5976ee9e504a04a1ec71a4ff4df7309a72d906ad` | **SUBMITTER-AGNOSTIC** |
| polygon | `0xec63c3e7bd0c51aa6dc08f587a2b147a671cf888` | **SUBMITTER-AGNOSTIC** (0 traffic) |
| polygon | `0x8347540a745a4679682c05bc41e09a129cb170bb` | **SUBMITTER-AGNOSTIC** (0 traffic) |

The rest were **proxies** — `0xc2132d05…` (USDT0), `0x1379e888…` (Mysterium), `0xe93183c9…` (Cenoa USD).
Scanning a proxy shell and calling it featureless is the exact mistake `gasless.mjs` warns about; after
resolving the EIP-1967 implementation, USDT0/Polygon exposes `executeMetaTransaction` **and** `permit`,
Mysterium exposes `executeMetaTransaction`.

### The decisive reachability probe on Base

`0xbaea9e1b…`: **220 forwarded requests / 4,000 blocks ≈ 2,376/day**, **140 distinct signers**, one
gas-paying submitter `0x9f1045d983a6ac1faea82fe9314b47de73515d1a` (0.003758 ETH, **207,549 lifetime
txs** — a real, funded, running relayer).

Two targets trust it. Building `execute()` with **`from` = ZERO's EOA**:

```
target 0xe853b16d481bf58fd362d7c165d17b9447ea5527  isTrustedForwarder = true
   execute(from=ZERO) -> ERC2771ForwarderInvalidSigner
   execute(from=anon) -> ERC2771ForwarderInvalidSigner
target 0xeb37d884e0420adf34010f794935f32578b03808  isTrustedForwarder = true
   execute(from=ZERO) -> ERC2771ForwarderInvalidSigner
   execute(from=anon) -> ERC2771ForwarderInvalidSigner
```

Error-code map (computed, not recalled): `0xc845a056 = ERC2771ForwarderInvalidSigner`,
`0xd2650cd1 = ERC2771UntrustfulTarget`.

**Read that carefully: the request got past the target-trust check and died on the signature.** The only
thing between ZERO and a state change on those contracts is an ECDSA signature ZERO can produce for free,
infinitely. No allowlist, no quota, no API key. Arbitrum's `0x5976ee9e…` behaves identically against
`0xe4aebab2cc21b49af4c00d3ed44d11d00237bfb0`.

### Why this is still worth ~nothing today — say it out loud

1. **It is not gas.** The forwarder accepts *any* submitter; it does not *provide* one. `0x9f1045d9…`
   submits what arrives through its dapp's off-chain API, which I did not test (testing = sending).
2. **The target set is the real gate.** ERC-2771 only works against contracts that name *that specific*
   forwarder. Those are two dapp contracts. **Neither pays callers.**

So: capacity added today = **0**. Recorded as MEASURED so nobody re-derives it, and because the
discovery method generalises — if a caller-paying contract is ever found that trusts an open forwarder,
that is an uncapped rail and this is the pipeline that finds it.

`reproduce: node p11_census2.mjs && node p12_openall.mjs && node p14_reach.mjs`

## 4. MEASURED: 0 of 54 live ERC-4337 paymasters are open

Prior art (`gasrouter.mjs`, 2026-07-29) tested Base only. Extended to all six chains. Paymasters
enumerated from `UserOperationEvent` topic3 — i.e. contracts that **provably paid** for someone's gas —
then admission-tested by calling `validatePaymasterUserOp` **as the EntryPoint**, sender = ZERO's Safe.
`validationData == 0` would mean it sponsors an arbitrary account.

| chain | userOps in window | paymasters found | tested | **open** |
|---|---|---|---|---|
| base | 13,610 | 28 | 12 | **0** |
| optimism | 60 | 15 | 12 | **0** |
| arbitrum | 165 | 10 | 10 | **0** |
| polygon | 199 | 9 | 9 | **0** |
| gnosis | 1,522 | 5 | 5 | **0** |
| unichain | 11 | 6 | 6 | **0** |
| **total** | | **73** | **54** | **0** |

Refusals classify as `SIG-GATED` (`validationData` bit0 = 1 → off-chain signer required → API key) or a
custom-error revert. `0xcc32193e` recurs on the `0x777777…`/`0x666666…`/`0x888888…` family and is
**not** in 4byte.directory or a 604-entry generated dictionary — unidentified, but it is a revert, so it
is not open.

`reproduce: node p18b.mjs`

## 5. KILLED: Candide's keyless public paymaster is a per-dapp allowlist

`gasrouter.mjs` flagged Candide as a **TECHNICAL** wall — "public policies exist, ours simply does not
match one; keep varying the op." That annotation should now be downgraded, and here is the evidence.

The endpoint has **two distinct refusal branches**, and telling them apart is the whole measurement:

- `sponsored-validator: callData reverts` — the op wouldn't execute.
- `sponsored-validator: this user operation does not qualify for any publicly available gas policy` — the
  op executes fine; **the policy is what refused.**

Method: pull real, already-mined userOps off Base EntryPoint v0.7 (their callData provably executes),
correct the nonce with a live `getNonce()` read, and submit to
`https://api.candide.dev/public/v3/8453`. Sender `0x19866ea6153Bf968BE9B54583E44b9bccDd8b301` reaches
**branch 2**, so its ops are executable and only the policy stands. Varying the inner target:

| inner target | result |
|---|---|
| self-call | does not qualify |
| WETH `deposit()` | does not qualify |
| USDC `approve(x,0)` | does not qualify |
| **Beefy strategy `harvest(address)`** | **does not qualify** |
| Multicall3 `getBlockNumber()` | does not qualify |
| `0x…0001` no-op | does not qualify |

Six independently executable operations — including **exactly the call ZERO earns from** — all refused
at the policy branch. Candide's public policy is a whitelist of specific dapp contracts. It will not
sponsor generic or profit-bearing calls. **DEAD. Do not re-probe by varying the op.**

`reproduce: node p5_candide.mjs && node p6_candide_replay.mjs && node p6b.mjs && node p6c.mjs`

## 6. KILLED: every other keyless sponsor endpoint is an auth wall

| endpoint | response | wall |
|---|---|---|
| `public.pimlico.io/v2/8453/rpc` | `Sponsorship policy ID is required for this API key` | AUTH |
| `rpc.etherspot.io/v2/8453` | HTTP 401 `Api key not found` | AUTH |
| `arka.etherspot.io` | HTTP 400 `Invalid Api Key` | AUTH |
| `rpc.zerodev.app/api/v2/paymaster/8453` | HTTP 400 `Invalid projectId.` | AUTH |
| `paymaster.particle.network` | `Unsupported chainId` / `Method not found` | dead |
| `base-mainnet.g.alchemy.com/v2/demo` | HTTP 429 | dead |
| `public.stackup.sh/...` | DNS/connect failure | dead |

Gelato 1Balance, Biconomy and OZ Defender were not probed: all three require a funded account, which
`gasless.mjs` already records and no read can change. Gelato's `callWithSyncFee` is separately dead on
arithmetic — the target must pay the relayer in tokens, and a harvest pays $0.005 against a $0.039 gas
leg (`contracts/FINDINGS.md`), so the fee exceeds the payout.

## 7. MEASURED: EIP-7702 is live everywhere ZERO can reach

Evidence per chain: the EIP-2935 history contract `0x0000F90827F1C53a10cb7A02335B175320002935` has code
(Prague/Isthmus shipped), plus direct observation of type-`0x4` transactions.

| chain | EIP-2935 code | type-4 txs / 25 blocks | authorizations |
|---|---|---|---|
| base | 83 B | **49** | 57 |
| polygon | 83 B | **52** | **115** |
| optimism | 83 B | 0 | 0 |
| arbitrum | 133 B | 0 | 0 |
| gnosis | 83 B | 0 | 0 |
| unichain | 83 B | 0 | 0 |

ZERO's EOA `eth_getCode` = `0x` on all six — undelegated, clean.

Polygon's **115 authorizations across 52 transactions (mean 2.2)** is the interesting number: a tx can
only carry >1 authority if the submitter is paying for **other people's** delegations. Third parties
sponsoring strangers' 7702 authorizations is routine, not theoretical.

What this buys ZERO: signing an authorization costs **$0** and no gas; the submitter pays the extra
~25,000 gas (`PER_EMPTY_ACCOUNT_COST`). EntryPoint v0.8 (`0x4337084D…`, code present on all six chains)
accepts a 7702 authorization inside the userOp, so a paymaster could pay for the delegation *and* the
call in one shot — ZERO would never need ETH. **That entire path is blocked by exactly one thing:
finding an open paymaster, and §4 measured 54 of them closed.** Recorded so the next session knows the
7702 leg is ready and the paymaster leg is the bottleneck.

**Caveat, stated:** 0 type-4 txs in a 25-block sample on 4 chains is a small sample, not proof of
non-support. The EIP-2935 code presence is the load-bearing evidence there.

## 8. Conditional rail: token meta-tx (worth nothing until ZERO holds a token)

After proxy-implementation resolution: **USDT0 on Polygon** (`0xc2132d05…`, impl `0x90040487…`) exposes
`executeMetaTransaction` **and** `permit`; **Mysterium (PoS)** (`0x1379e888…`) exposes
`executeMetaTransaction`. Both are submitter-agnostic by construction. The moment ZERO holds either
token, moving it costs ZERO nothing and needs no relay slot. Today ZERO holds neither, so the value is
**$0** — logged as a standing capability, not a finding.

---

## Method note that will save the next session an hour

**Two false zeros fired tonight, both from the same cause.** Public RPCs refuse certain log queries and
return an *error*, and code that treats an error as an empty array reports a confident, wrong zero:

- `*.publicnode.com` refuses **address-less** `eth_getLogs`: *"Please specify an address in your
  request."* → census v1 reported "0 forwarders" on 5 chains. There were 9.
- `*.publicnode.com` refuses **deep ranges** even *with* an address: *"Archive requests require a
  personal token."* → paymaster sweep v1 reported "0 live paymasters" on 5 chains. There were 45.

Endpoints **measured** to serve address-less `eth_getLogs`:

| chain | use |
|---|---|
| base | `mainnet.base.org`, `base.drpc.org` |
| optimism | `mainnet.optimism.io`, `optimism.drpc.org` |
| arbitrum | `arb1.arbitrum.io/rpc`, `arbitrum.drpc.org` |
| polygon | `polygon.drpc.org`, `polygon-bor-rpc.publicnode.com` (≤100-blk windows only) |
| gnosis | `rpc.gnosischain.com` |
| unichain | `mainnet.unichain.org` |

Dead: `base.llamarpc.com` (HTTP 521), `polygon-rpc.com` (HTTP 401, API key disabled).

**Always print `reads_ok` / `reads_failed` next to any count.** A sweep that reports a zero without its
read-success rate is reporting nothing.

## What the next session should do, in order

1. **Free, today, no risk:** spend the idle Gnosis and Unichain slots. 10 slots/day are expiring unused.
2. **One slot, answers the biggest question:** deploy one extra Safe on Base via the relay, then re-read
   both quota endpoints. Confirms or kills the 30 → 60 → 90/day multiplier for the price of one slot.
3. **Do not** re-probe Candide, Pimlico, Etherspot, ZeroDev, or Gelato — all killed above with the
   exact refusal text.
4. **Re-run the forwarder census** whenever a new caller-paying contract is found: the question worth
   asking is not "is there an open forwarder" (yes, 4) but "does any contract that pays callers trust
   one".

## Files

- `knowledge/streams/meta-tx-rails.md` — this document
- `knowledge/streams/meta-tx-rails.json` — machine-readable rows
- probes (scratchpad, read-only): `p1_7702 · p2_paymasters · p3_pmgate · p4_saferelay · p5_candide ·
  p6_candide_replay · p6b · p6c · p7_fwd_discover · p8_fwd_open · p9_fwd_targets · p10_census ·
  p11_census2 · p12_openall · p13_impl · p14_reach · p15_quota_scope · p16_safefactory · p17_misc · p18b`
