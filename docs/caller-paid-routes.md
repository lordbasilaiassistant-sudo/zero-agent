# CALLER-PAID ROUTES — WHAT PAYS YOU, WHAT DOES NOT, AND HOW TO TELL
> Corpus entry for ZERO. Measured 2026-08-21. DOCUMENTATION IS A HYPOTHESIS — the chain is the measurement.
> Everything below was measured this session by simulating from YOUR OWN address, never read from a vendor page.
> Sources:
> - live chain reads: https://rpc.gnosischain.com · https://optimism-rpc.publicnode.com · https://arbitrum-one-rpc.publicnode.com · https://base-rpc.publicnode.com
> - eth_simulateV1 + traceTransfers (available: base, gnosis, optimism, arbitrum, mode, sonic, mantle — NOT avalanche, NOT linea, NOT blast)
> - https://api.beefy.finance/vaults · https://api.beefy.finance/tvl (4,042 vaults, 566 active)
> - https://coins.llama.fi/prices/current/ (keyless pricing)
> - https://api.openchain.xyz/signature-database/v1/lookup (selector -> function name)
> - tooling: scripts/wallet-map.mjs · scripts/harvest-scan.mjs · scripts/contract-read.mjs

## THE ONE ROUTE THAT PASSED EVERY GATE

**optimism · `0xbf0449E4C9a997800EedA1193625Ecd35A3d175e` · `harvest(address)` = `0x0e5c011e`**
Pass YOUR address as the argument — the strategy honours it as the call-fee recipient.

| measured by simulating from your own address | |
|---|---|
| value landing at you | **$0.003148** (WETH) |
| gas used | 1,214,696 |
| gas cost at 0.001 gwei | $0.002945 |
| **NET** | **+$0.000203 per call** |

It is a Beefy strategy on the crvUSD/USDT vault. Of 43 optimism strategies simulated, 40 paid
something and **this was the only one net-positive after real gas.** Margin is thin (6.4% of gross),
so a gas-price rise on optimism flips it negative — recheck the gas price before calling, every time.

## THE THREE GATES, IN ORDER. NEVER SKIP THE SECOND.

1. **ACCEPTED** — does the call execute from your address? (`eth_call`, or simulate.)
2. **PAYS YOU** — does value actually land at YOUR address? Run `eth_simulateV1` with
   `traceTransfers: true` and a balance override, then sum only `Transfer` logs whose `to` topic is
   your address.
3. **PROFITS** — is the payout larger than `gasUsed × gasPrice × nativePrice`?

**Gate 2 is the one that catches the expensive mistakes.** Measured this session: four separate
contracts observed paying $411.48, $4,998, $2,671 and $1.19 per call **moved exactly $0.00 to us**
when simulated. One was a signed-payload relay whose proceeds are bound into the payload; another was
`claim(1308)` — a claim on somebody else's position id. A route that executes and pays nothing is
worse than no route: it burns gas forever and looks healthy doing it.

## READ THE CONTRACT. DO NOT GUESS SELECTORS.

`scripts/contract-read.mjs <chain> <address> --calls` extracts every selector from the deployed
dispatcher (solc emits them as PUSH4 literals), names them via openchain, flags gates, follows
EIP-1167 and EIP-1967 proxies, and calls every 0-arg view. It needs no ABI, no explorer key, and works
on unverified contracts.

**Why it matters, measured:** I probed Aura's L2 booster with `earmarkRewards(uint256)` and all 36
gnosis pools reverted. Reading the dispatcher took one call and gave two facts guessing never would:
the real signature is **`earmarkRewards(uint256,address)`** (the one-arg form is not in the contract),
and **`isShutdown()` returns 1**. Guessing a selector can only confirm what you suspected; reading
tells you what is there, including the thing you did not know to look for.

Always read the GATES before assuming permissionless: `isShutdown()`, `paused()`, `keeper()`,
`owner()`, `whitelist`, `operator`. A missing gate is not the same as a gate that returns false.

## DEAD FAMILIES — DO NOT RE-SCAN THESE

- **Aura on L2 — ALL SHUT DOWN.** `isShutdown() = 1` on the booster
  `0x98Ef32edd24e2c92525E59afc4475C1242a30184` on arbitrum (109 pools), optimism (35), base (29),
  gnosis (36), polygon (32). 241 pools, five chains, dead. `earmarkIncentive()` was 10/10000 = 0.1%.
- **Beefy neglect is not money.** 4,042 vaults enumerated; the ones unharvested for **716 days** pay
  **nothing** — they are dead, not ripe. Every vault that pays anything was harvested **0–0.9 days
  ago**: Beefy is swept continuously by incumbent keepers, so the accrued fee is hours of yield
  against a 1–2.8M-gas call. TVL is not a caller fee either; $801,687 of TVL paid $0.
- **ERC-4337 bundling on gnosis** — real money ($42.23/day chain-wide, margin $0.000850/call,
  71.9% of the refund) but **48 of the 52 "competitors" share the `0x4337` vanity prefix**: one
  operator round-robining a wallet pool at 96.3% of volume. The addressable remainder is 3.7%.
- **`callReward()` is NOT a proxy for the caller fee.** On strategies that demonstrably pay, it
  disagreed with the measured simulation by a constant ~1349× and returned **0** for two of them.

## THE TWO RULES THAT GENERALISE

**GAS IS A DENOMINATOR, NOT A CONSTANT.** The identical call costs **167× more on arbitrum than on
scroll**. A route that loses money on one chain can profit on another with no change in capability.
Measured cost of one 2.55M-gas harvest: scroll $0.000742 · avax $0.001140 · sonic $0.003909 ·
optimism $0.006179 · base $0.037054 · arbitrum $0.123636. ⚠️ But cheap chains are usually cheap
because nobody uses them — mode had 8 transactions in 150 blocks, blast 454 with zero payers. Cheap
gas AND real activity is the rare intersection.

**DISTINCT ADDRESSES ARE NOT DISTINCT ACTORS.** Competition is between operators. Splitting one
operator across more addresses makes every concentration metric look MORE competitive — HHI read
**201** ("perfectly competitive") on a market that was ~96% one entity. Before believing a crowd:
check shared vanity prefixes (quantify as 16ⁿ), flat share distribution (real markets are power-law;
a dozen callers at 2.2–2.6% each is a scheduler), common funding ancestor, round-robin timing.

## WHAT COUNTS AS EARNED

A simulation is **rung 2** on the sponsor-probe ladder (0 FOUND · 1 REACHABLE · 2 ACCEPTED ·
3 EXECUTED · 4 PROFITABLE). Only a settled transaction is rung 3, and only a measured balance
increase is rung 4. Nothing in this document may be logged as income until a receipt exists.
