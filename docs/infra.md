# FREE INFRASTRUCTURE — the rails ZERO actually runs on
> Corpus entry for ZERO. Fetched 2026-08-12. DOCUMENTATION IS A HYPOTHESIS — the chain is the measurement.
> Sources: https://base.blockscout.com/llms.txt · https://docs.blockscout.com/llms.txt ·
> https://chains.blockscout.com/api/chains · https://base.blockscout.com/api/v2/* ·
> https://api.etherscan.io/v2/api · https://api.basescan.org/api ·
> https://base-rpc.publicnode.com · https://base.drpc.org · https://mainnet.base.org · https://1rpc.io/base ·
> https://base.meowrpc.com · https://rpc.ankr.com/base · https://base.llamarpc.com ·
> optimism/arbitrum/polygon/gnosis/unichain publicnode + drpc + official RPCs ·
> https://console.groq.com/llms.txt · https://console.groq.com/docs/rate-limits ·
> https://api.groq.com/openai/v1/{models,chat/completions} ·
> https://docs.z.ai/llms.txt · https://docs.z.ai/api-reference/api-code.md ·
> https://api.z.ai/api/paas/v4/chat/completions · https://api.z.ai/api/anthropic/v1/messages
>
> Verified on-chain / live today (free calls only, nothing signed, nothing sent):
> · eth_blockNumber against 20 RPC hosts on 6 chains — 4 hosts FAILED, named below
> · publicnode's non-archive state window on Base bisected to **between 64 and 96 blocks**
> · eth_getLogs range caps measured per host (publicnode/drpc/base.org/1rpc all different, all named)
> · eth_call **state overrides** proven working on publicnode (all 6 chains), drpc, base.org, 1rpc —
>   code override, balance override and stateDiff storage override each returned the overridden value
> · the RPC itself enumerated the legal override fields in an error message
> · EIP-1967 impl/beacon/admin slots and the legacy zeppelinos slots recomputed from keccak, then read
>   on-chain: Base USDC uses the **legacy zeppelinos slots**, not EIP-1967; a Safe proxy uses **neither**
> · Multicall3 confirmed byte-identical (3808 bytes of runtime code) on base/op/arb/polygon/gnosis/unichain
> · Blockscout index measured WRONG **at its own self-reported block**: 61192266278658 vs 65822908733718
> · Blockscout /api/v2/stats `total_blocks` measured ~201,000 blocks (~4.7 days) behind the chain head
> · Etherscan V2 free tier re-confirmed dead for chainid 8453 AND 10
> · Groq TPM caps read live from response headers; a 413 reproduced on purpose to prove max_tokens is
>   reserved before generation
> · z.ai measured to return **no rate-limit headers at all** on either of its two endpoints

---

## 0. THE ONE-PARAGRAPH VERSION

Free reads, ranked by how much you should trust them:
**`eth_call`/`eth_getCode`/`eth_getLogs` against a node > Blockscout v2 > anything in a doc.**
Blockscout is an *index* — a database someone else populates on a delay, and today it is measurably
wrong about a balance **at the block it says it measured**. It is for *discovery* (what contracts exist,
what source they have, what events fired). It is never for *deciding* (how much is there, is this
callable). Decide with `eth_call`. Etherscan/Basescan is a closed door on our chains; stop knocking.

---

## 1. BLOCKSCOUT v2 REST — free, no key, the discovery layer

### Base URLs per chain (VERIFIED 2026-08-12, all returned HTTP 200 on `/api/v2/stats`)

| chain | id | Blockscout base URL | note |
|---|---|---|---|
| Base | 8453 | `https://base.blockscout.com` | direct 200, no redirect |
| Optimism | 10 | `https://optimism.blockscout.com` | **301 → `https://explorer.optimism.io`** |
| Arbitrum One | 42161 | `https://arbitrum.blockscout.com` | direct 200, no redirect |
| Polygon PoS | 137 | `https://polygon.blockscout.com` | direct 200, no redirect |
| Gnosis | 100 | `https://gnosis.blockscout.com` | **301 → `https://gnosisscan.io`**, which serves Blockscout v2 |
| Unichain | 130 | `https://unichain.blockscout.com` | direct 200, no redirect |
| Ethereum L1 | 1 | `https://eth.blockscout.com` | direct 200 (settlement layer for Base/OP/Unichain) |

**GOTCHA — you MUST follow redirects.** `optimism.blockscout.com` and `gnosis.blockscout.com` answer
`301 Moved Permanently`. A client that does not follow (`curl` without `-L`) sees an nginx HTML page and
a JSON parse failure, which will look to you like "the chain has no explorer". Worker `fetch()` follows
redirects by default, so this bites scripts, not the Worker. Legacy `https://blockscout.com/xdai/mainnet`
also still serves Gnosis v2 (verified 200).

**Chain registry, if you ever need a 7th chain:** `GET https://chains.blockscout.com/api/chains`
→ 322 KB JSON keyed by chain id, each entry `{name, native_currency, explorers:[{url, hostedBy}]}`.
Free, no key. Use this instead of guessing a hostname.

### ⚠️ THE VENDOR'S OWN llms.txt POINTS AT A KEYED API. IGNORE THAT PART.
`https://base.blockscout.com/llms.txt` documents everything against
`https://api.blockscout.com/{chainid}/api/v2/...` and states *"Every request requires the header
`Authorization: Bearer {api_key}`"*. That is the **PRO** API — a signup, therefore a dead end for us.

**Contradiction, recorded, not smoothed:** the vendor's machine-readable guide says you need a key; the
per-instance hosts in the table above answered every one of the same v2 paths today with **no key and no
Authorization header**. I trust the measurement. Use the per-instance hosts. Treat `api.blockscout.com`
as gated. (The llms.txt also names an MCP endpoint `https://mcp.blockscout.com/mcp/` — unprobed, and it
is a different transport than a Worker `fetch` wants anyway.)

The llms.txt is still worth reading once for **path discovery** — it is how the account-abstraction and
advanced-filter paths below were found. Read it as a map, not as an auth spec.

### Paths that matter, with what actually comes back

All relative to `<BASE>/api/v2/`. Every one below returned HTTP 200 today unless stated.

**`stats`** — cheapest liveness probe, ~90 ms.
```json
{"average_block_time":2.0e3,"coin_price":"1886.53","gas_prices":{"slow":0.01,"average":0.01,"fast":0.02},
 "gas_prices_update_in":8702,"market_cap":"...","network_utilization_percentage":6.51,
 "total_addresses":"987550917","total_blocks":"49682492","total_gas_used":"0",
 "total_transactions":"7082532135","transactions_today":"7884068","tvl":null}
```
- `coin_price` is a **string**, USD, no unit field. This is the free price oracle the ledger uses.
  `average_block_time` is in **milliseconds** (Base 2000, Gnosis 5101, Arbitrum 253, Polygon 1505).
- `gas_prices` is in **gwei** and is a UI estimate, not the chain's basefee. For a real fee decision use
  `eth_gasPrice` / `eth_feeHistory`, not this.
- **`total_gas_used` is literally `"0"`.** A field that silently returns zero forever. Never divide by it.
- **`total_blocks` measured 49,682,492 while the chain head was 49,883,790 — 201,298 blocks / ~4.7 days
  behind.** Do not use `stats.total_blocks` as a head. Use `eth_blockNumber`.

**`addresses/{a}`** — one address, native balance + proxy identity.
```json
{"block_number_balance_updated_at":49871644,"coin_balance":"0","hash":"0x5106…cbb1",
 "is_contract":true,"is_verified":true,"name":"SafeProxy","proxy_type":"master_copy",
 "implementations":[{"address_hash":"0x29fcB43b46531BcA003ddC8FCB67FFE91900C762","name":"SafeL2"}],
 "creation_transaction_hash":"0x8bfe…","creator_address_hash":"0x4e1D…","exchange_rate":"1886.82",
 "has_logs":true,"has_token_transfers":true,"is_scam":false}
```
- `block_number_balance_updated_at` is the **only honest staleness signal in the whole API**. Read it.
  Compare to `eth_blockNumber`. If it lags, you are reading history.
- `coin_balance` is native wei as a string. It does **not** include tokens.
- `proxy_type` + `implementations[]` is free proxy resolution — `eip1967_beacon`, `master_copy`, etc.
  This is a genuinely useful shortcut, but §4's rule still stands: confirm with a storage read before
  you fingerprint selectors against it.
- **An unknown address is NOT a 404.** `GET addresses/0x…0001` returned HTTP 200 with a full, plausible
  object. There is no "this address does not exist" signal. Absence of an account looks identical to a
  present one with zero activity.

**`addresses/{a}/token-balances`** — a **bare JSON array** (no `items` wrapper, no pagination).
```json
[{"token":{"address_hash":"0x4200…0006","decimals":"18","symbol":"WETH","exchange_rate":"1912.49",
           "name":"L2 Standard Bridged WETH (Base)","type":"ERC-20","total_supply":"…"},
  "token_id":null,"token_instance":null,"value":"61192266278658"}]
```
- `value` is raw units as a string; apply `token.decimals` yourself (also a string).
- **It omits native ETH entirely.** Native lives in `addresses/{a}.coin_balance`. A tool that reads only
  this endpoint will report a wallet holding ETH as empty — that is Trap 5 from `toolcraft.md` with a
  different sensor.
- Tokens with no accrual do not necessarily appear. Zero-balance tokens are dropped.

**`addresses/{a}/transactions`** — `{items:[…], next_page_params:null|{…}}`.
Item keys observed: `hash, block_number, timestamp, from{}, to{}, value, fee{}, gas_used, gas_limit,
gas_price, max_fee_per_gas, max_priority_fee_per_gas, base_fee_per_gas, priority_fee, nonce, position,
status, result, revert_reason, method, decoded_input, raw_input, token_transfers[],
token_transfers_overflow, has_error_in_internal_transactions, created_contract, confirmations`.
- `?filter=` is an **enum**, and a wrong value is a hard `HTTP 422`:
  `{"errors":[{"title":"Invalid value","source":{"pointer":"/filter"},"detail":"Invalid value for enum"}]}`
  Measured: `filter=to` and `filter=from` are legal; **`filter=to | from` (the URL-encoded pipe form some
  docs show) returns 422.** Just omit `filter` to get both sides.
- Paginate by feeding the whole `next_page_params` object back as query params. `null` = last page.

**`addresses/{a}/logs`** — decoded events for one address, free, no block range required. Item carries
`decoded:{method_call, method_id, parameters:[{indexed,name,type,value}]}`. This is the *only* free path
that hands you **decoded** events without an ABI in hand. Confirmed live: it decoded a Safe
`ExecutionSuccess(bytes32 indexed txHash, uint256 payment)` with `method_id: "442e715f"`.
For anything historical or high-volume, use `eth_getLogs` instead — §3.

**`addresses/{a}/token-transfers`** — same envelope; slowest path measured today at **8,131 ms**.
Budget for it or skip it inside a slice.

**`smart-contracts/{a}`** — **full verified source + ABI, free, no key.** The single most valuable
Blockscout path we have. Top-level keys:
`source_code, additional_sources[], abi, name, compiler_version, evm_version, language, license_type,
optimization_enabled, optimization_runs, compiler_settings, constructor_args, decoded_constructor_args,
creation_bytecode, deployed_bytecode, is_verified, is_partially_verified, is_fully_verified,
is_verified_via_sourcify, is_verified_via_eth_bytecode_db, is_verified_via_verifier_alliance,
verified_twin_address_hash, verified_at, proxy_type, implementations[], conflicting_implementations,
external_libraries, is_changed_bytecode, is_blueprint, certified, file_path, sourcify_repo_url`
- **An unverified contract is a clean `HTTP 404 {"message":"Not found"}`.** Distinguishable from an
  error — good. Fall through to `eth_getCode` + PUSH4 bruteforce when this 404s.
- `verified_twin_address_hash` is free money for fingerprinting: a byte-identical verified clone.
- **`is_partially_verified` / `is_changed_bytecode`** mean the source you just read may not be the code
  that runs. Check them before you believe a `require`. And `toolcraft.md` Trap 4 still outranks all of
  this: an `eth_call` simulation beats any regex over any source, verified or not.
- ~2,900 ms on a big contract. Not a cheap call.

**`config/backend-version`** → `{"backend_version":"v11.2.6"}` (Base, today). Cheapest possible probe.

**`main-page/indexing-status`** → and this is the important one:
```json
{"finished_indexing":false,"finished_indexing_blocks":true,
 "indexed_blocks_ratio":"1.00","indexed_internal_transactions_ratio":"0.58"}
```
**The index tells you, in its own words, that it is only 58% done with internal transactions.**
That is the documented, self-reported reason not to trust it. Any tool that reasons about internal
calls / value moved by a contract from Blockscout is reading a 58%-complete table. Query this before
concluding anything from an index result that surprises you.

### 🔴 THE INDEX IS NOT THE CHAIN — measured today, and worse than "stale"

The lane brief carried a report that Blockscout showed a WETH balance **4× lower** than `eth_call`.
I could not reproduce a 4× today. What I measured is different and, in one way, worse:

- `addresses/0x5106…cbb1/token-balances` → WETH `61192266278658`
- `addresses/0x5106…cbb1` → `block_number_balance_updated_at: 49871644`
- `eth_call WETH.balanceOf(0x5106…cbb1)` at **that exact block 49871644**, on **two independent
  providers** (`base.drpc.org` and `mainnet.base.org`) → `0x3bdd9717d916` = **65822908733718**
- same value at `latest` → **65822908733718** (unchanged since)

So the index is not merely lagging behind the head. **It is wrong for the block it claims to have
measured**, by `4630642455060` wei — the chain figure is **1.0757×** the indexed one.

Two claims about the same instrument, both recorded:
| claim | ratio | when | who |
|---|---|---|---|
| index 4× lower than chain | 4.0× | earlier 2026-08-12 | lane brief, unreproduced by me |
| index 1.076× lower than chain, **at its own stated block**, 2 providers agreeing | 1.0757× | 2026-08-12 17:5x UTC | this file, measured |

I trust my measurement for the ratio (two providers, pinned block) and I trust the brief for the
existence of a much larger excursion — an index that can be wrong by 7.6% has no mechanism preventing
it from being wrong by 300%. **Neither number is the law. The law is: the index's balance is an
estimate with unbounded error. `eth_call` is the balance.**

Also measured, in the opposite direction: the same EOA's native balance read `1285472388723` from
Blockscout and `1151028698337` from `eth_getBalance` — the index was **1.117× HIGH**. It drifts both
ways, so you cannot even treat it as a safe lower bound.

**Rule for code: never gate a transaction on a Blockscout number.** Use it to find candidates; re-read
the deciding value with `eth_call` in the same tick you act.

### Rate limits — MEASURED, and there are two of them
Every v2 response carries:
```
x-ratelimit-limit: 180
x-ratelimit-remaining: 179 (decrements 1 per request)
x-ratelimit-reset: 15678   (milliseconds until the window resets)
```
- The counter is **shared across all v2 paths on that host**, not per-path.
- **There is a SECOND, undocumented burst limiter.** 25 parallel `GET /api/v2/stats` in 257 ms returned
  **9× HTTP 200 and 16× HTTP 429** while `x-ratelimit-remaining` was still 173. So "remaining > 0" does
  **not** mean the next request succeeds. **Serialise Blockscout calls.** This is the same shape as the
  38-parallel-probe incident in `toolcraft.md`: parallelism turns into a clean-looking null.
- Blockscout is behind Cloudflare (`cf-ray`, `cf-cache-status: DYNAMIC`) — nothing is cached for you.

### The v1 Etherscan-compatible endpoint also works, free, no key
`GET <BASE>/api?module=…&action=…` — verified today on Base:
- `?module=account&action=txlist&address={a}&sort=desc` → `{"message":"OK","result":[…]}` with
  Etherscan-shaped keys (`blockNumber`, `gasUsed`, `input`, `isError`… all strings).
- `?module=contract&action=getabi&address={a}` → `{"message":"OK","result":"<ABI as a JSON string>"}`
  (note: the ABI is a **string** that needs a second `JSON.parse`, exactly like Etherscan).
Useful when you already have Etherscan-shaped parsing code. Same host, same rate-limit bucket.

### Blockscout paths that DO NOT exist
- `/api-docs` → HTTP 404 (an HTML Next.js error page, not JSON).
- `/api/v2/openapi.json` → HTTP 400 `{"message":"Unknown API v2 action"}`. **There is no OpenAPI spec
  at the per-instance host.** Do not go looking for one again; `llms.txt` is the closest thing.

---

## 2. ETHERSCAN / BASESCAN — A CLOSED DOOR. DO NOT RETRY.

Re-confirmed 2026-08-12, three ways:

```
GET https://api.etherscan.io/v2/api?chainid=8453&module=account&action=balance&address=…
→ {"status":"0","message":"NOTOK",
   "result":"Free API access is not supported for this chain. Please upgrade your api plan for full
             chain coverage. https://etherscan.io/apis"}

GET https://api.basescan.org/api?module=account&action=balance&…
→ {"status":"0","message":"NOTOK",
   "result":"You are using a deprecated V1 endpoint, switch to Etherscan API V2 …"}
```
So V1 is dead and V2-free excludes Base. **`chainid=10` (Optimism) returns the identical refusal.**

Per-chain probe of `api.etherscan.io/v2` with **no** key:
| chainid | chain | response |
|---|---|---|
| 1 | Ethereum | `Missing/Invalid API Key` (coverage unknown — untested with a key) |
| 10 | Optimism | **`Free API access is not supported for this chain`** — CLOSED |
| 100 | Gnosis | `Missing/Invalid API Key` (unknown) |
| 130 | Unichain | `Missing/Invalid API Key` (unknown) |
| 137 | Polygon | `Missing/Invalid API Key` (unknown) |
| 8453 | Base | **`Free API access is not supported for this chain`** — CLOSED |
| 42161 | Arbitrum | `Missing/Invalid API Key` (unknown) |

Read the refusals the way `gas_sources` reads paymaster refusals — **AUTH wall vs PAID wall**:
- `Missing/Invalid API Key` = we did not present a key. Says nothing about free coverage.
- `Free API access is not supported for this chain` = a **PAID wall**. A key would not help; a *plan*
  would. That is money, therefore closed to ZERO, permanently.

**Base and Optimism are the two chains where the refusal is a paywall. Never spend another round on
Etherscan for them.** Blockscout is the substitute and it is strictly better for us (source + ABI free).

---

## 3. JSON-RPC — the methods everything else is built on

### `eth_call` — the superpower, and its third parameter
```
params: [ txObject, blockTag, stateOverrideObject? ]
```
`txObject`: `{from, to, data, value?, gas?, gasPrice?}`. **`from` is free and it changes the answer** —
this is how `inspect_contract` proves `callable_now` without spending anything.

**STATE OVERRIDES (3rd param).** Keyed by address; the node enumerated the exact legal fields for me
when I sent a bogus one:
```
error: "unknown field `nonsenseField`, expected one of
        `balance`, `nonce`, `code`, `state`, `stateDiff`, `movePrecompileToAddress`"
```
| field | shape | meaning |
|---|---|---|
| `balance` | `"0x56bc75e2d63100000"` | pretend this address holds N wei |
| `nonce` | `"0x5"` | pretend this nonce |
| `code` | `"0x6080…"` | **replace the runtime bytecode at this address** |
| `stateDiff` | `{ "0x<slot>": "0x<32-byte value>" }` | patch these slots, keep the rest |
| `state` | same shape | **wipe all storage**, then set only these slots |
| `movePrecompileToAddress` | address | relocate a precompile (rarely needed) |

All three forms VERIFIED today on Base:
```
code override:     to=0x…00aa with code 0x602a60005260206000f3   → 0x…2a          ✅
balance override:  from=ZERO's broke EOA, value=1 ETH, WETH.deposit() → 0x (success) ✅
stateDiff:         WETH slot keccak256(abi.encode(EOA, 3)) = 1e18 → balanceOf returns 1e18 ✅
state (full wipe): same slot = 5e17 → balanceOf returns 5e17                      ✅
```
Notes that cost time to learn:
- Base WETH9's `balanceOf` mapping is at **storage slot 3** (`keccak256(abi.encode(holder, 3))`).
  Slots 0,1,2,4 all silently returned the *real* value — a wrong slot guess looks exactly like "the
  override didn't work". Sweep 0..6 and take the slot that moves the answer.
- `balance` override is the answer to *"I cannot simulate this because my EOA has no ETH."* You can.
  Simulate the post-escape world before the escape happens.
- **`code` override is how you faithfully simulate a DELEGATECALL.** A `DELEGATECALL` runs *foreign
  code in your storage and with your address as `msg.sender`/`address(this)`*, so simulating it as a
  plain `to:` call is a different execution and can pass where the real thing reverts (or vice versa).
  The faithful move: **override `code` AT YOUR OWN ADDRESS with the callee's runtime bytecode**, then
  `eth_call` your own address. Now `address(this)`, storage and balance are all genuinely yours and the
  callee's logic is what executes — which is exactly the Safe→MultiSend `operation = 1` case. This is
  the mechanism `sweep.mjs` uses to state-override-simulate a batch "as the Safe".
- Overrides are honoured by publicnode (all 6 chains), drpc, base.org and 1rpc. **meowrpc does not
  support `eth_call` at all.**

### `eth_getBalance(address, blockTag)` → native wei hex. The only balance that is not a token.
### `eth_getCode(address, blockTag)` → runtime bytecode. Empty (`0x`) = EOA or undeployed.
Codesize is a cheap classifier, measured today: Safe proxy **171 bytes** · WETH9 **2041** ·
FiatTokenProxy **1852** · Multicall3 **3808**. A 171-byte contract is a proxy, full stop.

### `eth_getStorageAt(address, slot, blockTag)` → 32 bytes. Free proxy resolution, see §4.
### `eth_getLogs(filter)` — settled truth, and every provider caps it differently
### `eth_estimateGas(txObject)` — costs nothing, and a revert here is a **hard error object**, not a
zero: `{"code":3,"message":"execution reverted"}`. Confirmed today with `WETH.withdraw()` from the Safe
— the 2300-gas-stipend revert from `toolcraft.md` still reproduces. `eth_estimateGas` also accepts a
`from`, and it is the cheapest way to price a candidate before it goes in a MultiSend batch.

### ⚠️ A WRONG TOPIC HASH RETURNS A CLEAN ZERO — this fired on me *while writing this file*
I ran an `eth_getLogs` sweep for ERC-20 `Transfer` on Base WETH across 5 providers × 5 ranges and got
`logs=0` from **every single one**. Twenty-five confident, agreeing, completely false results. Cause:
I had the first 20 bytes of the topic hash from earlier output and **invented the tail**. The real one is
```
Transfer(address,address,uint256) = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
```
Re-run with the correct hash: **2,214 logs in 100 blocks.** Same query, same providers, same second.

This is `toolcraft.md` Trap 2 with a new mask: not a broken provider, a broken *filter*. **Never type a
selector or topic from memory — derive it** (`ethers.id('Transfer(address,address,uint256)')`) and
**run a control**: if a filter you believe should hit *something* returns zero on every provider at once,
the filter is wrong, not the chain. Provider agreement is not evidence when the bug is in your input.
Reference hashes, derived today, not recalled:
```
Transfer(address,address,uint256)  0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
Approval(address,address,uint256)  0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925
Upgraded(address)                  0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b
```

---

## 4. PROXIES — resolve the implementation BEFORE you fingerprint anything

**A proxy's runtime bytecode has NO dispatch table.** It is a ~50–200 byte stub whose whole job is
`DELEGATECALL` to somewhere else. So a `PUSH4` scan over a proxy's code finds nothing (or finds the
stub's one or two selectors), and `gasless_scan`/`bruteforce` will report a contract with no interface.
That is not a contract with no interface. That is a contract you have not resolved yet.

### The slot constants (recomputed from keccak today, not recalled)
```
EIP-1967 implementation = keccak256("eip1967.proxy.implementation") - 1
  0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
EIP-1967 beacon         = keccak256("eip1967.proxy.beacon") - 1
  0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50
EIP-1967 admin          = keccak256("eip1967.proxy.admin") - 1
  0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103

LEGACY zeppelinos implementation = keccak256("org.zeppelinos.proxy.implementation")   [NO -1]
  0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3
LEGACY zeppelinos admin          = keccak256("org.zeppelinos.proxy.admin")            [NO -1]
  0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b

ERC-1822 UUID = keccak256("PROXIABLE")
  0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7
```
**The `-1` is the trap.** EIP-1967 subtracts one from the hash; the older zeppelinos scheme does not.
Get it wrong and you read an all-zero slot, which looks exactly like "not a proxy".

### VERIFIED on Base today — three contracts, three different answers

| contract | EIP-1967 slots | zeppelinos slots | `implementation()` 0x5c60da1b |
|---|---|---|---|
| **USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`** | all zero | **impl `0x2ce6311ddae708829bc0784c967b7d77d19fd779`, admin `0x4fc7850364958d97b4d3f5a08f79db2493f8ca44`** | returns the impl |
| **WETH `0x4200000000000000000000000000000000000006`** | all zero | all zero | returns `0x` (not a proxy) |
| **GENESIS I Safe (retired) `0x510601f59FDa068D70ad6760c9d9085B0F42cbb1`** | all zero | all zero | **REVERTS** |

- **Circle's FiatTokenProxy uses the LEGACY zeppelinos slots.** Checking only EIP-1967 on USDC — the
  single most important token we touch — returns zero and tells you it is not a proxy. It is. Its
  implementation is `0x2ce6311d…`, which is where EIP-3009 `transferWithAuthorization` lives
  (selector `0xe3ee160e`) — the whole gasless-USDC thesis in `toolcraft.md` is behind that resolution.
- **A Safe uses NEITHER.** The singleton address is at plain **storage slot 0**:
  `eth_getStorageAt(safe, 0x0)` → `0x…29fcb43b46531bca003ddc8fcb67ffe91900c762` (SafeL2). Verified.
  Its 171-byte stub is `PUSH20 <mask> SLOAD 0` + a hardcoded answer for `0xa619486e` (`masterCopy()`)
  + a bare delegatecall fallback. So on a Safe: **slot 0, or `masterCopy()` (0xa619486e)** — and
  `implementation()` reverting is the *expected* behaviour, not a failed read.

### The resolution order that covers what we have actually met
1. `eth_getStorageAt(a, EIP1967_IMPL)` → nonzero? done.
2. `eth_getStorageAt(a, EIP1967_BEACON)` → nonzero? then `implementation()` **on the beacon** (two hops).
3. `eth_getStorageAt(a, ZEPPELINOS_IMPL)` → nonzero? done. *(USDC lives here.)*
4. `eth_getStorageAt(a, 0x0)` → looks like a left-padded address? candidate singleton. *(Safe lives here.)*
5. `eth_call implementation()` (`0x5c60da1b`) and `masterCopy()` (`0xa619486e`) directly.
6. Free shortcut: Blockscout `addresses/{a}.proxy_type` + `.implementations[]` — it correctly labelled
   `master_copy` for the Safe and `eip1967_beacon` for a Beefy `BeaconProxy` today. Use it to *guess*,
   confirm with a storage read.

### ⚠️ AND A FALLBACK MAKES SELECTOR-PROBING LIE
`eth_call(WETH, 0xdeadbeef)` → **HTTP 200, `result: "0x"`**. It did not revert. WETH9's fallback is
`deposit()`, so *every* unknown selector "succeeds" with empty returndata. Probing an interface by
"does this selector revert?" gives you a **false positive on every function** against any contract with
a permissive fallback — and a proxy is by definition a permissive fallback.
**Fingerprint from bytecode (`PUSH4` scan of `eth_getCode`), not from call success.** A `0x` return is
"nothing came back", never "the function exists and returned nothing".

---

## 5. PUBLIC RPCs — tested today, with the ones that FAILED named

`eth_blockNumber` against every endpoint, 2026-08-12:

### ✅ WORKING
| chain | id | endpoint | notes |
|---|---|---|---|
| base | 8453 | `https://base-rpc.publicnode.com` | primary; **state-window ~64–96 blocks** |
| base | 8453 | `https://base.drpc.org` | **archive** — reads old state fine |
| base | 8453 | `https://mainnet.base.org` | **archive**; rate-limits CF's shared egress from a Worker |
| base | 8453 | `https://1rpc.io/base` | slow (~1.6–3.9 s), pruned state, getLogs ≤50 blocks |
| optimism | 10 | `https://optimism-rpc.publicnode.com` · `https://mainnet.optimism.io` | both 200 |
| arbitrum | 42161 | `https://arbitrum-one-rpc.publicnode.com` · `https://arb1.arbitrum.io/rpc` | both 200 |
| polygon | 137 | `https://polygon-bor-rpc.publicnode.com` · `https://polygon.drpc.org` | both 200 |
| gnosis | 100 | `https://gnosis-rpc.publicnode.com` · `https://gnosis.drpc.org` · `https://rpc.gnosischain.com` | all 200 |
| unichain | 130 | `https://unichain-rpc.publicnode.com` · `https://unichain.drpc.org` · `https://mainnet.unichain.org` | all 200 |

### ❌ FAILED — do not put these in a failover chain
| endpoint | measured failure |
|---|---|
| `https://base.llamarpc.com` | `error code: 521` (Cloudflare: origin down). Not JSON — a JSON parser throws before you ever see it |
| `https://rpc.ankr.com/base` | `-32000 Unauthorized: You must authenticate your request with an API key` — an AUTH wall, permanently closed to us |
| `https://polygon-rpc.com` | `{"error":"message: API key disabled, reason: tenant disabled, code: -32051"}` — **note it answers on the `error` key with no `jsonrpc` field at all**, so a naive `.result` read yields `undefined` |
| `https://base.meowrpc.com` | `eth_blockNumber` works, but **`eth_call` and `eth_getLogs` are both "not supported"**, and a 5-request burst returned plain-text `Too Many Requests` (not JSON). Useless for us |

### 🔴 THE ARCHIVE GATE — and it is much shallower than anyone assumes
`base-rpc.publicnode.com` returns, for any state read outside its window:
```json
{"code":-32602,"message":"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"}
```
**This is an infrastructure error that reads exactly like an empty result** if your code does
`json.result` without checking `json.error`. It is the single most expensive failure mode in this
project's history (the "0 operations in 9000 blocks" finding that was really 1,401).

Bisected today with `WETH.balanceOf` at `latest - N`:
```
latest-32   ✅ ok          latest-96   ❌ archive
latest-64   ✅ ok          latest-112..2048 ❌ archive
```
**The non-archive window on Base publicnode is between 64 and 96 blocks — roughly 2 minutes at 2 s
blocks.** (Consistent with a standard 128-block in-memory state window minus head drift.) A block from
**6.7 hours ago was refused**; so was one from 4 minutes ago. Practically:
**on publicnode, treat any blockTag other than `latest` as archive-gated.**
`base.drpc.org` and `mainnet.base.org` both served that same historical block correctly.
`1rpc.io/base` refuses differently: `{"code":-32603,"message":"state at block #49871645 is pruned"}` —
and note it names **block+1**, so do not chase the off-by-one.

### `eth_getLogs` caps — every provider, a different number and a different error string
Measured on Base, real Transfer topic, ranges of 10/50/100/1000/10000 blocks:

| provider | 10 | 50 | 100 | 1,000 | 10,000 | the wall |
|---|---|---|---|---|---|---|
| `base-rpc.publicnode.com` | ✅ 231 | ✅ 1016 | ✅ 2214 | ❌ | ❌ | **archive gate** (~64–96 blocks), not a range cap |
| `base.drpc.org` | ✅ | ✅ | ✅ | ❌ | ❌ | `query exceeds max results 20000, retry with the range 49882790-49883500` — **and it hands you the range to retry with** |
| `mainnet.base.org` | ✅ | ✅ | ✅ | ❌ | ❌ | `-32020 backend response too large` |
| `1rpc.io/base` | ✅ | ✅ | ❌ | ❌ | ❌ | `eth_getLogs is limited to 0 - 50 blocks range` |
| `base.meowrpc.com` | ❌ | ❌ | ❌ | ❌ | ❌ | `The method eth_getLogs is not supported` |

Hard block-range caps (hit with an *empty*, cheap filter):
`base.drpc.org` → `ranges over 10000 blocks are not supported on free plan` ·
`mainnet.base.org` → `-32614 eth_getLogs is limited to a 10,000 range`.

**Operational rule:** for history, use **`base.drpc.org`** — it is archive, it caps at 10,000 blocks,
and when the result set is too big it *tells you the exact sub-range to retry*. Chunk to ≤10,000 blocks
and honour its retry hint. `publicnode` is for `latest` only.

### Failover order for the Worker
`publicnode → drpc → 1rpc → base.org` is what `worker.mjs` already does and it is right for `latest`
reads. **But it is wrong for history**: publicnode's archive refusal is a valid JSON-RPC error, so a
failover that only retries on *network* failure will accept it and move on with `undefined`.
**Failover must trigger on `json.error` too, and specifically on `-32602 archive` / `pruned` /
`too large` — and for any non-`latest` blockTag it should skip publicnode entirely.**

### Multicall3 — `0xcA11bde05977b3631167028862bE2a173976CA11`
**Same address on all six chains, and VERIFIED byte-identical today: 3,808 bytes of runtime code on
base, optimism, arbitrum, polygon, gnosis and unichain.** Selectors, derived not recalled:
```
0x82ad56cb  aggregate3((address target,bool allowFailure,bytes callData)[])
              -> (bool success, bytes returnData)[]
0x174dea71  aggregate3Value((address,bool,uint256 value,bytes)[])   payable
0xbce38bd7  tryAggregate(bool requireSuccess,(address,bytes)[])
0x399542e9  tryBlockAndAggregate(bool,(address,bytes)[])
0x252dba42  aggregate((address,bytes)[])          <- reverts the WHOLE batch on any failure
0x4d2301cc  getEthBalance(address)                <- native balances inside a batch
0x42cbb15c  getBlockNumber()
0x3e64a696  getBasefee()
0x0f28c97d  getCurrentBlockTimestamp()
```
**Tuple ordering is `(target, allowFailure, callData)`** and `allowFailure` is the field people drop.
With `aggregate3` + `allowFailure:true` a single reverting probe returns `success:false` instead of
killing the batch — that is what makes `bruteforce` and `payout_oracle` possible. Use `aggregate`
(0x252dba42) **never**; it is the all-or-nothing version. Keep batches ≤100 calls.
`getEthBalance` is the trick for reading native balances of many addresses in one round trip, since
`eth_getBalance` is not a contract call and cannot otherwise be batched.

Other selectors this project keeps needing, all derived today:
```
0x70a08231 balanceOf(address)          0x18160ddd totalSupply()      0x313ce567 decimals()
0x95d89b41 symbol()                    0xd0e30db0 deposit()          0x2e1a7d4d withdraw(uint256)
0x5c60da1b implementation()            0xa619486e masterCopy()       0xffa1ad74 VERSION()
0xe3ee160e transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
0x6a761202 execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)
0x8d80ff0a multiSend(bytes)            0x49404b7c unwrapWETH9(uint256,address)
0xa0e67e2b getOwners()                 0xe75235b8 getThreshold()     0xaffed0e0 nonce()
```

---

## 6. THE TWO LLM ENDPOINTS THE WORKER CAN CALL

Key **names** only (never the values): `ZAI_API_KEY` (in `~/.claude/secrets/autoglmwallet.env`, also a
Worker secret) and `GROQ_API_KEY` (in `~/.claude/secrets/groq.env`).

### z.ai — the Worker's default brain
Two endpoints, **both verified HTTP 200 today**:

| flavour | URL | auth header | body |
|---|---|---|---|
| OpenAI-compatible | `https://api.z.ai/api/paas/v4/chat/completions` | `Authorization: Bearer $ZAI_API_KEY` | `{model, messages, max_tokens, thinking:{type:'disabled'}}` |
| Anthropic-compatible | `https://api.z.ai/api/anthropic/v1/messages` | `x-api-key: $ZAI_API_KEY` + `anthropic-version: 2023-06-01` | `{model, max_tokens, messages}` |

`GLM_BASE=https://api.z.ai/api/paas/v4`, `GLM_MODEL=glm-4.5-flash` (from the project env; the OpenAI
flavour is what `worker.mjs` uses).

Response shapes measured:
```
openai:    {choices:[{finish_reason,index,message:{content,role}}], model, id, request_id,
            usage:{completion_tokens, prompt_tokens, prompt_tokens_details:{cached_tokens}, total_tokens}}
anthropic: {id,type:"message",role,model,content:[{type:"text",text}],stop_reason,
            usage:{input_tokens,output_tokens,cache_read_input_tokens,service_tier}}
```
- `prompt_tokens_details.cached_tokens` / `cache_read_input_tokens` are real — a stable system prompt is
  partially cached across ticks at no extra charge. Keep the front of the prompt byte-stable.
- **`thinking: {type:'disabled'}` remains mandatory for tool-calling** — without it flash spends the
  whole `max_tokens` budget on reasoning and emits no tool call.

🔴 **z.ai RETURNS NO RATE-LIMIT HEADERS.** Measured on both endpoints; the only response headers of any
interest were `x-log-id` and `x-process-time`. **An agent cannot read its remaining z.ai budget.** The
only signal is a 429 after the fact, so back-off must be reactive. Business error codes (from
`https://docs.z.ai/api-reference/api-code.md`, documented-only — none reproduced):
```
1000/1001/1003 → HTTP 401  auth failed / no auth header / token expired
1113 → 429  insufficient balance or no resource package
1211 → 400  unknown model      1213/1214 → 400  missing / invalid parameter
1261 → 400  prompt too long    1301 → 400  content flagged
1302 → 429  rate limit reached for requests
1305 → 429  temporarily overloaded — RETRYABLE, unlike the rest
1308/1310/1316/1317 → 429  usage limit for {5 hours | 7 days | weekly | monthly}, resets at {time}
1309 → 429  Coding Plan expired
```
**Only 1305 (and arguably 1302) deserves an immediate retry. 1308/1310/1316/1317 are window
exhaustion — retrying inside the window is pure waste; read `next_flush_time` and stand down.**
Distinguish them: the outer HTTP status is 429 for all of them, so **you must parse the inner `code`.**
`https://docs.z.ai/api-reference/rate-limit.md` → HTTP 307, zero bytes. No published numbers.

### Groq — `https://api.groq.com/openai/v1` (OpenAI-compatible)
`GET /models` → verified today, free-plan model ids:
```
llama-3.3-70b-versatile · llama-3.1-8b-instant · openai/gpt-oss-120b · openai/gpt-oss-20b
openai/gpt-oss-safeguard-20b · qwen/qwen3.6-27b · groq/compound · groq/compound-mini
whisper-large-v3 · whisper-large-v3-turbo · meta-llama/llama-prompt-guard-2-{22m,86m}
allam-2-7b · canopylabs/orpheus-{v1-english,arabic-saudi}
```

**🟢 GROQ TELLS YOU YOUR REMAINING BUDGET IN EVERY RESPONSE.** Read these headers:
```
x-ratelimit-limit-requests       1000
x-ratelimit-remaining-requests   999
x-ratelimit-reset-requests       1m26.4s        <- a DURATION STRING, not a number
x-ratelimit-limit-tokens         12000  (llama-3.3-70b)  |  8000  (gpt-oss-120b)
x-ratelimit-remaining-tokens     11953
x-ratelimit-reset-tokens         235ms          <- also a duration string
retry-after                      9              <- seconds, present on 429/413 only
x-request-id                     req_01kz…
```
`*-reset-*` are **human duration strings** (`"1m26.4s"`, `"235ms"`, `"622ms"`) — `parseInt` gives you 1
for `"1m26.4s"`. Parse them properly or you will back off for a millisecond.

Documented free-plan table (`https://console.groq.com/docs/rate-limits`, fetched today):
| model | RPM | RPD | TPM | **TPD** |
|---|---|---|---|---|
| llama-3.3-70b-versatile | 30 | 1,000 | 12,000 | **100,000** |
| openai/gpt-oss-120b | 30 | 1,000 | 8,000 | **200,000** |
| openai/gpt-oss-20b | 30 | 1,000 | 8,000 | 200,000 |
| openai/gpt-oss-safeguard-20b | 30 | 1,000 | 8,000 | 200,000 |
| qwen/qwen3.6-27b | 30 | 1,000 | 8,000 | 200,000 |
| llama-3.1-8b-instant | 30 | 14,400 | 6,000 | 500,000 |
| groq/compound / -mini | 30 | 250 | 70,000 | — |
| whisper-large-v3 | 20 | 2,000 | — | 7,200 **audio-seconds**/hr, 28,800/day |
| whisper-large-v3-turbo | 20 | 2,000 | — | same |

**Contradiction, recorded:** the docs table says **RPM 30**; the live header says
`x-ratelimit-limit-requests: 1000`, which is the docs' **RPD** figure. The TPM headers (12,000 / 8,000)
match the docs' TPM column *exactly*, which is strong evidence the headers are trustworthy — so the
requests header is most likely reporting the **daily** cap while the 30/min cap is enforced silently.
**Trust the token headers. Assume 30 RPM is real and do not exceed it.**

**The TPD cap is the one that actually binds ZERO.** 200,000 tokens/day on gpt-oss-120b ÷ 720 cron ticks
(one per 2 min) = **278 tokens per tick**. Groq is a burst tool, not a per-tick brain. z.ai stays the
default; Groq is for latency-critical one-offs and free `whisper-large-v3` transcription.

**🔴 max_tokens IS RESERVED UP FRONT — reproduced deliberately.**
```
POST /chat/completions  model=openai/gpt-oss-120b  max_tokens=9000, prompt=78 tokens
→ HTTP 413, retry-after: 9
   "Request too large for model `openai/gpt-oss-120b` … on tokens per minute (TPM):
    Limit 8000, Requested 9078"
```
78 + 9000 = 9078. **The whole `max_tokens` is charged against TPM before a single token is generated.**
So a generous `max_tokens: 8192` on an 8,000-TPM model **can never succeed at all**, regardless of how
short the answer would have been. Set `max_tokens` to what you actually need. Note the failure is
**HTTP 413**, not 429 — a handler that only retries on 429 will treat a permanently-impossible request
as a hard error, and a handler that only retries on 413 will hammer it forever. It is neither: it is a
*malformed budget*, and the fix is to lower `max_tokens`, not to wait.

**🔴 gpt-oss burns your budget on hidden reasoning.** Measured with `max_tokens: 5`:
```json
{"message":{"role":"assistant","content":"","reasoning":"The user"},"finish_reason":"length"}
```
**`content` was EMPTY and the 5 tokens all went into `message.reasoning`.** This is the exact GLM
`thinking:{type:'disabled'}` failure in a different wrapper, and there is no disable flag — the model
reasons and you pay. Same prompt to `llama-3.3-70b-versatile` with `max_tokens: 5` returned
`content: "ok"` cleanly. **For anything tool-calling or budget-tight on Groq, prefer
`llama-3.3-70b-versatile`; treat gpt-oss `content:""` + `finish_reason:"length"` as "raise max_tokens",
not as "the model refused".**

---

## 7. DEAD OR GATED — recorded so nobody re-tries them

| thing | status | exact response |
|---|---|---|
| `api.etherscan.io/v2?chainid=8453` (Base) | **PAID WALL, permanent** | `Free API access is not supported for this chain` |
| `api.etherscan.io/v2?chainid=10` (Optimism) | **PAID WALL, permanent** | same |
| `api.basescan.org/api` (V1) | **DEPRECATED** | `You are using a deprecated V1 endpoint, switch to Etherscan API V2` |
| `api.blockscout.com/{cid}/api/v2/*` (PRO) | **AUTH WALL** | requires `Authorization: Bearer`, signup at dev.blockscout.com. Use the per-instance hosts instead |
| `rpc.ankr.com/base` | **AUTH WALL** | `-32000 Unauthorized: You must authenticate your request with an API key` |
| `polygon-rpc.com` | **DEAD** | `API key disabled, reason: tenant disabled, code -32051` |
| `base.llamarpc.com` | **DEAD** | Cloudflare `error code: 521`, HTML not JSON |
| `base.meowrpc.com` | **CRIPPLED** | `eth_call` and `eth_getLogs` both "not supported"; bursts return plaintext `Too Many Requests` |
| publicnode, any non-`latest` state read | **ARCHIVE GATE** | `-32602 Archive requests require a personal token` — window is only ~64–96 blocks |
| `base.blockscout.com/api-docs` | **404** | HTML error page |
| `base.blockscout.com/api/v2/openapi.json` | **400** | `{"message":"Unknown API v2 action"}` — no OpenAPI spec exists |
| `docs.z.ai/api-reference/rate-limit.md` | **307, empty** | z.ai publishes no rate-limit numbers |
| `groq.com/llms.txt`, `z.ai/llms.txt` | **404** | the real ones are `console.groq.com/llms.txt` and `docs.z.ai/llms.txt` |
| Groq Dev Tier / Blockscout PRO / Etherscan paid plan | **MONEY** | out of scope by doctrine, not by capability |

---

## 8. THE LAWS THIS FILE EXISTS TO ENFORCE

1. **An index is a hypothesis; `eth_call` is the measurement.** Blockscout was wrong about a balance at
   the block it named, in both directions, today. Find with the index, decide with the node.
2. **Read `json.error` before you believe `json.result`.** publicnode's archive refusal, polygon-rpc's
   tenant-disabled and drpc's max-results are all valid HTTP 200 JSON. A missing `.result` is
   `undefined`, and `undefined` renders as "nothing found".
3. **A clean zero from every provider at once means your FILTER is wrong, not the chain.** Twenty-five
   agreeing zeros today came from a topic hash I typed from memory. Derive selectors and topics; run a
   control that must return something.
4. **Resolve the proxy first.** EIP-1967 subtracts 1 from the hash, zeppelinos does not, USDC uses
   zeppelinos, a Safe uses slot 0, and a proxy's bytecode has no dispatch table to scan.
5. **`0x` is not `false` and success is not existence.** WETH returns HTTP 200 `0x` for `0xdeadbeef`.
   Fingerprint from bytecode, never from "the call didn't revert".
6. **Serialise. `remaining > 0` is not permission.** Blockscout 429'd 16 of 25 parallel requests with
   173 remaining on the counter.
7. **Read the refusal, don't just count it.** `Missing/Invalid API Key` (unknown), `Free API access is
   not supported for this chain` (paid wall, dead), `temporarily overloaded` (retry now), `usage limit
   reached, resets at X` (stand down). Four different words, four different actions.
8. **Budget headers are free intelligence — but only Groq gives them.** Read
   `x-ratelimit-remaining-tokens` before a big call; z.ai gives you nothing and must be handled
   reactively.
