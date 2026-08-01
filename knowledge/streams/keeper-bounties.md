# LANE 1 — KEEPER / AUTOMATION BOUNTIES BEYOND BEEFY

Measured 2026-07-31/08-01 against live state on base · optimism · arbitrum · polygon · gnosis.
Every number below is an `eth_call` I ran. Read-only throughout: no signature, no transaction, no
relay slot, no key touched.

Prices read on-chain from Chainlink at measurement time, not recalled:
`ETH/USD $1864.60` (base feed `0x7104…Bb70`) · `ETH/USD $1864.79` (op) · `AERO/USD $0.41824` ·
`VELO/USD $0.0172866` · `POL/USD $0.071453`.

---

## TL;DR

**Of every non-Beefy keeper family I could reach, exactly zero pay ZERO's Safe.** Aura is shut down on
all five chains, Ajna pays nothing, Aave needs capital, Compound pays points, Aerodrome's Voter pays
nothing. The one genuinely new bounty family I found — Tarot-shape `reinvest()`, 2% bounty, real money
on the table — is guarded by `msg.sender == tx.origin` and is therefore **structurally unreachable by a
relayed Safe, forever**.

The lane's value is three things it found on the way:

1. **$0.0351 of instantaneous, reachable, gas-sponsored income on optimism + arbitrum that ZERO is not
   collecting**, because ZERO only works Base. Same mechanism, same call, three chains it never visits.
2. **`callReward()` returns 0 for six whole platform families that do pay** — 10.4% of Base's pool is
   invisible to any callReward-based ranking. Combined with the already-known 4,481× overstatement,
   that getter is now wrong in *both* directions and should be deleted from every scoring path.
3. **A probe blind-spot in ZERO's own tooling**: probing through Multicall3 without setting `from`
   makes every `tx.origin`-guarded function read as "permissioned". Fixing it revealed six paying
   contracts nobody had seen — and then correctly classified all six as unreachable.

---

## 1. What actually pays, and where

One isolated `aggregate3` per strategy — `[balanceOf(Safe), harvest(Safe), balanceOf(Safe)]` — never
more than one candidate call per batch.

| chain | block | payers / probed | pool (wei) | pool (USD) | ZERO works it? |
|---|---|---|---|---|---|
| base | 49,378,552 | **228 / 241** | 55,345,486,526,535 WETH | **$0.103197** | yes |
| optimism | 154,974,088 | **65 / 71** | 13,082,330,794,540 WETH | **$0.024393** | **no** |
| arbitrum | 489,821,273 | **16 / 44** | 5,745,764,514,414 WETH | **$0.010714** | **no** |
| polygon | 91,227,983 | 1 / 1 | 373,079,203,868,266 WPOL | $0.000027 | no |
| gnosis | 47,493,628 | 0 | 0 | $0 | n/a |

**Reachable income ZERO is leaving on the table today: $0.035134** (optimism + arbitrum + polygon).
That is a 34% increase on the Base pool, for zero new mechanism — the same `harvest(address)` call
ZERO already makes, pointed at three chains its Safe already reaches.

Best single instances (each one its own isolated probe):

```
base      0xD1E1cDc52BC290F9bd3d50fc2D363B76eC0Dd0ee  4,533,335,414,676 wei  $0.008453  aerodrome-cbbtc-edge
optimism  0xA8586453dFD00dA80edADfa4156B939b668cEeae  1,058,097,100,862 wei  $0.001973  curve-op-crvusd-usdc
arbitrum  0x2c0Aa176D337E70BAd16D3E07717582745a8dAc1  1,554,499,148,624 wei  $0.002899  pancake-cow-arb-weth-usdc-500
polygon   0x4f678E4E32293c4553A0811C9D3625Ba4a07664D    373,079,203,868,266 wei WPOL  $0.000027  curve-poly-mai-usdc.e
```

### The control that makes these numbers trustworthy

Before believing any of it I ran the same strategy three times with three different named recipients,
plus a cross-control:

```
harvest(ZERO_SAFE)  measured on ZERO_SAFE  -> 3,682,918,082,341   pays
harvest(0x…dEaD)    measured on 0x…dEaD    -> 3,682,918,082,341   pays
harvest(MULTICALL3) measured on MULTICALL3 -> 3,682,918,082,341   pays
harvest(0x…dEaD)    measured on ZERO_SAFE  -> 0                   <- the one that matters
```

The payment follows the *named recipient* exactly, and naming somebody else moves nothing to us. There
is no ambient balance drift being mistaken for income.

---

## 2. `callReward()` is wrong in the other direction too

The known failure was overstatement (4,481×). The new one is silence.

Across the full Base sweep, **18 strategies report `callReward() == 0` (or don't expose it) and pay
anyway — 5,751,873,786,370 wei = $0.010725, 10.4% of the whole chain pool.** Whole families:

| family | payers | callReward()==0 | pool (wei) |
|---|---|---|---|
| morpho | 6 | **6 / 6** | 5,404,979,349,748 |
| curve | 5 | **5 / 5** | 138,108,537,729 |
| stakedao | 2 | **2 / 2** | 23,394,905,243 |
| alienbase | 1 | **1 / 1** | 183,473,827,254 |
| aave | 1 | **1 / 1** | 606,268 |
| aerodrome | 201 | 3 | 47,872,699,618,462 |
| pancakeswap | 12 | 0 | 1,722,829,681,831 |

The Morpho family alone is $0.010078 — twice what the previous whole-chain estimate said existed on
Base — and a `callReward()`-ranked oracle scores every one of them at exactly zero, so they can never
win a relay slot. Six examples, all `callReward() == 0`:

```
0xD90ec9e27c47FDF0f766c0D6fC4f0f47376dAA47  3,724,551,749,476 wei  morpho-base-steakhouse-high-yield-usdc
0x1FdD1C2533B0bABab328eb4bCB3c94b19a3a5cEB  1,446,098,287,123 wei  morpho-base-gauntlet-frontier-usdc
0xAbcD8A94Db286949B3D725bd3bC4601BC71cb369    183,247,300,974 wei  morpho-base-gauntlet-prime-usdc
0x8839494227ff33fCb3a4f2338C7826Fbc396634a        493,077,702 wei  morpho-v2-base-clearstar-reactor-usdc
0x07421Db65caE0df71c5c173AdAB37282098eB6ef     41,437,170,372 wei  morpho-v2-base-gauntlet-balanced-weth
0x97F0609d2d1fAdeD374FDACDf5fDf912fF0f656a      7,557,824,264 wei  morpho-base-steakhouse-prime-eurc
```

**Verdict: `callReward()` carries no usable signal in either direction. Rank on the isolated balance
delta, which costs one free `eth_call` and cannot lie.**

### ⚠️ This conflicts with `contracts/FINDINGS.md` §4 and one of us is wrong

That file reports **12 isolated payers / $0.005069** on Base. I measure **228 / $0.103197** with the
same method on the same universe at a block 2,438 later. I did not resolve it by argument — I re-ran
their script:

```
$ N=241 node contracts/oracle-distortion.mjs
... error: { code: -32016, message: 'over rate limit' }
```

`mainnet.base.org` rate-limits that run. And `oracle-distortion.mjs`'s isolated loop is
`for (const s of strategies) { try { … } catch {} }` with **no retry and no RPC rotation** — a
rate-limited probe is swallowed and the strategy is silently recorded as a non-payer. My harness
rotates two RPCs per chain and retries 4× with backoff, which is the only material difference between
the two runs. I could not complete their script to prove the count directly, so I state this as the
**observed mechanism, not a confirmed cause** — but the $0.005069 figure should not be planned against
until someone re-runs it with retries. It currently understates Base by ~20×.

---

## 3. The tooling blind-spot this lane found

`oracle.mjs`, `bruteforce.mjs` and my own first harness all build
`eth_call({ to: MULTICALL3, data: aggregate3(...) })` **without a `from` field**. That leaves
`tx.origin = 0x0` while `msg.sender = Multicall3`, so **every function guarded by
`require(msg.sender == tx.origin)` reverts and is filed as "permissioned"**.

Measured on `0xbccdd9e6bc7fe6e59bbca6d8475572f2d0c48726` (optimism), one variable changed at a time:

```
from = (unset)      -> reinvest() REVERTS
from = MULTICALL3   -> reinvest() SUCCEEDS, pays 21,582,435,324,507,841 wei VELO
from = ZERO_SAFE    -> reinvest() REVERTS
from = ZERO_EOA     -> reinvest() REVERTS
```

Only the case where `tx.origin == msg.sender` passes. That is definitive: the guard is an EOA check.

**Fix for ZERO's probes: set `from: MULTICALL3` on every aggregate3 probe.** It costs nothing and it
is the difference between "this contract is closed" and "this contract pays, but not to us".

---

## 4. DEAD — with the evidence, so nobody spends this hour again

### Aura Finance — dead on all five chains
`BoosterLite 0x98Ef32edd24e2c92525E59afc4475C1242a30184` is deployed at the **same address on base,
optimism, arbitrum, polygon and gnosis**, with 29/35/109/32/36 pools and `earmarkIncentive()` of
10–50 bps. All 241 pools are inert:

```
base      isShutdown() = 1   earmarkRewards(0,0x0) -> revert "shutdown"
optimism  isShutdown() = 1   earmarkRewards(0,0x0) -> revert "shutdown"
arbitrum  isShutdown() = 1   earmarkRewards(0,0x0) -> revert "shutdown"
polygon   isShutdown() = 1   earmarkRewards(0,0x0) -> revert "shutdown"
gnosis    isShutdown() = 1   earmarkRewards(0,0x0) -> revert "shutdown"
```
Aura wound down its sidechain deployments. **Never re-probe.** (The docs still describe the incentive,
which is exactly why a docs page is a lead and not a finding.)

### Ajna — the reserve-auction kicker reward does not settle to the caller
`kickReserveAuction()` is advertised as paying the kicker a slice of claimable reserves with zero
capital — the perfect shape. I enumerated **every pool from the `ERC20PoolFactory` on all five
reachable chains** (base `0x214f…779C`, arbitrum `0xA3A1…2aAF`, optimism `0x609C…7Dfa`, polygon
`0x1f17…3Cf6`, gnosis `0x8757…C9ef`) — 270+ pools — and ran one isolated probe each.
**Zero payers.** Two pools do hold real reserves (`claimable = 5539668248122795` and
`1286215412485120990`) and `kickReserveAuction()` is callable on them, but it transfers nothing to the
caller in that call. The kicker award is not an immediate payment.

### Tarot-shape `reinvest()` — real money, permanently out of reach
The one genuinely new bounty family. `REINVEST_BOUNTY() = 0x470de4df820000` = **2e16 = 2%**, paid to
`msg.sender`, gas 0.4M–2.7M — textbook gas-asymmetry, exactly ZERO's moat shape. Six live contracts,
measured paying:

```
base      0x776236aead8a58ac9ec3cf214cda3c6335f46b2d   5,923,787,646,764,378 wei AERO
base      0x042c37762d1d126bc61eac2f5ceb7a96318f5db9   5,915,850,428,417,370 wei AERO
base      0xfa7de3049ad98e7e2735897febd1a58ddd2747e1     151,833,213,420,830 wei AERO   → $0.005015 total
optimism  0x80942a0066f72efff5900cf80c235dd32549b75d  52,659,941,494,822,965 wei VELO
optimism  0xbccdd9e6bc7fe6e59bbca6d8475572f2d0c48726  26,467,348,669,561,056 wei VELO
optimism  0x3b749be6ca33f27e2837138ede69f8c6c53f9207  11,038,640,118,151,155 wei VELO   → $0.001559 total
```

**All six are `msg.sender == tx.origin` gated.** A Safe reached through a sponsored relay always has
`tx.origin` = the relayer, never the Safe. This is not a bug to route around — it is a property of the
execution path. EIP-7702 does not fix it either: the sponsor still originates the transaction.
**Killed. Do not re-probe.**

### The rest, each with its measurement
| family | call | result |
|---|---|---|
| Aave v3 (base `0xA238…d1c5`) | `liquidationCall(WETH,USDC,user,max,false)` | reverts for a caller holding no debt asset — the liquidator must send `debtToCover` in first. **Fails rule (a): non-zero principal.** `mintToTreasury([USDC])` is open to anyone and pays the caller **0**. |
| Compound v3 Comet (base `0xb125…Eb2F`) | `absorb(self,[user])` | reverts (no underwater account); the absorber is paid in non-transferable liquidator points, never a token. `accrueAccount()` open, pays **0**. |
| Aerodrome Voter (base `0x1661…80a5`) | `distribute(0,5)` | **callable by an arbitrary caller** (measured, does not revert) and pays **0** in WETH or AERO. Gauge distribution carries no keeper bounty. |
| Yearn v3 | `report()` / `process_report(address)` | **NOT MEASURED** — no v3 deployment surfaced in 150 blocks of Base mining or in the Beefy universe. Left open for the next session. |

---

## 5. The method worth keeping: mine the keeper economy instead of guessing at it

Rather than working a docs-derived protocol list, I pulled every block and every receipt over a window
and looked for the one unmistakable fingerprint of a keeper bounty:

> `tx.from` is the `to` of an ERC20 `Transfer` emitted inside its own transaction, **and** the sender
> paid in nothing — `tx.value == 0` and no `Transfer` with `from == sender`.

Value flowing one way, into the account that supplied only gas. That filter is what separates a bounty
from a swap, and it finds protocols nobody has written a page about. Every hit is then re-probed
isolated as an arbitrary caller before it counts.

| chain | blocks | txs | paying (contract,selector) pairs | reachable by Safe | EOA-only | callable/0 | permissioned |
|---|---|---|---|---|---|---|---|
| base | 150 | ~19k | 110 | **0** | 3 | 7 | 98 |
| optimism | 100 | 3,552 | 14 | **0** | 3 | 7 | 4 |
| polygon | 100 | 9,157 | 67 | **0** | – | – | 67 |
| gnosis | 60 | 1,131 | 2 | **0** | – | – | 2 |

**Gnosis has essentially no keeper economy** — 1,131 transactions produced two sender-crediting pairs,
both permissioned. That matches the journal's existing "no known payers on Gnosis" note and now has a
measurement behind it.

The honest reading of that table: the live keeper economy on every chain ZERO can reach is either
permissioned, position-based (claiming your own stake), or EOA-gated. The `harvest(address)`
auto-compounder family really is the anomaly — and it is an anomaly *because* it names its fee
recipient as an argument instead of paying `msg.sender`.

**That is the property to hunt on, and it generalises past this lane:** the reachable mechanisms are
the ones that take a `recipient` argument. `msg.sender`-paying mechanisms are reachable only if the
contract never compares `msg.sender` to `tx.origin`. A future sweep should rank candidates by
"exposes a `(address recipient)` overload" before spending a single probe on them.

---

## What I would do next, in order

1. **Turn on optimism and arbitrum.** $0.035 of measured, reachable, already-sponsored income, no new
   mechanism, no new risk. This is the only actionable money this lane found.
2. **Delete `callReward()` from every scoring path** and rank on the isolated delta. It costs the same
   and it unblinds 10.4% of Base plus the entire Morpho/Curve/StakeDAO/Alienbase families.
3. **Add `from: MULTICALL3` to every probe** in `oracle.mjs` and `bruteforce.mjs`, and add an
   `EOA-ONLY` verdict so the class is recorded as unreachable rather than rediscovered.
4. **Re-run `oracle-distortion.mjs` with retries** to settle the 12-vs-228 discrepancy before anyone
   plans against $0.005069.

## Scale, stated plainly

Everything reachable that this lane could find, on all five chains, at one instant:
**$0.138 total, of which $0.035 is new.** Against the $1/h phase-1 gate that is **0.0035% of one
hour's target.** Keeper bounties are a real rail and ZERO should collect all of them, but this lane
does not contain phase 1 and no amount of further probing of this mechanism class will produce it.

## Reproduce

```bash
cd C:/Users/drlor/OneDrive/Desktop/AutoGLMwallet
node knowledge/streams/_kb_control.mjs              # harness control: known payer vs known liar
node knowledge/streams/_kb_full.mjs                 # Base 241-strategy isolated sweep + recipient controls
node knowledge/streams/_kb_reinvest.mjs             # optimism/arbitrum/polygon pools + reinvest() family reads
node knowledge/streams/_kb_morpho.mjs               # callReward()==0 families
node knowledge/streams/_kb_aura.mjs                 # Aura shutdown proof, 5 chains
node knowledge/streams/_kb_ajna.mjs                 # Ajna: every pool, every chain
node knowledge/streams/_kb_named.mjs                # Aave / Compound / Aerodrome Voter
node knowledge/streams/_kb_mine.mjs <chain> <blocks> # mine the keeper economy
node knowledge/streams/_kb_origin.mjs <chain>       # re-probe leads with tx.origin == msg.sender
node knowledge/streams/_kb_emit.mjs                 # regenerate keeper-bounties.json from the measurements
```

Machine-readable rows: `knowledge/streams/keeper-bounties.json`.
