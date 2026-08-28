# LANE — faucets & open airdrops — contracts that pay whoever asks — measured 2026-08-01
# Recipients in this census are GENESIS I Safe `0x5106…cbb1` (retired). Re-run the hunter to measure GENESIS II.

Hunt: the class Anthony named from experience — *"some people setup their contracts to payout a lot of
their tokens too sometimes as airdrops, or just to get someone to test their contracts. sometimes it's a
meaningful repeatable pattern too."* Not keeper fees, not protocol maintenance: deliberate giveaways.

**READ-ONLY.** Every number below came from an `eth_call` this session ran. Nothing was signed, no relay
slot was spent, no key or `.env` was touched.

---

## TL;DR — the class is REAL and I measured it paying. It pays $0. Both halves are proven.

**3,348 unique contracts** probed across all six chains. **27 payments survived the isolated payment
test. Exactly zero of them are faucet income.**

1. **The giveaway class exists exactly as described, and is wide open.** `FaucetToken`/FAU is live on
   **four chains** (optimism, arbitrum, polygon, gnosis) and will mint **any amount up to 10,000,000
   tokens directly to ZERO's Safe** — no gate, no cooldown, no allowlist, no approval, unlimited,
   forever. Even its *fallback* mints on empty calldata. Measured, not read from docs.
   **Every single giveaway token found has NO MARKET** — no Uniswap V2/V3 or Aerodrome pool holds a
   non-zero quote balance against any of them. A claim paying 10²⁴ units of a token nobody trades is
   worth $0, and that is 100% of this lane's yield. **Reported DEAD deliberately: 17 of 27 rows.**

2. **All 10 MEASURED rows are the same thing, and it is not a faucet.** Every one is `harvest(address)`
   paying **real WETH** — 8 on optimism, 2 on base. Total for one claim of all ten: **$0.001704**. The
   claimable amount **grows when read twice**, so it is a recurring line, not a one-off. That is the
   **keeper-bounty class, which another lane owns — do not double-count it.** What is new is the
   *route*: found from raw Transfer-log behaviour, not from `api.beefy.finance/vaults`, the only thing
   ZERO's discovery layer can currently see.

3. **The instrument was lying in three separate ways, and 79% of raw hits were fake.** The domain gate
   rejected **104 of 131** well-formed non-payments. Three fixes below each silently zero out or
   fabricate a whole class of finding. They are the most transferable thing in this document.

**If you read one line:** this lane returns **$0.00/day of faucet income**. There is no faucet rail
here. Do not build one.

---

## What was actually swept — the denominator, so the zero means something

| chain | unique contracts probed | rows that paid (post-gate) |
|-------|------------------------|----------------------------|
| base | 892 | 2 measured, 3 dead |
| polygon | 598 | 0 measured, 4 dead |
| optimism | 551 | 8 measured, 3 dead |
| arbitrum | 524 | 0 measured, 4 dead |
| unichain | 461 | 0 |
| gnosis | 361 | 0 measured, 3 dead |
| **total** | **3,348** | **10 measured, 17 dead** |

Every contract had its **full external interface recovered from runtime bytecode** — no ABI, no source,
no explorer — and every claim-shaped selector put through an isolated payment test.

Discovery was deliberately **not** API-bound (that is ZERO's existing weakness), from four sources:

- **Blockscout keyword search** across 13 giveaway words — the productive source, ~450–600 hits/chain.
- **Behavioural Transfer-log scan** — the source that does not need anyone to name their contract
  "faucet". On base: **400 blocks, 92,271 Transfer logs → 715 candidates** (36 open-mint tokens, 679
  distributor contracts), ranked by distinct recipients and by recipients paid *more than once*. Also
  run on optimism, arbitrum, gnosis, unichain. **This is the source that found the WETH.**
- **Fresh contract creations** from our own RPC (`to == null` in the block, then the receipt).
- **Blockscout verified-contracts list** — **measured dead as a source**: 200 consecutive entries on
  base were *100% `SafeProxy`*, 0 name matches. Do not spend time here again.

### Blocked, measured not assumed

- **polygon** — free RPCs refuse address-agnostic `eth_getLogs` (*"Please specify an address in your
  request"*), so behavioural scanning is impossible there without a key. Keyword search still works.
- **archive state** — free RPCs reject any historical block (*"Archive requests require a personal
  token"*). Consequence: **a payout that changes cannot be checked against the past.** When a hit stops
  paying there is no way to distinguish "it was drained" from "the measurement was wrong."
- **`eth_getLogs` is capped at a 10,000-block range.** Asking for more returns an *error*, not less
  data — and a silent catch turns that error into "no payout history", which reads as "not repeatable".

---

## The instrument, and the three ways it was lying

A lane reporting zero is only worth reading if the instrument demonstrably detects payment when payment
happens. `_fa_selftest.mjs` builds a faucet that exists only inside `eth_call` (state override), funds
it, and runs it through the *same* `payTest()` the sweep uses. **8/8 green**, including negative
controls that must NOT register as paying. **Run it before trusting any zero.**

### 1. Multicall3 cannot receive ETH — the native-faucet class was invisible

**MEASURED:** a plain ETH transfer to `0xcA11bde05977b3631167028862bE2a173976CA11` **fails**. ZERO's
Safe accepts ETH; Multicall3 does not.

The mandated payment test runs the candidate call *inside* `aggregate3`, so `msg.sender` is Multicall3.
Any faucet paying native ETH to `msg.sender` therefore pays **nothing** in simulation and is scored
DEAD — while paying ZERO's Safe perfectly well in production. A systematic false negative across the
single most valuable class for ZERO, since **native ETH needs no swap at all**.

Fix: a second instrument (`payTestNative`) — a 52-byte prober contract deployed only inside `eth_call`
via state override, which *does* accept ETH and does the balance-wrap itself:

```
36601411603257 60143603806014608037 47600052 600060008260806000600035 60601c5af1 47602052 604052 60606000f3 5b00
```

Still an isolated payment test — one call, wrapped in self-balance reads — with a caller that behaves
like ZERO's Safe instead of like Multicall3. **State overrides work on all six chains** (checked
individually). Positive control: a synthetic native faucet is detected at exactly 10^16 wei.

*(Result of adding it: no native-ETH faucet was found on any chain. But that is now a measurement
rather than a blind spot.)*

### 2. A positive delta is not a payment — the balance-poisoning class (104 of 131 raw hits)

The brief warns that "it did not revert" is not payment. There is a worse one: **the arithmetic is
correct and the payment is still fake.**

A cluster of **11+ vanity-address contracts** (`0x0000…0000`) on optimism — "Smart distributor V3",
"Sign-in distributor", "Claim Core" — every one reported a delta of
`462562227601867317537366769653933563683203632049`. In hex that is
`0x510601f59fda068d70ad6760c9d9085b0f42cbb1` — **ZERO's own Safe address, echoed back as a number.**
They write the address argument into the slot `balanceOf` reads. `balanceOf` for three unrelated
addresses returns 0; `totalSupply` is 3.14e14 while the "payment" is 4.6e47.

Fix: a **domain gate** (`plausibleDelta`) on every delta, enforcing two bindings a real payment cannot
violate:

1. **you cannot be paid more of a token than exists** — `delta <= totalSupply`
2. **a payment is not an address** — `delta != any 20-byte address in the calldata`

It **rejected 104 of 131 raw hits (79%)**, and passed every real WETH and FAU payment untouched. It
runs in the probe *and* again at report time, because the long sweeps were launched before this class
was known and their hit files still contained it. Rejects are kept in `_fa_gated_out.json`.

**Known gap, stated rather than hidden:** the gate tests *equality* with an address. On polygon,
`0x3B3f4689F55B167D65b30B662031f770cE28399c` returned the Safe address **multiplied by 1e18**, which
slipped through equality and was only killed by the liquidity check. A stricter version should test
whether the address appears as a *substring* of the delta's hex.

### 3. `mint(address,uint256)` was not in the signature list

`FaucetToken` reported **callable, pays nothing** through the entire first sweep. Its verified source
explains why: it *overrides* the `onlyMinter` mint with a public unrestricted
`mint(address to, uint256 value)`. With no two-argument shape probed, the most common open-mint
signature there is was measured as dead. Added as a named signature and as an argument shape for
unknown selectors; the second pass found **39 more paying contracts** the first pass had scored dead.

### Smaller, still load-bearing

- **Selector recovery walks opcodes instead of scanning for the byte `0x63`.** A walker knows a PUSH4's
  four bytes are *data*. Validated against WETH's real ABI (100% recall, 0 missing) and kills **12 of 67**
  phantoms on Uniswap SwapRouter02 — 17.9%, matching the 14% caveat in the brief.
- **A bad RPC does not look bad, it looks like an empty chain.** `base.llamarpc.com` answers with an
  HTML error page, which every JSON parse reads as a transport failure and silently retries away.
  Removed from the round-robin.
- **Blockscout rate-limits concurrent sources.** Firing four harvest sources with `Promise.all` made
  three of them return nothing — indistinguishable from "this chain has no candidates". Now sequential.
- **Ranking pools by raw wei is a decimals bug.** USDC has 6 decimals and WETH 18, so raw-integer
  comparison ranks a $100 pool above a $100M one. It picked the wrong pool and priced a $0.00073 payout
  at **$0.40 — 544× too high**. Reference assets are now priced directly, never via a pool ratio.

---

## Findings

Ranked by **realisable** USD. Full machine-readable detail in `faucets-airdrops.json` (27 rows).

### 1. `harvest(address)` paying real WETH — 10 MEASURED rows, 8 optimism + 2 base

All pay **WETH directly to ZERO's Safe** — the function takes the recipient, so nothing depends on
`msg.sender`. They are `BeaconProxy` contracts exposing `want()`, `vault()`, `lastHarvest()` — Beefy
strategy shape.

| chain | contract | measured wei WETH | ~USD/claim |
|---|---|---|---|
| optimism | `0xb2c27c8b3b76c79d523718efe17af695d1668f25` | 258,489,147,360 | $0.000775 |
| base | `0xd90ec9e27c47fdf0f766c0d6fc4f0f47376daa47` | 244,325,903,422 | $0.000733 |
| optimism | `0x969d802b313ff51a7cb1383e05e8529a6b5ab81f` | 13,811,028,990 | $0.000041 |
| optimism | `0x994afa36b085d006a911ce28ba300e8ee71b8bc2` | 12,885,042,294 | $0.000039 |
| optimism | `0x142595ff3c59639225db13caf5e48a52b07991be` | 12,694,407,736 | $0.000038 |
| optimism | `0xba309f9687780c9748467fb0a316ca506db48944` | 10,412,018,016 | $0.000031 |
| optimism | `0xeaf7abe83c25d1a425b6022c46589891e435c604` | 8,287,940,369 | $0.000025 |
| base | `0xd8d64ed31e432d9375d07df11555a58f66e12d69` | 2,803,582,621 | $0.000008 |
| optimism | `0x2e0f95e2bf01b9039c65fd0af1476d91ed930f81` | 2,457,213,555 | $0.000007 |
| optimism | `0x0b542f61199d2a01770b601efa0509244bdcee89` | 1,824,718,379 | $0.000005 |

**Sum of one claim across all ten: $0.001704.**

**Repeatability is directly measured, not inferred.** The claimable amount on the base pair was read
twice, 301 blocks apart (49379857 → 49380158, 10.0 min wall clock), and it **grew**:

| contract | at t0 | at t1 | accrued in 10 min | ~USD/day @ $3000/ETH |
|---|---|---|---|---|
| `0xd90ec9e2…` | 318,969,813,921 | 416,459,232,989 | 97,489,419,068 wei | **$0.041910** |
| `0xd8d64ed3…` | 3,512,127,991 | 4,449,493,867 | 937,365,876 wei | $0.000403 |

The optimism leader behaved the same way (258,489,147,360 → 353,985,928,255 on re-read). It
regenerates; it is a recurring line, not a balance sitting there.

**WETH here is realisable in phase 0.** The standing note "ZERO cannot swap, so it can only hold" is
true for arbitrary ERC-20s and **false for wrapped native**: `WETH.withdraw(uint256)` is a 1:1 unwrap
with no DEX, no liquidity and no price. **MEASURED** — it returned `0x` from a holder under state
override on base. Cost: one extra relay slot.

**Why not drained:** ~$0.0007 per claim is below a human's gas cost, and no address has taken a WETH
payout from these contracts in the scanned window. That gap *is* ZERO's moat — it does not pay gas.

⚠️ **This is the keeper-bounty class, not the faucet class. Another lane owns it — do not double-count.**

### 2. FaucetToken / FAU — a genuinely UNLIMITED open mint on four chains. DEAD on value.

`0x5c239f4E539452f58A55E3d5Be1dC016b0809a19` (optimism) ·
`0x84952D54882614C392Baeff5CB0332CC551ca119` (arbitrum) ·
`0xb816d2Bd3FFEf8CA2E65E5F7E0695351b733C4f3` (polygon) ·
`0x3111C94B9243a8A99D5A867e00609900e437E2c0` (gnosis)

The purest example of exactly the pattern Anthony described, and it is wide open:

| call | measured result |
|---|---|
| `mint(SAFE, 1e24)` | **pays 1,000,000 FAU straight to ZERO's Safe** |
| `mint(SAFE, 1e25)` | **pays 10,000,000 FAU** — the contract's own `dont be greedy` ceiling |
| `0x` (empty calldata) | pays 1 FAU to `msg.sender` — even the *fallback* mints |
| `0xffffffff`, `mint(address)` | pays 1 FAU to `msg.sender` |

No gate, no cooldown, no allowlist, no approval, no `hasClaimed`. Unlimited, repeatable forever, pays
the Safe directly, and fully within ZERO's phase-0 constraints.

**And it is worth exactly $0.** No pool on any factory holds a non-zero quote balance against FAU. A
token where anyone can mint 10M at a time can never hold a price — which is *why* it has no market. It
is not drained because there is nothing worth draining.

### 3. Everything else — open mints in dead tokens

Same shape, same verdict, all measured paying, all with **no market**: `MOO` / "FreeMintableToken"
(arbitrum `0x4128E573…`, totalSupply 2.3e74, mints 1e30 on demand), `aglaMerkl` (Angle Merkl, base +
optimism), `TestToken`/TST (base + optimism), `PWN Faucet Token` (arbitrum), `TTK` (gnosis), `DRIP`
(optimism), `testToken`/TEST (base — pays 1e32 to the Safe, and its `transfer` *mints* rather than
transfers), `base freemint`, `FreeMint NFT` (base — an ERC-721, so the measured "1" is a token *count*,
not an amount, and no fungible pool can price it).

### 4. Actively hostile — recorded so nobody probes them again

- **The optimism `0x0000…0000` poison cluster** (11+ contracts) — fake balances, see instrument §2.
- **Phishing airdrop tokens on gnosis** — e.g. `0x88f170d138D3b3cF2F1AE627c47540c0c3fD7001`, whose
  token *symbol* is literally `Read more: https://hana-network.cc`. The "payout" is bait to get a
  wallet to a phishing site. Never interact.

---

## The honest answer to "why isn't it drained?"

For every hit, one of two answers, and neither is an opportunity:

- **the token has no market** — there is nothing to drain (all of §2 and §3), or
- **the payout is worth less than gas** — true only of the WETH keeper fees in §1, and that one *is*
  ZERO's asymmetry, because ZERO does not pay gas.

Not one contract in 3,348 was an open payout of *real, liquid value* left sitting there. That is the
expected result and it should be believed: a contract paying anyone real money is drained within blocks.

## Verdict for ZERO

- **Do not build a faucet-claiming rail.** The class is real, it is open, ZERO can absolutely claim from
  it — and it converts to $0.00. Spending a relay slot (5/chain/day, ZERO's scarcest resource) to mint a
  token with no market is a strictly negative trade.
- **The one thing worth keeping is the discovery method, not the results.** The behavioural Transfer-log
  scan found WETH-paying contracts that ZERO's API-bound layer cannot see. Worth porting into
  `discover.mjs` regardless of what this lane concluded.
- **Re-measure before trusting any row.** No archive access means a hit that stops paying cannot be
  distinguished from a bad measurement. Every row ships with a `reproduceCmd`.

## Files

- `faucets-airdrops.json` — 27 machine-readable rows, ranked by realisable USD, DEAD entries included
- `_fa_lib.mjs` — RPC, opcode-walking selector recovery, both payment tests, the domain gate
- `_fa_selftest.mjs` — 8 controls; **run first, a zero result is meaningless without it**
- `_fa_candidates.mjs` / `_fa_behaviour.mjs` — the two discovery layers
- `_fa_probe.mjs` / `_fa_pass2.mjs` — the sweeps
- `_fa_value.mjs` / `_fa_report.mjs` — liquidity, repeatability, enrichment
- `_fa_gated_out.json` — the 104 well-formed non-payments the domain gate rejected
