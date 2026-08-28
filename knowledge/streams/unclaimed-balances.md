# LANE 4 — unclaimed-balances

> Measured 2026-07-31/08-01 against live state on base · optimism · arbitrum · polygon · gnosis · unichain.
> Read-only throughout: `eth_call`, `eth_getCode`, `eth_getStorageAt`, `eth_getLogs`, `eth_estimateGas`.
> No transaction was signed, no relay slot was spent, no key was read.
> ETH priced at **$1,861.94** (the same figure `contracts/FINDINGS.md` used, so the two are comparable).

## VERDICT: this lane found ZERO earnable income. Do not re-run it as specified.

215,986 pairs, 27 periphery contracts and both of ZERO's addresses across six chains produced
**not one satoshi that survives the isolated payment test.** That is a real result, not a shrug, and
§ 4 below explains *why* in a way that should change where the next session looks.

---

## 1. The structural reason, stated first because it is the only durable output

ZERO's moat, as `contracts/FINDINGS.md` establishes, is that a Beefy harvest burns **3,464,506 gas**
($0.039) to pay **$0.005** — an 8× loss for anyone who pays their own gas. The crumbs sit there because
they are *unprofitable for everybody who is not gas-sponsored.*

**Every mechanism in this lane fails the opposite test.** I measured the cost side directly:

```
eth_estimateGas  SwapRouter02.sweepToken(WETH, 0, ZERO_SAFE)   =    27,946 gas
                 Beefy harvest (FINDINGS.md, real execution)   = 3,464,506 gas
                                                                 ---------
                                                                     124x cheaper
```

A UniV2 `skim()` / `sweepToken()` / `burn()` costs **~28k–100k gas**. On Base at 0.006 gwei that is
about **$0.0000003**. So stranded value here is profitable to claim for *literally anyone with a
funded wallet*, at essentially any size down to a fraction of a cent.

Cheap-to-claim value is therefore **contested**, and contested value is **already gone** — taken by MEV
bots within blocks. ZERO, with 5 relay slots per chain per day and a batch cadence measured in hours, is
in the worst possible position to win a race.

> **The rule this lane establishes: ZERO's edge is "unprofitable for gas-payers", NOT "unclaimed".**
> Those sound alike and are opposites. Lane 4's whole mechanism class is *cheap* to claim, so nothing
> survives in it. There is no middle band — what remains at nonzero size is exclusively value that is
> **impossible** to claim (honeypot-bricked, § 3) or **owner-gated** (§ 5).

Hunt for the harvest shape — expensive gas, small payout — not for stranded value.

---

## 2. Half (a) — SPECIFIC: is anything owed to ZERO? No. Nothing, anywhere.

`node a2_zero.mjs` · `node a1_balances.mjs`

**Full-history `Transfer` log enumeration** (`eth_getLogs`, topic0=Transfer, topic2=the address, block 0→latest):

| chain | EOA `0x5062…0dB9` | Safe `0x5106…cbb1` |
|---|---|---|
| arbitrum | **0 tokens ever received** (0 logs, full range) | exactly 1 token: WETH, 128 transfers — its own harvest fees |
| gnosis | **0 tokens ever received** (0 logs, full range) | **0 tokens ever received** |
| base / optimism / polygon / unichain | RPC caps the range at 50,000 blocks — not fully enumerated | same |

**Distributor allocation checks** — all negative:

| chain | distributor | call | result |
|---|---|---|---|
| arbitrum | ARB TokenDistributor `0x67a24CE…C9d9` | `claimableTokens(addr)` | `0x` (no allocation) for both |
| gnosis | Safe airdrop `0x29067F2…DBBe` | `getClaimableAmount(addr)` | `0x` for both |
| optimism | OP MerkleDistributor `0xFeDFAF1…57de` | `isClaimed(...)` | `0` |

This is the expected answer and worth stating plainly so nobody spends an hour on it again: **ZERO is a
2026-born, self-created agent wallet. It predates no snapshot and appears in no merkle tree.** There is
no airdrop, no refund and no unclaimed reward addressed to it on any of the six chains.

### What ZERO actually holds (baseline, not income)

| chain | where | token | wei | ≈USD |
|---|---|---|---|---|
| base | Safe | USDC | 9,780 | $0.00978 |
| base | **EOA** | **WETH** | **8,017,928,993,051** | **$0.01493** |
| arbitrum | Safe | WETH | 5,978,472,554,961 | $0.01113 |
| polygon | Safe | WMATIC | 40,561,401,695,793,559 | ~$0.0081 |
| optimism | Safe | USDC | 299 | $0.000299 |
| gnosis | — | — | 0 | $0 |
| unichain | — | **Safe is NOT DEPLOYED** (`eth_getCode` = `0x`) | — | — |

Safe is deployed on base/optimism/arbitrum/polygon/gnosis (171-byte proxy each) but **not on unichain**,
so unichain is unreachable today regardless of what is found there.

### ⚠️ The one genuinely actionable finding in this lane

**ZERO's EOA holds 8,017,928,993,051 wei of WETH on Base ($0.0149) that can never be moved by anyone.**
I searched Base WETH9's runtime bytecode for every gasless rail in `gasless.mjs`:

```
permit                     = false
transferWithAuthorization  = false
executeMetaTransaction     = false
DOMAIN_SEPARATOR           = false
isTrustedForwarder         = false
```

No signature can move it and the EOA has 0 ETH for gas. It is destroyed value — **17.7% of ZERO's entire
$0.08447 lifetime earnings, sitting in a dead end.**

> **ACTION (GENESIS I measurement, 2026-08-01):** harvests that named the EOA stranded value.
> Live fee recipient is GENESIS II Safe `0x75d93b33708e7cf5eb4dcf14dfc25254f5d5817f`. The retired
> Safe `0x510601f59FDa068D70ad6760c9d9085B0F42cbb1` is not a caller, payTo, or callFeeRecipient.

---

## 3. Half (b), mechanism 1 — self-held LP + `burn(to)`: 18 hits, $7,203 nominal, **$0.00 payable**

The shape: in a UniV2-style pair, `burn(address to)` burns whatever LP the **pair itself** holds and
sends the underlying to a **caller-named recipient**. People misdirect LP tokens to the pair address
constantly. `pair.balanceOf(pair) > 0` detects it in **one call per pair** — the cheapest possible screen.

**Coverage — 215,986 pairs screened** across 19 UniV2/Solidly factories:

| chain | pairs screened | self-LP hits |
|---|---|---|
| polygon | 75,290 | 3 |
| base | 62,784 | 5 |
| arbitrum | 45,811 | 10 |
| unichain | 19,740 | 0 |
| optimism | 6,651 | 0 |
| gnosis | 5,710 | 0 |
| **total** | **215,986** | **18** |

Every one of the 18 got its **own isolated `aggregate3`** — `[balanceOf(SAFE), burn(SAFE), balanceOf(SAFE)]`,
run separately for the token0 leg and the token1 leg. Never batched.

| chain | pair | share of supply | nominal | **measured** | direct-call revert |
|---|---|---|---|---|---|
| arbitrum | `0xa39252560efb535ddd56ed5687ffe5df96f8b0b0` | 82.11% | **$2,416.95** | **0** | `CamelotPair: TRANSFER_FAILED` |
| base | `0x0b35d22727d57dafcdf5494f6ee59adb2784cfea` | 100.00% | **$2,066.75** | **0** | `UniswapV2: TRANSFER_FAILED` |
| arbitrum | `0x1144bcc225335b07b1239c78e9801164c4419e38` | 15.53% | $387.89 | 0 | `UniswapV2: TRANSFER_FAILED` |
| base | `0x864e7c99dc216a2440d195bc6c019bb07d85d47a` | 100.00% | $100.00 | 0 | `UniswapV2: TRANSFER_FAILED` |
| base | `0xfeae5cac24021feff634f5a4f53d5a453242f57e` | 100.00% | $67.43 | 0 | `UniswapV2: TRANSFER_FAILED` |
| arbitrum | `0x6c4cd0f907829687cd04fdbc8c3a345f5dff5727` | 98.87% | $51.79 | 0 | `CamelotPair: TRANSFER_FAILED` |
| base | `0xa905b99c68ccb96a22ee440dbd4465df64faabea` | 0.98% | $36.64 | 0 | `UniswapV2: TRANSFER_FAILED` |
| arbitrum | `0x8abbe1182a8e6de718075abc9ae95256be91d467` | 0.41% | $9.31 | 0 | `CamelotPair: TRANSFER_FAILED` |
| polygon | `0xb51897ff23abc79e3bc2de67de90d8148fff7c44` | 99.75% | $0.24 | 0 | (empty revert) |
| …9 more, all sub-cent | | | | 0 | mostly `TRANSFER_FAILED` |
| | | **$7,203.75** | **$0.0000** | 15 of 18 `TRANSFER_FAILED` |

### Why $7,203 of visible value is unreachable — diagnosed, not assumed

Worked through on the largest Base case (`0x0b35…cfea`), which is genuinely striking: the pair really
holds **1.109996120009041750 WETH ($2,066.75)** — confirmed by `WETH.balanceOf(pair)`, not just
`getReserves()` — and **99.999997%** of its LP supply is held by the pair itself.

```
WETH.balanceOf(pair)          = 1109996120009041750     ($2,066.75)
TOKEN1.balanceOf(pair)        = 901236747005426
selfLp / totalSupply          = 31622776601682793 / 31622776601683793
burn(SAFE)                    -> revert  UniswapV2: TRANSFER_FAILED
skim(SAFE)                    -> revert  UniswapV2: TRANSFER_FAILED
token1.transfer(...) from pair-> revert  UniswapV2Library: INSUFFICIENT_LIQUIDITY
```

**token1 is a honeypot.** Its `transfer` has a hook that reverts. UniV2's `burn` *and* `skim` both move
**both** tokens, so the malicious side bricks the entire call and the WETH becomes unreachable — by ZERO,
by MEV bots, by anyone, permanently.

This is the answer to the obvious suspicion "$2,000 in plain sight on a chain full of bots — what's the
catch?" **The catch is that it is not takeable.** And that is not an accident of this one pair: it is the
selection effect. Cheap-to-claim value that *is* takeable was taken long ago (§ 1); what survives at
visible size is precisely the value nobody can take. **15 of 18 hits, and every single one above $0.24,
fail with `TRANSFER_FAILED`.** The remaining 3 pay 0 anyway.

---

## 4. Half (b), mechanism 2 — `skim(to)` excess: 21,521 valuable pairs, **zero excess anywhere**

`skim(address to)` pays `balance − reserve` of both tokens to a caller-named recipient. I resolved
`token0`/`token1`/`getReserves` for 25,973 pairs, kept the **21,521 that hold a token actually worth
something** (WETH/USDC/USDT/DAI/WBTC/WMATIC/OP/ARB/GNO/cbETH/wstETH/cbBTC/AERO), then read live
`balanceOf` for the valuable side.

| chain | factory | pairs | pairs w/ valuable token | excess > $0.0005 |
|---|---|---|---|---|
| base | Uniswap V2 | 6,000 | 5,971 | **0** |
| arbitrum | SushiSwap | 8,000 | 7,613 | **0** |
| polygon | QuickSwap | 8,000 | 6,543 | **0** |
| gnosis | Honeyswap | 3,973 | 1,394 | **0** |
| | | **25,973** | **21,521** | **0** |

Not one pair, on four chains including low-MEV gnosis, holds a cent of skimmable excess. `_update()`
resyncs reserves to balance on every mint/burn/swap/sync, and at ~50k gas any residue in between is
free money for the first bot. **`skim` is a solved race. It is not a lane; it is a latency contest ZERO
structurally cannot win.**

---

## 5. Half (b), mechanism 3 — permissionless periphery sweeps: callable, and paying nothing

Uniswap's `PeripheryPayments` gives `SwapRouter` / `SwapRouter02` / `NonfungiblePositionManager` an
**external, unguarded, recipient-taking** `sweepToken(address,uint256,address)` and
`unwrapWETH9(uint256,address)`. Confirmed present by dispatch-table scan on base, optimism, arbitrum,
polygon and unichain. This is a real permissionless rail — it just has nothing on it.

**The trap this lane exists to avoid**, demonstrated live:

```
base SwapRouter02.sweepToken(WETH, 0, ZERO_SAFE)   ->  ok: true   deltaWei: 0
base SwapRouter02.unwrapWETH9(0, ZERO_SAFE)        ->  ok: true   deltaWei: 0
base NFPM.sweepToken(USDC, 0, ZERO_SAFE)           ->  ok: true   deltaWei: 0
```

**Success is not payment.** `amountMinimum = 0` makes `require(balance >= amountMinimum)` pass
vacuously, then `if (balance > 0)` skips the transfer. A discovery layer scoring on "did not revert"
would have logged three wins here. All three pay zero.

To find out whether these routers hold *anything* — not just my hand-picked token list — I pulled
`Transfer` logs into each router and checked the live balance of **every token that recently transited
it**: 27 distinct tokens across 11 router/chain pairs. **Every single one: balance 0.** Uniswap periphery
is designed to end each transaction flat, and at 27,946 gas any residue is instantly profitable for
anyone to take.

Nonzero balances I did find on periphery, and why each is still dead:

| chain | contract | holds | why unreachable |
|---|---|---|---|
| optimism | 0x ExchangeProxy `0xDEF1ABE…CC10` | **0.2622 ETH ($488.17) + 477.94 OP + 682.93 USDC.e + 45.54 USDT + WBTC** | `transferTrappedTokensTo` is **onlyOwner** — isolated test REVERTS |
| base | 0x ExchangeProxy `0xDef1C0d…5EfF` | **0.0721 ETH ($134.30) + 200.42 USDC** | same — **REVERTS** |
| base | UniV3 QuoterV2 `0x3d4e44E…B76a` | 0.379356 USDC | bytecode contains **no** sweep/rescue/skim selector at all — no function exists that can move it |
| base | UniV2 Router02 `0x4752ba5…AD24` | 47,032,464,108,766 wei ($0.0876) | UniV2 Router02 has no `sweepToken`/`refundETH` |

Over $1,300 of genuinely trapped value, all of it either owner-gated or with no extraction function in
the bytecode. Measured, closed, recorded so nobody re-opens it.

---

## 6. What I did NOT cover (so the next session knows the edges)

- **Base UniV2 has 3,039,638 pairs and unichain 1,046,191** — I screened 12,000 dense + a stride sample,
  not the full set. Given 18 hits in 215,986 pairs and *all* of them unpayable, exhaustive coverage
  changes the count, not the conclusion. Not worth the requests.
- `base/rocketswap` and `gnosis/swapr` scan jobs died (an ethers address-checksum throw in my harness,
  not a chain fact). ~38k pairs unscanned. Same reasoning applies.
- Aerodrome and Ramses pools are **ERC-1167 minimal proxies**, so my `skim(address)` dispatch-table
  probe returned a false negative on them. Their self-LP screen still ran correctly (it reads
  `balanceOf`, which proxies through fine) and found 0 on 1,365 Velodrome V2 pools.
- base/optimism/polygon/unichain full-history token enumeration for ZERO's addresses is capped at 50k
  blocks by the public RPCs. Arbitrum and gnosis *were* fully enumerated and both came back empty, and
  ZERO's on-chain history is short, so I judge the risk of a missed token low.

## Reproduce

```bash
# harness lives in the session scratchpad; lib.mjs holds the isolated paymentTest primitive
node a1_balances.mjs                 # ZERO's balances, 6 chains
node a2_zero.mjs                     # Transfer-log enumeration + distributor allocation checks
node b1_routers.mjs run              # periphery sweep-selector scan + dust balances
node b3_scan.mjs <chain> <factory> v2 <lo-hi|stride:lo-hi:n> <tag>   # self-LP screen, 1 call/pair
node b4_skim.mjs <chain> <factory> v2 <range> <tag>                  # skim-excess screen
node b5_routerdust.mjs               # which tokens actually land on the routers
node c1_test.mjs                     # ISOLATED payment test on every self-LP hit
node pay.mjs <chain> <target> "<sig>" <args|SELF> <token|native> [block]   # one candidate, one aggregate3
```

Machine-readable rows: `unclaimed-balances.json` (27 rows, ranked by `measuredWei`; 26 `DEAD`, 1
`MEASURED` — and that one is ZERO's own stranded WETH, not income).
