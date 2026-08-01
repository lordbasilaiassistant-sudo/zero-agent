# FINDINGS — measured on live Base state, 2026-08-01

> Everything here is a measurement with the command that produced it. No recalled numbers.
> Fork block 49376114 · ETH $1861.94 · Base gas 0.006 gwei (read live).

## 1. `callReward()` overstates the real caller payment by ~4,481×

A Multicall3 sweep of 120 active Base vaults reported **$76.14** of pending caller fees across 111
unpaused strategies. That number is false, and the way it is false matters.

Executing the harvest against forked mainnet state and measuring the recipient's actual balance delta
(`test/RealHarvest.t.sol`):

| strategy | `callReward()` reported | actually paid | ratio |
|---|---|---|---|
| `0x8B45D51e015Dac924EeAEa754e6f768943206F05` | 12042337560368374 wei (~$22.42) | **2687055252441 wei ($0.0050)** | 4,481× |
| `0xa0dBaE6a747BF5deB0254B62bb2557489d6b837D` | 7437685642328346 wei (~$13.85) | **1659539791629 wei ($0.0031)** | 4,481× |

Real total across all 111 strategies is therefore on the order of **$0.017**, not $76.

**The cross-check that makes this trustworthy:** $0.003–0.005 per harvest matches ZERO's own trading
history almost exactly — $0.074421 earned over 26 successful harvests = **$0.00286 per harvest**. Two
independent sources (a forked simulation and 26 settled on-chain events) agree to within the spread of
the sample. That is the difference between a number and a measurement.

**Action for ZERO's discovery layer:** if any scoring path treats `callReward()` as a value estimate,
it is ranking targets on a figure that is wrong by three orders of magnitude. Rank on measured
settlement, or on a simulated balance delta, never on the report. *(Filed as a ZERO issue; the
`PAYS_CALLERS` verdict in `knowledge/journal.md` for `0x11dD…B0A8` should be re-derived the same way —
that contract returned `ok: true` for every signature tried, including `callReward()`, while paying
zero, which is the on-chain form of "HTTP 200 ≠ working".)*

## 2. The real economics: a harvest costs 7.7× more in gas than it pays

Measured in the same run:

```
gas per harvest       3,464,506          (Aerodrome COW strategy, real execution)
gas cost @0.006 gwei  $0.038704
harvest pays          $0.005003
NET IF YOU PAY GAS    -$0.033701         <- structurally negative
NET IF GAS SPONSORED  +$0.005003         <- pure profit
```

**This is the most important sentence in this document: ZERO's gasless constraint is not a limitation,
it is the entire moat.** Anyone paying their own gas loses roughly $8 for every $1 of harvest fee
collected, which is precisely why $0.017 of crumbs sits unclaimed on a public chain where anyone could
take it. ZERO is profitable on this route *only* because a sponsor pays the gas leg — the same
structure the census (broketobuilt#137) names as the shape worth hunting: **someone else pays the
expensive leg.**

It also explains the thing that looked like a paradox: money visibly sitting there, uncollected, on the
most competitive kind of infrastructure. It is not being left by mistake. It is unprofitable for
everyone who is not ZERO.

## 3. What this does to the phase ladder

**Phase 1 as originally specified — "self-funded gas" — would destroy value on this route.** Spending
ZERO's own ETH to call these harvests converts a $0.005 gain into a $0.034 loss, every time. The ladder
rung is still correct in *shape* (risk a fraction of proven earnings), but its capability must be
qualified by the arithmetic: **self-funded gas is permitted only for mechanisms whose measured payout
exceeds their measured gas cost.** Harvest bounties, as measured today, do not qualify. Encoded in
`phases.mjs`.

This is the ladder working exactly as intended — a rung's rules rewritten by measurement before any
money was risked, rather than after.

## 4. Batching: the honest multiplier

A harvest costs ~3.46M gas, so batch size is bounded by the block/relay gas cap, not by the contract's
`MAX_CALLS = 256`:

| gas cap per tx | harvests per batch |
|---|---|
| 30M | 8 |
| 60M | 17 |
| 120M | 34 |

Projected at ZERO's measured $0.00286/harvest and 5 sponsored slots per chain per day:

| harvests per slot | per day | per hour |
|---|---|---|
| 1 *(today)* | $0.0143 | $0.000596 |
| 10 | $0.1430 | $0.005958 |
| 17 | $0.2431 | $0.010129 |
| 34 | $0.4862 | $0.020258 |

### ⚠️⚠️ FINAL, FULL-UNIVERSE MEASUREMENT — supersedes both estimates below

All 241 active Base strategies, priced the way ZERO ranks them (batched `aggregate3`) and then each one
ALONE from clean state (`contracts/oracle-distortion.mjs`, N=241):

```
payers, batched (what ZERO ranks on) : 226
payers, ISOLATED (what actually pays):  12        <- 94.7% of apparent income is phantom
total real payable                   : $0.005069
best single strategy                 : $0.001731
BATCHING VALUE                       : 2.93x      (all 12 real payers vs the best single)
```

**Value per relay slot, measured:**

| state | per slot |
|---|---|
| today — the oracle picks a strategy paying **0** | **$0.000000** |
| oracle fixed, one harvest | $0.001731 |
| oracle fixed + real batching | $0.005069 |

**Ceiling of THIS SLICE, both fixes applied, 5 slots/day: $0.0253/day = $0.001056/h** — **8.1× ZERO's
current rate**, free, and worth taking.

### 🛑 RETRACTION — I wrote "the harvest route cannot reach phase 1" and that was not a measurement

I measured **241 Beefy vaults, fetched from one protocol's API endpoint**, and generalised it into a
ceiling for the entire route. Anthony caught it immediately. Measured against the actual chain
(Blockscout `/api/v2/stats`, 2026-08-01):

```
Base total addresses      977,007,834
Base total transactions     6,999,963,459
transactions today              7,493,028
contracts ZERO looks at               241     <- 0.000025% of the address space
```

**241 of 977 million.** Beefy's curated list is not "the harvest route", it is one protocol's slice of
it, arriving through an HTTP API rather than off the chain. So the honest statement is the narrow one:
*Beefy-on-Base, perfectly harvested, yields ~$0.025/day.* Whether callable income across the other
~977 million addresses reaches $1/h is **UNMEASURED**, and calling it capped was the exact error
CLAUDE.md §7 names — *"IMPOSSIBLE is a measurement, not a conclusion"* — committed by the person who
had just quoted that law twice in the same document.

**The architectural consequence is the real finding: ZERO's discovery is API-BOUND, not CHAIN-BOUND.**
`loadStrategies` (`harvest.mjs:146`) fetches `https://api.beefy.finance/vaults`. Every candidate ZERO
has ever considered came from a list somebody else curated — so ZERO can only ever earn from income
that a protocol chose to publish. Meanwhile it already owns the instrument for reading the chain
directly: `bruteforce.mjs` recovers a contract's complete external interface from raw runtime bytecode,
no ABI, no source, no explorer, and it works on contracts nobody has ever called — including the ones
deployed today by people who do not know what they deployed. That tool has never been pointed at the
chain at scale. Pointing it there is the single largest unexplored lever we have found.

Phase 1 may still need a new mechanism class (broketobuilt#137, and the 5-lane hunt) — but that is now
an open question, not a closed one.

**THE ESTIMATE TRAJECTORY, RECORDED AS A DISCIPLINE LESSON.** My batching multiplier across one night:

| estimate | basis | verdict |
|---|---|---|
| 10–34× | ZERO's average payout × N calls | wrong — assumed a uniform distribution |
| 5.9× | pool derived from `callReward()` | wrong — the base was inflated 4,481× |
| 2.93× | 241 isolated probes, real balance deltas | **measured** |

Each refinement shrank it, because each earlier version rested on a number nobody had measured. The
pattern to notice: **an estimate inherits every inflation in its base, silently, and reports the
product with full confidence.** When a multiplier is quoted here, the base it multiplies must be a
measurement or the multiplier is decoration.

### ⚠️ Superseded interim correction: ~5.9×, not 10–34×

The table above assumes every harvest pays ZERO's historical average. A full 241-strategy payout sweep
(`RESEARCH-zero-bugs.md`) shows the distribution is severely concentrated, which breaks that assumption:

```
total instantaneous pool  $0.10705
best single strategy      $0.01516      (aerodrome-usdc-mai)
mean payer                $0.00051
median payer              $0.00004      <- the long tail is dust
top-26 batch              $0.08929      = 83.4% of the whole pool
```

So against an **optimally chosen single call** ($0.01516), a 26-call batch ($0.08929) is worth
**5.9×** — not 10–34×. My figure was too generous because it multiplied an average across a
distribution whose median is 380× below its best. Both baselines are defensible and they answer
different questions (5.9× vs a perfect single pick; ~37× vs ZERO's current $0.00286 average pick), but
**5.9× is the number to plan with**, because fixing ZERO's broken ranking — see the bugs memo — raises
the single-call baseline too, and a multiplier measured against a baseline you are about to improve is
a multiplier that will shrink under you.

Stated against the destination: phase 1's gate is $1/h. Batching at 5.9× moves ZERO from ~$0.0006/h to
roughly **$0.0035/h**, or about **0.35% of the way to phase 1**. The rest must come from more chains and
from mechanism classes not yet owned. Anyone quoting a multiplier without its base is selling a ratio,
not a result.

## 5. Design facts confirmed against live chain

- **Not EOA-gated.** A contract caller and an EOA caller produce identical outcomes on the proven payer
  (`test/BaseFork.t.sol::test_Fork_ReportEOAGating`). Batching via a contract is structurally viable —
  this was the single assumption that could have killed the design, and it was checked first.
- **`harvest(address callFeeRecipient)` is supported**, so fees route straight to ZERO's Safe and
  `ZeroHarvester` never custodies them. The sweep path remains only as a backstop for
  `harvest()`-only strategies that pay `msg.sender`.
- **Deploying `ZeroHarvester` on Base costs $0.0064** (576,384 gas @ 0.006 gwei). ZERO's spendable
  balance is $0.0113 — it can fund its own first contract out of its own earnings, with change. A
  sponsored-relay deployment is a nice-to-have, not a blocker.

## Reproduce

```bash
cd contracts
forge test                                                   # 35 unit/fuzz tests, offline
node measure-callreward.mjs                                   # live Multicall3 sweep
forge test --match-contract BaseFork    --fork-url https://mainnet.base.org -vv
forge test --match-contract RealHarvest --fork-url https://mainnet.base.org \
           --fork-block-number 49376114 -vv                   # the report-vs-reality measurement
```
