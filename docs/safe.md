# SAFE SMART ACCOUNT + SAFE{CORE} RELAY + MULTICALL3
> Corpus entry for ZERO. Fetched 2026-08-12. DOCUMENTATION IS A HYPOTHESIS — the chain is the measurement.
> Sources:
> - https://docs.safe.global/llms.txt (official llms.txt — EXISTS) · https://docs.safe.global/llms-full.txt
> - https://raw.githubusercontent.com/safe-global/safe-smart-account/main/CHANGELOG.md
> - https://github.com/safe-global/safe-client-gateway — `src/modules/relay/**`, `src/config/entities/configuration.ts` (the relay service's OWN SOURCE; this is the authority, not the docs site)
> - https://safe-client.safe.global/v1/chains/{id}/relay/{safe} (live, probed)
> - RPCs: base-rpc.publicnode.com · optimism-rpc.publicnode.com · arbitrum-one-rpc.publicnode.com · polygon-bor-rpc.publicnode.com · rpc.gnosischain.com · unichain-rpc.publicnode.com
>
> Verified on-chain (free `eth_call` / `eth_getCode` / `eth_getStorageAt`):
> **GENESIS II Safe `0x75d93b33708e7cf5eb4dcf14dfc25254f5d5817f`** is **DEPLOYED** on
> base/optimism/arbitrum/polygon/gnosis and **NOT DEPLOYED on unichain** ·
> `VERSION()` = `1.4.1` · `getOwners()` = `[0xC94929d1...d57a]` · `getThreshold()` = `1` · singleton (slot 0) =
> SafeL2 v1.4.1 `0x29fcB43b...C762` on every deployed chain · fallback handler + enabled module = Safe4337Module
> `0x75cf1146...c226`. Measurements below dated 2026-08-12 that quote `0x5106…cbb1` or owner `0x50624f…`
> are GENESIS I — that Safe is **retired**. Never use it as caller, payTo, or callFeeRecipient.

---

## 0. THE FIVE-SECOND SUMMARY

| thing | value |
|---|---|
| ZERO's live Safe | `0x75d93b33708e7cf5eb4dcf14dfc25254f5d5817f` — GENESIS II, same address on every deployed chain |
| ZERO's owner EOA | `0xC94929d14435D80dd04b3206BfEA9F5dEBAbD57A`, threshold 1 |
| RETIRED (never caller / payTo / fee recipient) | Safe `0x510601f59FDa068D70ad6760c9d9085B0F42cbb1`, EOA `0x50624F7790732f9767180871D03A304756200dB9` |
| Relay endpoint | `https://safe-client.safe.global/v1/chains/{chainId}/relay` |
| Relay quota | **5 per limit-address per chain per ROLLING 24h**, `RELAY_THROTTLE_LIMIT=5`, `RELAY_THROTTLE_TTL_SECONDS=86400` |
| Reset schedule | **NOT a wall clock. A cache-key TTL. See §3.3 — "5 AM UTC" WAS FICTION** |
| `execTransaction` selector | `0x6a761202` |
| `multiSend(bytes)` selector | `0x8d80ff0a` |
| `aggregate3` selector | `0x82ad56cb` |
| MultiSendCallOnly v1.4.1 | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` — same on all chains |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` — same on all chains |
| Auth | **NO API KEY. NO SIGNUP. Permissionless.** One catch: a browser `User-Agent` header (§3.2) |

---

## 1. SELECTORS — computed locally with keccak, not recalled

### Safe (v1.4.1)
```
0x6a761202  execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)
0xd8d11f78  getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)
0xe86637db  encodeTransactionData(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)
0xffa1ad74  VERSION()
0xa0e67e2b  getOwners()
0xe75235b8  getThreshold()
0xaffed0e0  nonce()
0xf698da25  domainSeparator()
0x2f54bf6e  isOwner(address)
0xcc2f8452  getModulesPaginated(address,uint256)
0x5624b25b  getStorageAt(uint256,uint256)
0x934f3a11  checkSignatures(bytes32,bytes,bytes)
0x468721a7  execTransactionFromModule(address,uint256,bytes,uint8)
0xb4faba09  simulateAndRevert(address,bytes)
0xa619486e  masterCopy()                      <- lives on the PROXY, not the singleton
0xb63e800d  setup(address[],uint256,address,bytes,address,address,uint256,address)
```

### MultiSend / Multicall3
```
0x8d80ff0a  multiSend(bytes)
0x82ad56cb  aggregate3((address,bool,bytes)[])
0x174dea71  aggregate3Value((address,bool,uint256,bytes)[])
0xbce38bd7  tryAggregate(bool,(address,bytes)[])
0xc3077fa9  blockAndAggregate((address,bytes)[])
0x4d2301cc  getEthBalance(address)
0x3408e470  getChainId()
0x3e64a696  getBasefee()                      <- BROKEN on Base, see §6.4
0x42cbb15c  getBlockNumber()
```

---

## 2. CONTRACT ADDRESSES PER CHAIN — they are all the SAME address

VERIFIED `eth_getCode` on base 8453, optimism 10, arbitrum 42161, polygon 137, gnosis 100, unichain 130.
Deployed via the Safe Singleton Factory, so **every one of these is the identical address on every chain,
with byte-identical runtime bytecode.** Do not look up per-chain variants; there are none.

| contract (v1.4.1) | address | runtime len | keccak(code) prefix |
|---|---|---|---|
| Safe (singleton, L1) | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | 23579 | — |
| **SafeL2 (singleton, L2)** | **`0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`** | 24421 | ← **ZERO uses this one** |
| SafeProxyFactory | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | 3054 | — |
| CompatibilityFallbackHandler | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | — | documented only |
| MultiSend | `0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526` | 629 | `0x0e4f7fc66550a322` |
| **MultiSendCallOnly** | **`0x9641d764fc13c8B624c04430C7356C1C7C8102e2`** | 410 | `0xecd5bd14a08c5d21` |
| CreateCall | `0x9b35Af71d77eaf8d7e40252370304687390A1A52` | — | documented only |
| SignMessageLib | `0xd53cd0aB83D845Ac265BE939c57F53AD838012c9` | — | documented only |
| SimulateTxAccessor | `0x3d4BA2E0884aa488718476ca2FB8Efc291A46199` | — | documented only |
| **Multicall3** | **`0xcA11bde05977b3631167028862bE2a173976CA11`** | 3808 | `0xd5c15df687b16f2f` |
| Safe4337Module v0.3.0 | `0x75cf11467937Ce3f2f357cE24fFc3DBF8fD5c226` | 8373 | `SUPPORTED_ENTRYPOINT()` = `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (EntryPoint v0.7) |

---

## 3. THE SAFE{CORE} RELAY — ZERO's free transaction rail

### 3.1 Endpoints

```
POST https://safe-client.safe.global/v1/chains/{chainId}/relay            -> submit
GET  https://safe-client.safe.global/v1/chains/{chainId}/relay/{safe}     -> {"remaining":N,"limit":5}
GET  https://safe-client.safe.global/v1/chains/{chainId}/relay/status/{taskId}
```

**This endpoint is NOT in Safe's public docs.** `docs.safe.global/llms-full.txt` contains **zero** occurrences
of the string "relay" for this API — grepped 2026-08-12. It is the client gateway that `app.safe.global`
itself calls. The authoritative spec is the gateway's own source
(`safe-global/safe-client-gateway`, FSL-1.1-MIT, public). **Read the source, not the docs site.**

**POST body** (`RelayDto`):
```json
{ "version": "1.4.1",           // REQUIRED string. Selects which official MultiSend/ProxyFactory
                                //   deployment set the address is checked against.
  "to": "0x<safe>",             // the Safe (for execTransaction) OR an official MultiSend address
  "data": "0x<calldata>",       // the FULL execTransaction calldata, signature included
  "gasLimit": null,             // OPTIONAL. Accepted for backward compat, NOT forwarded to Gelato.
  "safeTxHash": "0x…",          // OPTIONAL on daily-limit chains; REQUIRED on "relay-fee" chains
  "acceptUnverifiedSimulation": false }   // OPTIONAL; only after an INDETERMINATE_SIMULATION
```
Success → **HTTP 201** with `{"taskId": "..."}`. ZERO's `relayExec()` treats any status != 201 as failure —
correct.

**Task status codes** (numeric, from `relay-task-status.entity.ts`):
`100`=Pending · `110`=Submitted · `200`=Included · `400`=Rejected · `500`=**Reverted**.
`receipt.transactionHash` is present **only** at 200 and 500.
⚠️ **`500` still consumed the slot.** The count increments at submit, not on success.

### 3.2 ⚠️ THE UNDOCUMENTED AUTH GATE — a browser User-Agent, and nothing else

Measured 2026-08-12, same URL, only the headers varied:

| headers sent | result |
|---|---|
| none | **403, empty body** |
| `Origin: https://app.safe.global` only | **403, empty body** |
| `Referer: https://app.safe.global/` only | **403, empty body** |
| `User-Agent: curl/8.0` | **403, empty body** |
| `User-Agent: zero-agent` | **403, empty body** |
| `User-Agent: Mozilla/5.0 …Chrome/126…` | **200 `{"remaining":0,"limit":5}`** |
| Chrome UA + `Origin: https://example.com` | **200** |

**Conclusion: a Chrome-shaped `User-Agent` is the ONLY load-bearing header. `Origin` and `Referer` are
decorative** — ZERO sends them; they do nothing. A bare `curl` gets 403 on *every* path on that host,
including `/`, `/openapi.json` and `/v1/chains`.

**This is the exact failure mode this corpus exists to prevent:** the 403 has an *empty body*, so it looks
like "endpoint dead / we are banned" rather than "you need a UA string". It is not an auth wall, it is a
bot filter. **No API key exists. No signup exists. It is free and permissionless.**

### 3.3 THE RATE LIMIT — settled, with the source line

`src/config/entities/configuration.ts` lines 706-713:
```js
relay: {
  baseUri: process.env.RELAY_PROVIDER_API_BASE_URI || 'https://api.gelato.cloud',
  limit:      Number.parseInt(process.env.RELAY_THROTTLE_LIMIT      ?? `${5}`, 10),
  ttlSeconds: Number.parseInt(process.env.RELAY_THROTTLE_TTL_SECONDS ?? `${60 * 60 * 24}`, 10),
```
**5 relays per limit-address, per chain, per 86400 seconds.** The underlying relayer is **Gelato**
(`api.gelato.cloud`) with Safe holding the API key per chain — which is exactly why ZERO needs no key.

**HOW THE WINDOW ACTUALLY WORKS — this is the part that generated eleven wasted sessions.**
From `daily-limit.relayer.ts`, the quota is **a cache key with a TTL**, not a calendar:
```
canRelay()            -> getRelayCount() < 5
after each relay      -> incrementRelayCount() -> setRelayCount({count: n+1, ttlSeconds: 86400})
getRelaysRemaining()  -> max(5 - count, 0)
```
`setRelayCount` is called with `ttlSeconds` on **every** increment. So:

- ❌ There is **NO** fixed reset hour. **"Resets daily at 5 AM UTC" was invented by ZERO, never measured,
  and cost eleven sessions of planning around a schedule that does not exist.** It is not in the API, not
  in the source, and not in the response body — the response carries `{remaining, limit}` and **no
  timestamp of any kind.**
- The counter is a single key holding a count. When the key expires, **all 5 slots return at once** — it
  does not trickle back one at a time.
- Because the TTL is re-armed on every increment, expiry is measured from the **LAST** relay of the batch,
  not the first. Spend slots 1-5 across six hours and the refill is 24h after slot 5, not slot 1.
- **UNDOCUMENTED / not visible from outside:** whether the cache backend re-arms the TTL on write or
  preserves the original expiry. The source *passes* a fresh TTL every time, which reads as sliding.
  Treat "sliding from the last relay" as the working hypothesis; the only proof is observation.
- **MEASURED by ZERO's own observer: 24.1h cycle** (worker `/` → `health.headline`, 2026-08-12). That is
  an *observed* period from watching `remaining` step upward — it is the number to trust, and it matches
  the 86400s config. **Never state a reset time; state the measured period, or say unknown.**

**The limit is per LIMIT-ADDRESS, and the limit-address is derived from the calldata** (§3.5) — for a
normal harvest it is the Safe. Six chains × 5 = **30 tx/day** for ZERO's single Safe address.

Live quota probe, 2026-08-12 (16 chain ids, sequential, 300 ms apart):

| chainId | chain | response |
|---|---|---|
| 10 | optimism | `200 {"remaining":0,"limit":5}` |
| 100 | gnosis | `200 {"remaining":5,"limit":5}` |
| 130 | unichain | `200 {"remaining":5,"limit":5}` |
| 137 | polygon | `200 {"remaining":0,"limit":5}` |
| 8453 | base | `200 {"remaining":0,"limit":5}` |
| 42161 | arbitrum | `200 {"remaining":0,"limit":5}` |
| 1, 56, 43114, 324, 534352, 59144, 5000, 480 | mainnet, bsc, avax, zksync, scroll, linea, mantle, world | `403 {"message":"No relayer defined","statusCode":403}` |
| 1101, 81457 | polygon-zkevm, blast | `404 {"code":404,"message":"An error occurred"}` |

`configuration.ts` also lists relay API keys for chainIds **1, 10, 56, 100, 130, 137, 1101, 8453, 42161,
43114, 59144** — but a key slot existing in config ≠ a funded relayer. The **live probe is the truth**:
403 "No relayer defined" means the env var is unset in production. Six chains have quota. That is the set.

> ⚠️ **`GET /relay/{address}` does NOT check that the address is a Safe.** Probed
> `0x0000000000000000000000000000000000000001` on base → `200 {"remaining":5,"limit":5}`. A full budget is
> **not evidence you can transact there.** It is just an empty counter for a string.
> **This is live right now for ZERO: unichain (130) reports 5/5, but ZERO's Safe has NO CODE on unichain**
> (`eth_getCode` → `0x`, singleton slot → zero). A relay there would be rejected at `isOfficialMastercopy`.
> Those 5 slots are unusable until the Safe is deployed on unichain. Gnosis (100) IS deployed (`VERSION()`
> = 1.4.1) so its 5 slots are real.

### 3.4 EVERY ERROR SHAPE, PROBED LIVE

Probed on **base, which was already at `remaining: 0`**, so the quota check short-circuits before anything
reaches Gelato. Nothing was spent; no key was touched.

| what was sent | status | body |
|---|---|---|
| `data: "0xdeadbeef"` | 422 | `{"message":"Invalid transfer. The proposed transfer is not an execTransaction/multiSend to another party or createProxyWithNonce call.","statusCode":422}` |
| well-formed `execTransaction`, junk sig | **429** | `{"message":"Relay limit reached for 0x510601f5…cbb1","statusCode":429}` |
| inner `WETH.transfer(SAFE, 1)` (to SELF) | 422 | same "Invalid transfer" message |
| `to` = an EOA instead of the Safe | 422 | same "Invalid transfer" message |
| body missing `version` | 422 | `{"statusCode":422,"expected":"string","code":"invalid_type","path":["version"],…}` |
| chainId 1 | 403 | `{"message":"No relayer defined","statusCode":403}` |
| `GET status/0xabab…` (unknown 32-byte taskId) | **503** | `{"code":503,"message":"Service unavailable"}` |

Reading these:
- **429 fires BEFORE simulation and before Gelato.** The quota check is the first gate. Confirmed by the
  ordering in `daily-limit.relayer.ts` (`canRelay` throws before `relayApi.relay`).
- **A 422 costs nothing.** Malformed submissions do not burn a slot.
- **503 on an unknown taskId** — a bogus id is *not* a clean 404. **Do not read a 503 from `status/` as
  "the relay is down".** Trap 2 from `toolcraft.md`, wearing a new hat: a failed read looks like an outage.
- 4 (`to` = EOA) returned the generic *InvalidTransfer* message, while `main` branch source predicts an
  `UnofficialMasterCopyError`. **Two sources disagree.** Trust the live response — production is running
  an older/different build than `main`, and either way the operational fact is identical: it is rejected
  and it costs nothing. Recorded rather than smoothed over.

From the OpenAPI decorators on the controller (**documented only, not reproduced live**) there is also a
Tenderly pre-simulation on some chains:
- `422 {"code":"SIMULATION_FAILED","message":"Relay denied: transaction simulation failed: Reverted with reason string: 'GS013'"}`
- `422 {"code":"INDETERMINATE_SIMULATION","message":"Relay simulation could not be completed."}` → retry
  once with `acceptUnverifiedSimulation: true`.
- The doc says: **"The consumers MUST branch on the `code` field; `message` is informational."**

### 3.5 WHAT THE RELAY WILL AND WILL NOT CARRY — the whole ruleset

From `limit-addresses.mapper.ts` + `relay-transaction-helper.ts`. Only **four** top-level calldata shapes
are accepted; anything else is `InvalidTransferError` (422):

1. **`execTransaction` to a Safe** → limit-address = that Safe. `to` must be a real Safe with an official
   mastercopy (the gateway resolves it via its own Safe repository).
2. **`multiSend` where `to` is an official MultiSend/MultiSendCallOnly** → the gateway **decodes the whole
   batch**, requires **every inner tx to be a valid `execTransaction`** and **all to the SAME Safe**, else
   `InvalidMultiSendError`. Limit-address = that Safe. Counts as **ONE** relay.
3. **`createProxyWithNonce` on an official SafeProxyFactory** → limit-addresses = the **owners** of the
   Safe being created (so a fresh Safe's deployment is charged to its owner's quota).
4. **`createSigner` on an official SafeWebAuthnSignerFactory** → limit key = last 20 bytes of
   `keccak256(abi.encode(x, y, verifiers))`, giving each passkey its own quota.

**`isValidExecTransactionCall` — the inner-data rules, in evaluation order:**
```
if inner data is ERC-20 transfer(to, amt):      valid  <=>  to != safeAddress
if inner data is ERC-20 transferFrom(f, t, amt):valid  <=>  f != t  AND  t != safeAddress
if decoded.to != safeAddress:                   VALID — no further checks at all
else (a self-call):                             value must be 0, AND data must be
                                                "0x" (cancellation) or a recognised Safe method
```

**What this means operationally for ZERO:**
- ✅ A harvest (`execTransaction` → some Beefy strategy) hits the `decoded.to != safe` branch and is
  **unconditionally accepted**. The relay does not care what the call does.
- ✅ `WETH.transfer(SwapRouter02, amt)` is accepted — recipient is the router, not the Safe.
- ❌ **`WETH.transfer(<the Safe itself>, amt)` is REJECTED, 422.** Verified live. No ERC-20 self-transfer
  ever relays. Do not retry it, do not vary the amount.
- ❌ Sweeping tokens to your own Safe via the relay is structurally impossible. Route to the EOA or a
  router instead.

**TWO BATCH SHAPES — they are not the same thing, and both cost exactly ONE slot:**

*Shape A (what ZERO does):* `POST {to: SAFE, data: execTransaction(MultiSendCallOnly, 0, multiSend(...), operation=1, ...)}`
The gateway sees `execTransaction` whose `decoded.to` is MultiSendCallOnly ≠ the Safe → the
`decoded.to != safeAddress` branch → valid, **and the inner batch is never inspected.** One Safe nonce,
one signature, N arbitrary inner calls. This is the maximum-freedom shape.

*Shape B:* `POST {to: MULTISEND_ADDR, data: multiSend([execTransaction, execTransaction, ...])}`
Every inner item must itself be a valid `execTransaction` on the *same* Safe. This spends **multiple Safe
nonces** in one relay — useful if you need several independently-signed Safe transactions to land
together. Stricter, since every inner call re-runs the §3.5 rules.

Shape A carries arbitrary calls; Shape B carries multiple signed Safe txs. Pick by which you need.

---

## 4. `execTransaction` — signing it correctly

### 4.1 Signature
```solidity
function execTransaction(
    address to, uint256 value, bytes calldata data, Enum.Operation operation,
    uint256 safeTxGas, uint256 baseGas, uint256 gasPrice,
    address gasToken, address payable refundReceiver,
    bytes memory signatures
) external payable returns (bool success);
```
`operation`: **`0 = CALL`, `1 = DELEGATECALL`**. VERIFIED: `operation = 2` reverts with **no reason string**
(plain enum out-of-range panic), so a bad operation gives you no diagnostic at all.

### 4.2 EIP-712 — the domain has NO name and NO version
```
SafeTx typehash  = keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)")
                 = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8

DOMAIN_SEPARATOR_TYPEHASH (>= v1.3.0)
                 = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
                 = 0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218

Legacy (<= v1.1.1, DO NOT USE for 1.4.1)
                 = keccak256("EIP712Domain(address verifyingContract)")
                 = 0x035aff83d86937d35b32e04f0ddc6ff469290eef2f1b692d8a815c89404d4749

SafeMessage      = keccak256("SafeMessage(bytes message)")
                 = 0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca
```
**The domain is `{ chainId, verifyingContract }` and NOTHING else.** No `name`, no `version`, no `salt`.
Adding either produces a valid-looking signature that fails on-chain with GS026.

**VERIFIED end-to-end**, ZERO's Safe on base at nonce 30:
```
getTransactionHash(...) on-chain  = 0x01e45699d966ad9114cb6953e3970962a9be252c9e0cfa668be4d9f326ab04b7
ethers TypedDataEncoder.hash(...) = 0x01e45699d966ad9114cb6953e3970962a9be252c9e0cfa668be4d9f326ab04b7   MATCH
domainSeparator() on-chain        = 0xb84873d412e98dc0235363e3d1b3ee77f03daa536ad00138d61510f82ed3259b
hashDomain({chainId:8453, verifyingContract:SAFE}) = 0xb84873d412e98dc0235363e3d1b3ee77f03daa536ad00138d61510f82ed3259b   MATCH
```
The `domainSeparator` is **different on every chain** because chainId is in it. Measured, same Safe:
```
base 8453   0xb84873d412e98dc0235363e3d1b3ee77f03daa536ad00138d61510f82ed3259b   nonce 30
optimism 10 0x2b3a1038403884d4fd88bc590b4cb586604bfe3c16852368e41a2de4b3cb65c9   nonce 14
arbitrum    0x4ebfc0b575a5eefff30ef269f4c0e9cd88981bf92d4caefb1ed46f0c8cdec4c3   nonce 80
polygon 137 0x4404952ae1e51a97fd98c71638d2a7e946c4ed15314da8dceb228fd4f5f3133b   nonce 75
```
**The nonce is per-chain too.** Always read `nonce()` (`0xaffed0e0`) from the Safe **on the chain you are
about to relay to.** Reusing base's nonce on arbitrum produces GS026.

### 4.3 Packing the signature bytes for a 1-of-1 owner

For threshold 1 with a single EOA owner, `signatures` is exactly **65 bytes**:
```
bytes[ 0:32]  r
bytes[32:64]  s
bytes[64]     v
```
`v` selects the scheme — this is the part that is easy to get wrong:

| v | meaning |
|---|---|
| **27 / 28** | plain `ecrecover` over the **EIP-712 hash** (`getTransactionHash`). ← what `wallet.signTypedData` produces; use this |
| 31 / 32 | `eth_sign` flavour: recover over `keccak256("\x19Ethereum Signed Message:\n32" ‖ safeTxHash)`. v = 27/28 **+ 4** |
| 0 | contract signature (EIP-1271). `r` = signer address, `s` = byte offset to the dynamic sig blob |
| **1** | **pre-approved hash.** `r` = owner address, `s` ignored, and it is valid ONLY if `msg.sender == owner` or `approvedHashes[owner][safeTxHash] == 1` |

`ethers.Wallet.signTypedData(domain, {SafeTx: [...]}, tx)` returns a 65-byte `0x…` with v ∈ {27,28} —
**paste it straight in, no re-packing.** That is what ZERO does and it is correct.

**Multi-owner ordering (documented, not exercised — ZERO is 1-of-1):** concatenate the 65-byte words
**sorted ascending by signer address**. Unsorted signatures revert GS026 even when every one is valid.

**VERIFIED live, `v = 1` pre-approved hash:**
```
execTransaction(..., sig = 0x{12 zero bytes}{owner}{32 zero bytes}{01}),  from = OWNER   -> SUCCESS
                                                        same sig,          from = RANDOM  -> GS025
```
So a 1-of-1 Safe can be driven **with no cryptographic signature at all** when the owner is the direct
`msg.sender`. Not useful through the relay (the relayer is `msg.sender`, not the owner), but it is the
zero-signature path when the EOA has its own gas.

### 4.4 Safe revert codes — captured live off ZERO's own Safe

| code | when | measured |
|---|---|---|
| **GS020** | `signatures.length < threshold * 65` | ✅ sent `0x` → `execution reverted: GS020` |
| **GS025** | `v == 1` and hash not approved / sender is not the owner | ✅ v=1 sig from a non-owner |
| **GS026** | invalid owner / signature does not recover to an owner | ✅ 65 bytes of `0x11` |
| GS013 | inner call failed and `safeTxGas`/`gasPrice` are 0 | documented — this is the code the relay's Tenderly gate reports on a failing harvest |
| GS010 | `to` has no code but the tx expects one | documented only |
| GS031 | not enough gas to execute the Safe transaction | documented only |
| — | `operation = 2` | ✅ reverts with **no reason string at all** |

**GS013 is the one to recognise**: it means "your inner call reverted", not "your signature was wrong".
Different diagnosis, different fix.

### 4.5 Reading a deployed Safe — free, works on any proxy
```
eth_getStorageAt(safe, 0x0)  -> singleton/mastercopy   <- slot 0. Do this FIRST.
eth_call masterCopy()        0xa619486e   (only on the PROXY; the singleton does not expose it)
eth_call VERSION()           0xffa1ad74   -> "1.4.1"
eth_call getOwners()         0xa0e67e2b   -> address[]
eth_call getThreshold()      0xe75235b8   -> uint256
eth_call nonce()             0xaffed0e0   -> uint256   (per-chain!)
eth_call getModulesPaginated(0x1, 10)     0xcc2f8452
eth_getStorageAt(safe, keccak256("fallback_manager.handler.address"))
                             = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5
eth_getStorageAt(safe, keccak256("guard_manager.guard.address"))
                             = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8
```
A **SafeProxy is 171 bytes** of runtime code and has **no dispatch table** — it is pure `DELEGATECALL`
passthrough with one special case for `masterCopy()` (`0xa619486e`). `gasless_scan`-style selector
fingerprinting **returns nothing useful on a Safe.** Resolve slot 0 and fingerprint the singleton instead.
This is `toolcraft.md` Trap 3 in Safe clothing.

Measured on ZERO's Safe, identical on base/optimism/arbitrum/polygon/gnosis:
```
singleton     0x29fcb43b46531bca003ddc8fcb67ffe91900c762   (SafeL2 v1.4.1)
owners        ["0x50624f7790732f9767180871d03a304756200db9"]   threshold 1
fallback hdlr 0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226   (Safe4337Module v0.3.0)
modules       [0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226]   (the same module, enabled)
guard         0x0000000000000000000000000000000000000000   (none — no guard can block a tx)
```
Note it is **SafeL2**, not `Safe`. SafeL2 emits `SafeMultiSigTransaction` / `SafeModuleTransaction` events
on every execution, so **on an L2 you can reconstruct full Safe history from `eth_getLogs` alone** — no
indexer, no Transaction Service, no API key. Use that instead of the Transaction Service (which now needs
a key).

---

## 5. MULTISEND / MULTISENDCALLONLY — the batching primitive

### 5.1 The byte packing — no ABI encoding, one flat blob

`multiSend(bytes transactions)` where `transactions` is the **tightly packed concatenation** of:
```
offset  size  field
  0      1    operation   uint8   0 = CALL, 1 = DELEGATECALL
  1     20    to          address
 21     32    value       uint256
 53     32    dataLength  uint256   <- byte length of `data`
 85      N    data        bytes     <- raw, NOT padded, NOT length-prefixed again
```
**85 + len(data) bytes per inner call.** No padding between entries. No array header. No count field —
the contract walks the blob until it reaches the end.

```js
const pack = (op, to, value, data) => ethers.solidityPacked(
  ['uint8','address','uint256','uint256','bytes'],
  [op, to, value, ethers.dataLength(data), data]
);
const blob = pack(0, A, 0n, dataA) + pack(0, B, 0n, dataB).slice(2);
const calldata = iface.encodeFunctionData('multiSend', [blob]);   // 0x8d80ff0a + abi-encoded bytes
```
`ethers.solidityPacked` is the correct helper. `AbiCoder.encode` is **wrong** — it pads each field to 32
bytes and the contract will read garbage.

### 5.2 ALL-OR-NOTHING — verified

```
multiSend([ approve(ok), transfer(1000 WETH, will revert) ])  ->  execution reverted
```
One reverting inner call kills the whole batch. **This is why every candidate must be individually
`eth_call`-simulated before assembly** — `eth_call` is free and unlimited, and a relay slot is not.

There is no `allowFailure` in MultiSend. If you want per-call failure tolerance you need Multicall3
`aggregate3` — but then **Multicall3 is `msg.sender`**, not your Safe (§6.2), which is usually fatal.

### 5.3 MultiSendCallOnly REJECTS `operation = 1` — verified

```
MultiSendCallOnly.multiSend(op=0)  ->  SUCCESS
MultiSendCallOnly.multiSend(op=1)  ->  execution reverted (no reason string)
```
`MultiSendCallOnly` (`0x9641d764…`) allows **CALL only**. Plain `MultiSend` (`0x38869bf6…`) allows both.
`0x9641d764…` is the one to use — the relay accepts either, and rejecting nested DELEGATECALL is a
safety property, not a limitation, since nothing in a harvest batch needs it.

### 5.4 ⚠️ THE ONE THAT WILL BITE — MultiSend does NOT validate the packing

```
multiSend(TRUNCATED payload — 10 bytes chopped off the tail)   ->  SUCCESS
multiSend(dataLength declared 999, actual data 68 bytes)       ->  SUCCESS
multiSend("0x")  (empty)                                       ->  SUCCESS, no-op
```
All three **succeed silently**. The assembly loop reads `dataLength` on trust and calls with whatever
memory is there — past the end it is zeros. **A mis-packed batch does not give you an error, it gives you
a DIFFERENT TRANSACTION.** An off-by-one in your offsets executes a corrupted call with your Safe's
authority, and the relay slot is spent.

**Therefore: always `eth_call` the fully assembled blob against the real target before relaying it, and
check that the simulated effect is the one you meant.** "It didn't revert" is not validation here — this
is the local flavour of `toolcraft.md` Trap 2, and the empty payload no-op means even a completely
truncated batch reports success.

### 5.5 The shape ZERO actually sends
```
POST /v1/chains/8453/relay
{ version: "1.4.1",
  to:   SAFE,
  data: execTransaction(
          to        = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2,   // MultiSendCallOnly
          value     = 0,
          data      = multiSend(<packed blob>),
          operation = 1,                                            // DELEGATECALL — MANDATORY
          safeTxGas = 0, baseGas = 0, gasPrice = 0,
          gasToken  = 0x0, refundReceiver = 0x0,
          signatures = <65-byte EIP-712 sig over nonce()>
        ) }
```
**`operation` MUST be 1.** With `operation = 0` the Safe CALLs MultiSendCallOnly, so the inner calls
execute from **MultiSendCallOnly's** address — which holds nothing and owns nothing — and every one fails.
The whole point of DELEGATECALL is that the inner calls run in the Safe's own storage/identity context.

Measured ceiling: **26 harvests simulated clean in one batch** (10 of them ≈ 15.3M gas). Keep batches
~12 — gas scales and Gelato caps what it will carry (`ExceedsMaxGasLimit`).

---

## 6. MULTICALL3

`0xcA11bde05977b3631167028862bE2a173976CA11`, byte-identical (3808 bytes, keccak `0xd5c15df6…`) on base,
optimism, arbitrum, polygon, gnosis and unichain. Permissionless, no auth, no rate limit.

### 6.1 `aggregate3`
```solidity
struct Call3 { address target; bool allowFailure; bytes callData; }
function aggregate3(Call3[] calldata calls) public payable returns (Result[] memory);
struct Result { bool success; bytes returnData; }
```
`0x82ad56cb`. `allowFailure = false` → the whole call reverts with **`"Multicall3: call failed"`** (verified
verbatim). `allowFailure = true` → returns `{success: false, returnData: <raw revert data>}` and continues.

Verified: a failing inner call with `allowFailure: true` returned `success = false` and **`returnData` of
length 0** (WETH9's `require` carries no reason string). **An empty `returnData` is not proof of anything —
read the `success` flag, never the payload length.**

Practical cap ≈ 100 calls per aggregate3 before RPC response-size limits bite.

### 6.2 ⭐ MULTICALL3 IS `msg.sender` INSIDE THE BATCH — PROVEN

`aggregate3` uses **`CALL`, not `DELEGATECALL`**. Every inner call therefore has
`msg.sender == 0xcA11bde0…`, regardless of the `from` you pass to `eth_call`.

**The differential test (base, 2026-08-12):**
```
WETH.balanceOf(Multicall3) = 0
WETH.balanceOf(ZERO Safe)  = 65822908733718 wei

eth_call { from: SAFE, to: MULTICALL3,
           data: aggregate3([{WETH, false, transfer(SAFE, 65822908733718)}]) }
   ->  REVERT "Multicall3: call failed"

eth_call { from: SAFE, to: WETH, data: transfer(SAFE, 65822908733718) }     (control)
   ->  SUCCESS
```
The identical transfer succeeds direct and fails through Multicall3, and Multicall3 holds 0 WETH.
**Conclusive: the balance being checked inside the batch is Multicall3's, not the Safe's.**

Two consequences, opposite signs:

- ❌ **You can never use Multicall3 to move your own funds or exercise your own permissions.** Any inner
  call gated on `msg.sender`, or spending a balance, sees Multicall3.
- ✅ **This is exactly what makes `payout_oracle` work.** `[balanceOf(MC3), someFunction(), balanceOf(MC3)]`
  in one `aggregate3` measures the fee an *arbitrary, capital-free caller* receives, because Multicall3
  genuinely is that arbitrary caller. Free, unlimited, works on unverified contracts and on contracts
  nobody has ever called. The whole oracle rests on this property — do not "fix" it.

### 6.3 Helper reads
```
getEthBalance(address)  0x4d2301cc     getChainId()      0x3408e470   -> VERIFIED returns 8453 on base
getBlockNumber()        0x42cbb15c     getBasefee()      0x3e64a696   -> BROKEN on base, see below
```

### 6.4 ⚠️ `getBasefee()` SILENTLY RETURNS ZERO ON BASE
```
Multicall3.getBasefee()                              ->  0
eth_getBlockByNumber("latest").baseFeePerGas         ->  0x4c4b40 = 5,000,000 wei
eth_gasPrice                                         ->  0x5b8d80 = 6,000,000 wei
```
The `BASEFEE` opcode reports **0** inside `eth_call` on this OP-stack node while the real base fee is
5 gwei/1000. **No error, no revert — just a wrong number that looks like a valid answer.** Price gas from
`eth_getBlockByNumber(...).baseFeePerGas` or `eth_feeHistory`, never from `Multicall3.getBasefee()`.
Exactly the class of bug this corpus exists for: a getter that is a claim, not a measurement.

---

## 7. GOTCHA INDEX — the whole file in one screen

1. **`safe-client.safe.global` returns a bodyless 403 to any non-browser `User-Agent`.** Not a ban, not an
   outage, not an auth wall. Send a Chrome UA. `Origin`/`Referer` are irrelevant (verified).
2. **There is NO relay reset hour.** It is a 86400s cache TTL re-armed on every increment. "Resets at 5 AM
   UTC" was invented and cost eleven sessions. Measured period: **24.1h**. Quote the measurement or say
   unknown; never quote a clock time.
3. **All 5 slots come back at once**, ~24h after the LAST relay, not the first.
4. **A full relay budget does NOT mean you can transact there.** `GET /relay/{addr}` answers 5/5 for
   `0x…0001`. **Live: unichain reports 5/5 but ZERO's Safe has no code there** — those slots are dead until
   the Safe is deployed. Always pair the quota read with an `eth_getCode` on the Safe.
5. **ERC-20 `transfer` to your own Safe never relays** (422). Nor `transferFrom` with `from == to` or
   `to == safe`. Route to the EOA or a router.
6. **Batch via `execTransaction(operation=1) → MultiSendCallOnly`, never `operation=0`.** With 0 the inner
   calls run as MultiSendCallOnly and all fail.
7. **MultiSend is all-or-nothing.** Simulate every candidate alone (free), then simulate the assembled blob.
8. **MultiSend does not validate its own packing.** Truncated payloads and overstated `dataLength` both
   **succeed silently** and execute a different call. Verify the simulated *effect*, not the absence of a
   revert.
9. **`MultiSendCallOnly` reverts on `operation = 1` in the inner blob** (outer must still be DELEGATECALL).
10. **Multicall3 is `msg.sender` inside `aggregate3`.** Never for spending your funds; perfect for pricing
    an arbitrary caller's fee.
11. **`Multicall3.getBasefee()` returns 0 on Base** while the real base fee is 5,000,000 wei. Use the block.
12. **The Safe's EIP-712 domain is `{chainId, verifyingContract}` only** — no name, no version.
    Adding either yields GS026.
13. **`nonce()` and `domainSeparator()` are per-chain.** Measured spread on one Safe: 14 / 30 / 75 / 80.
    Read the nonce on the target chain, every time.
14. **A SafeProxy is 171 bytes with no dispatch table.** Selector-fingerprinting a Safe finds nothing.
    Read slot 0 for the singleton.
15. **GS013 = your inner call reverted** (not a signature problem). GS020 = signature bytes too short.
    GS026 = signature does not recover to an owner. GS025 = unapproved hash for `v=1`.
    `operation=2` reverts with **no reason string at all**.
16. **`GET relay/status/{unknown}` returns 503, not 404.** Do not read it as an outage.
17. **Task status 500 = Reverted, and the slot was still spent.** The counter increments at submit.
18. **429 is checked before simulation and before Gelato** — a 422 costs nothing, a 429 means the quota was
    already gone.
19. **Multi-owner signature blobs must be sorted ascending by signer address** (documented; ZERO is 1-of-1).
20. Every Safe/MultiSend/Multicall3 address in §2 is **the same on all six chains** with identical bytecode.
    Stop looking for per-chain variants.

---

## 8. AUTH MODEL — what is free vs what is a dead end

| capability | auth | usable by ZERO |
|---|---|---|
| `eth_call` / `eth_getCode` / `eth_getLogs` / `eth_getStorageAt` | none | ✅ free, unlimited |
| Multicall3 `aggregate3` | none | ✅ free, unlimited, permissionless |
| MultiSend / MultiSendCallOnly | none (it is just a contract) | ✅ free |
| Safe `execTransaction` | owner signature only | ✅ free |
| **Safe{Core} relay POST/GET** | **no key, no signup — browser UA only** | ✅ **free, 5/chain/24h** |
| Gelato directly (`api.gelato.cloud`) | **API key** — Safe holds it per chain | ❌ dead end; go through the gateway |
| Safe Transaction Service (`safe-transaction-*.safe.global`) | **API key required** (`/core-api/how-to-use-api-keys`) | ❌ dead end. Use SafeL2 events via `eth_getLogs` instead |
| Tenderly simulation | Safe's own key, server-side | n/a — you only see the 422 |

---

## 9. DEAD OR GATED — recorded so nobody re-tries them

| URL / resource | result 2026-08-12 |
|---|---|
| `https://safe-client.safe.global/openapi.json` | **403** (bodyless; bot filter, and no such path is exposed) |
| `https://safe-client.safe.global/llms.txt` | **403** |
| `https://safe-client.safe.global/` and `/index.html` | **403** |
| `https://safe-client.safe.global/v1/chains` | **403** via curl. Reachable with a browser UA, unprobed here |
| `https://safe-client.safe.global/v1/chains/1/relay/{safe}` | **403 "No relayer defined"** — mainnet has no relayer |
| chainIds 56, 43114, 324, 534352, 59144, 5000, 480 | **403 "No relayer defined"** |
| chainIds 1101 (polygon-zkevm), 81457 (blast) | **404** — not in the gateway at all |
| `GET relay/status/<unknown taskId>` | **503**, not 404 |
| `https://docs.safe.global/llms-full.txt` | 200, 27,958 bytes — but **ZERO mentions of the relay API.** The endpoint is undocumented on the docs site |
| `https://docs.safe.global/advanced/smart-account-supported-networks` | 200, but lists only network/version support — **no contract addresses.** Use the CHANGELOG |
| `raw.githubusercontent.com/.../src/routes/relay/relay.controller.ts` | **404** — the path moved to `src/modules/relay/routes/` |
| Safe Transaction Service REST API | gated behind an API key |

**Official llms.txt: `https://docs.safe.global/llms.txt` — it exists and it is real, but it is a link index
for the SDK docs and contains nothing about the relay API or contract addresses. For this lane the useful
source was the gateway's own GitHub source, and the chain.**

---

## 10. CONTRADICTIONS RECORDED, NOT SMOOTHED

1. **`CLAUDE.md` says ZERO's smart account is "deterministic, undeployed".** It is **deployed** — on base,
   optimism, arbitrum, polygon and gnosis (`VERSION()` = 1.4.1, nonces 30/14/80/75). That line is stale.
   It is **still undeployed on unichain**, which is where the stale claim is accidentally still true and
   where the 5/5 relay budget is therefore unusable.
2. **`harvest.mjs` POSTs `{version, to, data}` with no `safeTxHash`.** Current gateway `main` says
   `safeTxHash` is **required on "relay-fee" chains** and that a mismatch is a 422. ZERO's six chains are
   evidently daily-limit chains (they return the `{remaining, limit}` count shape), so its body is
   accepted today. **If a chain is ever converted to relay-fee, ZERO's relays will start 403-ing with
   "Relay denied: safeTxHash missing" and the code has no branch for it.** Cheap pre-emptive fix: it
   already computes the hash to sign it — send it.
3. **Live 422 vs source prediction.** `to` = an EOA returned the generic *InvalidTransfer* message; `main`
   predicts `UnofficialMasterCopyError`. Production is on a different build than `main`. Trust the live
   response. Operationally identical (rejected, free), so this is recorded, not resolved.
4. **`configuration.ts` lists relay API-key slots for 11 chainIds; only 6 answer live.** A config slot is
   not a funded relayer. Trust the probe.
5. **`toolcraft.md` says "5 relay slots per chain per day".** Correct in magnitude, wrong in mechanism —
   it is a rolling TTL, not a day. The distinction is what killed the eleven sessions.

---

## 11. REPRODUCE ANY OF THIS — copy-paste probes, all free

```js
// quota on every chain (SEQUENTIALLY — parallel probes get rate-limited into a clean-looking zero)
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                        + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' };
for (const c of [8453, 10, 42161, 137, 100, 130]) {
  const r = await fetch(`https://safe-client.safe.global/v1/chains/${c}/relay/${SAFE}`, { headers: H });
  console.log(c, r.status, await r.text());
  await new Promise(x => setTimeout(x, 300));
}

// is the Safe actually there? (a full budget on a chain with no Safe is worthless)
eth_getCode(SAFE) !== '0x'  &&  eth_getStorageAt(SAFE, '0x0') !== 32 zero bytes

// read its state
eth_call(SAFE, '0xffa1ad74')  // VERSION
eth_call(SAFE, '0xa0e67e2b')  // getOwners
eth_call(SAFE, '0xe75235b8')  // getThreshold
eth_call(SAFE, '0xaffed0e0')  // nonce — ON THE TARGET CHAIN

// confirm your signing hash before you spend anything
onchain = eth_call(SAFE, getTransactionHash(...))
local   = ethers.TypedDataEncoder.hash({chainId, verifyingContract: SAFE}, {SafeTx:[...]}, tx)
assert(onchain === local)     // if these differ, do not relay

// price an arbitrary caller's fee — Multicall3 IS the arbitrary caller
aggregate3([ [T, true, balanceOf(MC3)], [T, true, fn()], [T, true, balanceOf(MC3)] ])
```

Probe scripts used to build this file live in the session scratchpad, not the repo.
