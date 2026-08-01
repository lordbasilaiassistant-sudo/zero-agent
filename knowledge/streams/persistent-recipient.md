# LANE 2 — persistent-recipient — measured 2026-08-01

Hunt: functions where ZERO sets itself as a recipient ONCE and other people's transactions credit it
forever (`setFeeRecipient` / `setRecipient` / `setReferrer` / `register(address)` / `setFeeTo` …), with
someone else paying every gas leg.

## TL;DR — honest verdict: NOTHING in this lane survives the payment test. Zero measured wei.

The persistent-recipient shape is structurally the highest-value one in `gasless.mjs`, and it is also the
one that **cannot produce a positive isolated-delta payment proof from a read-only simulation**, for a
reason worth stating once:

- The mandatory payment test is `aggregate3[ balanceOf(X), <call>, balanceOf(X) ]` showing a strictly
  positive delta to X. For a persistent recipient, the call that credits X is **a third party's**
  transaction (a swap, a deposit, a trade that names X). To simulate that inside one `eth_call` I would
  have to supply the third party's input tokens — Multicall3 holds none, so any such swap reverts. A
  persistent recipient earns from *flow it does not itself originate*; there is no self-contained call
  that mints it income. So "MEASURED" is only reachable here in one narrow sub-case: **an OPEN
  recipient-setter on a contract with ALREADY-accrued fees plus a permissionless push**, i.e.
  `aggregate3[ bal(SAFE), setRecipient(SAFE), pushAccruedFees(), bal(SAFE) ]`. That requires the setter
  to be un-gated. **I found no such open setter on any live fee-generating contract tested.**

Everything below is therefore LEAD (a real primitive that only pays with distribution ZERO doesn't have)
or DEAD (owner-gated, proven by revert). Both are worth recording so the next session skips the hour.

## The one genuine OPEN primitive: GMX ReferralStorage `registerCode(bytes32)` — LEAD, not income

`0xe6fab3F0c7199b0d34d7FbE83394fc0e0D06e99d` on Arbitrum (block 489814087). Bytecode selector recovery
recovered its full interface (23 selectors); the referral registry is real and un-gated:

- `registerCode(bytes32)` simulated **FROM ZERO's Safe → no revert (CALLABLE)**. `codeOwners(code)` for a
  fresh code reads `0x0000…0000` (unowned/available). So ZERO genuinely *can* own a referral code forever:
  set-once, `codeOwners[code] = Safe` permanently, and every trader who later types that code credits
  ZERO's tier rebate. This is the textbook persistent-recipient shape and it is OPEN.
- **Why it is a LEAD, not a finding:** (1) the rebate is **settled off-chain** by a GMX keeper/distributor,
  not by any single on-chain call I can simulate — so it can never yield an isolated positive `balanceOf`
  delta; the payment test is structurally unsatisfiable. (2) Income requires **other traders to
  voluntarily use ZERO's code**, which is distribution ZERO does not have (no audience — the firewall).
  An unused code pays exactly $0, and there is no on-chain mechanism to *force* traders onto it.
- **Free option worth taking once:** registering a code costs one relay slot and creates a permanent,
  free, non-custodial claim. If any future ZERO surface ever routes GMX trades, the code is already owned.
  It is not income tonight and must not be reported as such.

Same registry pattern exists on other perps (MUX, gTrade/gains, HMX, Vela); all share the same wall —
un-gated to register, but payout depends on others choosing your code. Not worth probing further until
ZERO has a channel that can place a code in front of traders.

## DEAD — every protocol fee-recipient setter tested is owner-gated (proven by revert)

Simulated each setter **from ZERO's Safe**; a revert = owner-gated = ZERO can never set it.

| chain | contract | setter | result from Safe |
|---|---|---|---|
| base | Aerodrome PoolFactory `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` | `setFeeManager(address)` | reverts |
| base | Uniswap V2 Factory `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6` | `setFeeTo` / `setFeeToSetter` | reverts `UniswapV2: FORBIDDEN` |
| base | SwapBased Factory `0x71524B4f93c58fcbF659783284E38825f0622859` | `setFeeTo` / `setFeeToSetter` | reverts |
| arbitrum | SushiSwap V2 Factory `0xc35DADB65012eC5796536bD9864eD8773aBc74C4` | `setFeeTo` / `setFeeToSetter` | reverts `UniswapV2: FORBIDDEN` |
| arbitrum | Camelot V2 Factory `0x6EcCab422D763aC031210895C81787E87B43A652` | `setFeeTo(address)` | reverts `CamelotFactory: caller is not the owner` |
| optimism | Velodrome V2 PoolFactory `0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a` | `setFeeManager(address)` | reverts |
| polygon | QuickSwap Factory `0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32` | `setFeeTo` / `setFeeToSetter` | reverts `UniswapV2: FORBIDDEN` |
| polygon | SushiSwap V2 Factory `0xc35DADB65012eC5796536bD9864eD8773aBc74C4` | `setFeeTo` / `setFeeToSetter` | reverts `UniswapV2: FORBIDDEN` |
| gnosis | Honeyswap Factory `0xA818b4F111Ccac7AA31D0BCc0806d64F2E0737D7` | `setFeeTo` / `setFeeToSetter` | reverts `UniswapV2: FORBIDDEN` |

The UniswapV2 fork family (Sushi/Quick/Honey/SwapBased) all gate `setFeeTo` behind `feeToSetter`, which is
a governance EOA/multisig — this is a whole *class* that is permanently closed. Uniswap V3 factories
(`0x1F98431c8aD98523631AE4a59f267346ea31F984` on arb/op/poly; `0x33128…FDfD` on base) and Sushi V2 on base
expose **no** recipient-setter selectors at all.

## DEAD — no open recipient-setter on ZERO's own live-fee universe (45 Beefy Base strategies)

Resolved `strategy()` for 45 active Beefy Base vaults and scanned each strategy's bytecode (proxy + impl)
for all 32 recipient-setter shapes. **0 open-setter hits, 0 RPC errors** (via `base-rpc.publicnode.com`).
Beefy strategies expose `setBeefyFeeRecipient` / `setStrategist`-type setters but all are
`onlyOwner`/`onlyManager`; none is settable by an arbitrary address. This is the exact universe ZERO
already harvests, so the negative is high-confidence for that class.

## DEAD by shape — DEX-aggregator referral parameters are per-tx, not persistent

1inch AggregationRouter, 0x/Matcha, Paraswap, KyberSwap, OpenOcean all take the referrer/affiliate as a
**calldata argument on each swap**, chosen by the swapper — there is no stored setter ZERO can claim, and
the fee only routes to ZERO if a stranger both names ZERO's address AND funds the swap. No contract to
own, no passive credit. Not probed further; recorded so it is not re-chased as "persistent".

## What would change the verdict (for the next session)

The only MEASURABLE win in this lane is the narrow sub-case above: an **un-gated** `setRecipient`/
`setFeeRecipient` on a contract that has **already accrued fees** and exposes a **permissionless push**
(`distributeFees()`/`skim()`/`collect()`), letting one isolated `aggregate3[bal, setRecipient(SAFE),
push(), bal]` show a positive delta. That is a misconfiguration-bug hunt across a *large* universe of
small/unverified fee contracts — not the blue-chip set, which is uniformly gated. Feed such a universe to
`settersPresent()` → filter to `callable-from-Safe` → then attempt the chained-capture payment test. My
blue-chip + own-universe sweep found none; the hunt has to move down-market to have any chance.

## Reproduce

```bash
cd knowledge/streams
node _pr_run.mjs      # blue-chip factory setters, simulated from Safe (DEAD table)
node _pr_gmx.mjs      # GMX ReferralStorage interface + registerCode callability (LEAD)
node _pr_beefy.mjs    # 45 Beefy Base strategies scanned for open setters (0 hits)
```
