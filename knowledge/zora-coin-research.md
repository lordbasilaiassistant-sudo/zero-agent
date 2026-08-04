# Zora content-coin rail — research log (started 2026-08-03)

Goal: ZERO deploys its OWN content coin via Zora's live on-chain factory, with all creator
rewards routed to its wallet — a new phase-0 stream (trading fees on its coin, forever, $0 capital).
Anthony explicitly authorized this test 2026-08-03, including a one-time ~10¢ gas gift
(**ledger as CAPITAL-IN, never earnings** — the from-zero accounting stays honest).

## Why this doesn't violate the Zora ban / license
- §5 ban was about the *deployer wallet* being banned on zora.co + platform costing money.
  ZERO's EOA is a different, clean wallet, and a direct factory call needs no zora.co account.
  Anthony's direct request overrides for this test.
- ZORA-DELAYED-OSL restricts copying/redistributing the *source*. We deploy nothing of theirs —
  the factory clones its own impl on-chain; using the deployed protocol permissionlessly is its
  intended use. We never vendored their code.

## Measured facts (all on-chain / Blockscout, 2026-08-03)
- Example coin `0x2c96b4d1c579f08955adc5c82d93f9ff83b7fae5` is a 45-byte **EIP-1167 clone** of
  ContentCoin impl `0x5DbD43785954D43c1643A0caf2ecEf9E0056Ff13`. Nobody deploys the ContentCoin
  source themselves; the factory clones it.
- **ZoraFactory `0x777777751622c0d3258f214F9DF38E35BF45baF3`** (Base), verified, EIP-1967 proxy →
  `ZoraFactoryImpl 0xbbAe128a65239c3328fAa0c70B8D5F9C961a8038`.
- CONTROL PASSED: factory's `coinV4Impl()` returns exactly `0x5DbD…Ff13` — the same impl the
  example coin clones. The instrument rediscovered the known specimen.
- Factory getter map (measured): coinV4Impl `0x5DbD…Ff13` · creatorCoinImpl `0x2c80…f51F` ·
  trendCoinImpl `0xBf8e…b40d` · content/creator hook (same) `0x0469a4Bd3724DC86C9542F4694c976DA13C450c0` ·
  zoraHookRegistry `0x777777C4c14b133858c3982D41Dbf02509fc18d7` · owner `0x004d…1AB3`.
- Deploy overloads on ZoraFactoryImpl (full ABI: `scripts/zora-factory-abi.json`):
  - `deploy(address payoutRecipient, address[] owners, string uri, string name, string symbol, bytes poolConfig, address platformReferrer, address postDeployHook, bytes postDeployHookData, bytes32 coinSalt) payable`
  - `deploy(..., bytes poolConfig, address platformReferrer, uint256) payable` (no salt)
  - legacy `deploy(..., address currency, int24, uint256)` + `deployCreatorCoin` + `deployTrendCoin` + `deployWithHook`
- ContentCoin distribution (from pasted source): 1B total, 10M to payoutRecipient (creator),
  990M to the hook for Uniswap v4 liquidity. `initialize(payoutRecipient, owners, tokenURI, name,
  symbol, platformReferrer, currency, poolKey, sqrtPriceX96, poolConfiguration)`.
- Blockscout gaps: `/smart-contracts/{coin}` and `/addresses/{coin}` both returned NO creation tx
  for the clone, and its internal-transactions list was empty — find real deploy txs via
  `eth_getLogs` on the factory instead (probe 4).
- Base gas price at probe time: 0.006 gwei. ZERO EOA balance: 0 wei.

## Plan (state: after probe 3)
1. ✅ Identify factory + impl + ABI.
2. ⏳ Probe 4: copy `poolConfig` bytes from a recent live content-coin deploy (never guess the
   encoding), build ZERO's calldata (payoutRecipient = owners = platformReferrer = ZERO EOA
   `0x50624F7790732f9767180871D03A304756200dB9`, value=0, no postDeployHook), `eth_estimateGas`.
   PARTIAL RESULT (first run): live sample tx
   `0xef7edfa841f9bba3c57325914fbc670419d2e5348cae044779f032ffebb8cd9c` uses the 10-arg salted
   overload `deploy(address,address[],string,string,string,bytes,address,address,bytes,bytes32)`
   with value=0, postDeployHook=0x0, ipfs:// uri. Its poolConfig (saved in
   `scripts/zora-probe4-result.json`): version=4, **currency=address(0) (ETH-backed)**, then four
   dynamic int arrays (tick params). Copy byte-for-byte. Script bug fixed (ethers
   `parsed.signature` is types-only, so the overload check must branch on arg COUNT, not name).
3. Metadata: `uri` points at ZERO's own Worker (free, self-controlled) — needs a `/coin.json`
   route serving Zora-style metadata (name/description/image). Unknown: whether zora.co's indexer
   accepts non-IPFS http URIs — the coin exists on-chain either way; test will answer it.
4. Anthony funds ZERO EOA with ~10¢ ETH on Base (capital-in). ZERO's EOA signs + sends the deploy.
5. Verify: clone exists, `payoutRecipient()` = ZERO EOA, coin visible on zora.co; journal + ledger
   entries (new route `zora-content-coin`, funding logged as capital-in, not earnings).
6. Later: rewards accrue in the backing currency via the hook — add a claim/sweep leg once the
   coin exists and we can measure what accrues (measure, don't recall).

## ✅ OUTCOME (2026-08-03): DEPLOYED AND VERIFIED
- **ZERO coin: `0xa08c4Bb56030E923e16bF0ab22248eC4AC9b661c`** (Base) — deploy tx
  `0xd4967975e0ced469f8df3ae8ab42274e666a0159f2370774b676cf84419f7759`, block 49511221, status 1,
  gasUsed 2,240,019. Signed and sent by ZERO's own EOA.
- On-chain verify: EIP-1167 clone of the SAME ContentCoin impl as the example coin
  (`0x5dbd…ff13`); `payoutRecipient()` = ZERO EOA; ZERO holds 10,000,000 of 1,000,000,000 supply.
- **Zora indexer accepted the http tokenURI** (open question ANSWERED — no IPFS needed):
  api-sdk.zora.engineering returns name/description from our Worker's /coin.json, coinType
  CONTENT, `platformBlocked:false`, creator/payout/referrer all = ZERO EOA, ETH-backed pool with
  live price. Listing: https://zora.co/coin/base:0xa08c4Bb56030E923e16bF0ab22248eC4AC9b661c
- Funding: Anthony sent 0.0001072 ETH (~$0.20, tx `0x1b078864…6ef43`) — ledgered as CAPITAL-IN,
  never earnings. Deploy burned ~0.0000134 ETH; remainder is ZERO's first liquid gas reserve.
- Knowledge bestowed to live KV genesis (verified served) incl. the never-sell/never-self-buy
  doctrine and the "coin.json route must never die" constraint. sync.mjs default URL fixed
  (was still pointing at the dead thryx workers.dev subdomain).
- Open follow-ups: measure how creator rewards actually accrue/claim on a v4 content coin the
  first time any real trade happens (measure, don't recall); consider a second coin with richer
  IPFS metadata + image only if this one shows any organic volume.

## The $1-in-1-hour sprint (2026-08-03, Anthony's goal) — what was built and measured
- Harvest rail: oracle-swept the top 8 callable Base candidates. 118× spread confirmed; best three
  pay $0.04/$0.014/$0.005 — but MEASURED gas is 883k–4.3M each, so **self-funded harvesting is
  net-negative; only sponsored relay slots make harvests profitable** (all relays exhausted at
  sprint time; refill restores the margin). Guard skipped all three; $0 spent, $0 earned.
- **NEW RAIL SHIPPED: `/api/buy-zero`** — 1 USDC OTC tranche of 250,000 ZERO from creator supply,
  delivered on-chain by the EOA (delivery sim green: 58,046 gas). x402 challenge live + in the
  Bazaar discovery header; shoptest 13/13; deployed version 0e4bb5ad. Does NOT breach the
  never-sell doctrine (no pool touch, disclosed premium). Demand unproven — same as the rest of
  the shop; the x402 indexes are the distribution.
- Honest verdict: $1 was NOT earned in the hour. $0.22 of dust + exhausted relay quotas has no
  proven 1-hour path to $1; what the hour bought instead is a permanent new product on the only
  rail where a single sale = the whole goal.

## Execution state (2026-08-03)
- Probe 4 GREEN: live sample deploy `0xef7edf…8cd9c` decoded; poolConfig captured (version 4,
  currency address(0) = ETH-backed, four tick arrays); ZERO's calldata built with the salted
  10-arg overload; `eth_estimateGas` from ZERO's empty EOA = **2,457,459 gas** (deploy simulates
  clean). L2 cost at 0.006 gwei ≈ 0.0000147 ETH.
- Worker redeployed (version 097b43d0) with `/coin.json` + `/coin.svg`; both verified live 200.
  ⚠️ first curl after deploy 404'd — edge propagation lag, cache-bust before believing a 404.
- `scripts/zero-coin-deploy.mjs` written: gates = metadata-live → key-is-ZERO → balance ≥
  worst-case×1.1; salt `ethers.id('ZERO-genesis-coin-1')` (CREATE2 ⇒ rerun-safe). Dry run stopped
  exactly at the funding gate (balance 0).
- WAITING ON: Anthony sending 0.00004 ETH (~15¢) on Base to the EOA. Then: run deploy, verify
  clone + payoutRecipient, check zora.co renders the http metadata URI (open question), ledger
  the funding as capital-in and the coin as route `zora-content-coin`.

## Files
- `scripts/zora-probe.mjs` / `-probe2` / `-probe3` / `-probe4` — read-only probes (rerunnable)
- `scripts/zora-probe*-result.json` — raw probe outputs
- `scripts/zora-factory-abi.json` — ZoraFactoryImpl ABI (verified source via Blockscout)
- `scripts/zora-example-calldata.txt` / `zero-coin-calldata.txt` — example + our deploy calldata
