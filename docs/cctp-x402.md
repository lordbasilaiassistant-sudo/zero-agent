# CIRCLE CCTP v2 + x402 MACHINE PAYMENTS
> Corpus entry for ZERO. Fetched 2026-08-12. DOCUMENTATION IS A HYPOTHESIS — the chain is the measurement.
> Sources:
> https://developers.circle.com/llms.txt ·
> https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md ·
> https://developers.circle.com/cctp/references/technical-guide.md ·
> https://developers.circle.com/cctp/references/contract-addresses.md ·
> https://developers.circle.com/api-reference/cctp/all/get-messages-v2 ·
> https://raw.githubusercontent.com/circlefin/evm-cctp-contracts/master/src/v2/TokenMessengerV2.sol ·
> https://raw.githubusercontent.com/circlefin/evm-cctp-contracts/master/src/v2/MessageTransmitterV2.sol ·
> https://iris-api.circle.com/v2/... (live GETs) ·
> https://x402.org/llms.txt ·
> https://raw.githubusercontent.com/coinbase/x402/main/specs/x402-specification-v1.md ·
> https://raw.githubusercontent.com/coinbase/x402/main/specs/x402-specification-v2.md ·
> https://raw.githubusercontent.com/coinbase/x402/main/specs/transports-v2/http.md ·
> https://x402.org/facilitator/supported · https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources ·
> https://zero-agent.broke2built.workers.dev/api/wallet-brief (our own live 402)
>
> Verified on-chain (free eth_call / eth_getCode / eth_getLogs, 2026-08-12):
> · `MessageTransmitterV2.localDomain()` on base=6, optimism=2, arbitrum=3, polygon=7, unichain=10
> · `TokenMessengerV2.localDomain()` **REVERTS on all four chains** — the selector is not in it
> · both CCTP contracts have identical 2,176-byte proxy bytecode on base/op/arb/polygon; resolved
>   their EIP-1967 implementations
> · `usedNonces(deliveredNonce) == 1`, `usedNonces(unknownNonce) == 0`
> · **`receiveMessage()` simulated from `0x…dEaD`, an address that has never touched CCTP, reverted
>   with `"Nonce already used"`** — i.e. it passed every auth check. Permissionless, proven.
> · control: same call with a garbage attestation reverted `"ECDSA: invalid signature 'v' value"`
> · `TokenMinterV2.burnLimitsPerMessage()` = 10,000,000,000,000 (10M USDC) for native USDC and
>   **0 for every bridged USDC** on base/op/arb/polygon/unichain
> · CCTP is **NOT deployed on gnosis (100)** — `eth_getCode` returns `0x` for both contracts
> · byte-parsed a real attested message: header + BurnMessageV2 offsets below are measured, not recalled
> · fee measured at exactly **1.3000 bps** on a live fast transfer, matching the fees API; three live
>   standard transfers had `maxFee=0, feeExecuted=0`

---

## 0. THE TWO SENTENCES THAT MATTER MOST

1. **`minFinalityThreshold = 2000` is a FREE transfer.** Measured on three live burns: `maxFee 0`,
   `feeExecuted 0`. `1000` is the "fast" lane and costs 1.3–1.4 bps. If you are consolidating dust,
   **always 2000**. A 1.3 bps fee on $0.05 rounds to zero anyway, but the fast lane also demands you
   set a non-zero `maxFee` or the burn is rejected — so 2000 is both cheaper and simpler.
2. **`receiveMessage` is permissionless and the caller pays the destination gas.** Somebody else can
   deliver your message. Conversely, when you sell through x402 the BUYER settles on-chain and pays
   the gas. Both facts point the same way: **a broke agent can be on the receiving end of value
   without ever holding gas.**

---

## 1. CONTRACT ADDRESSES

**Same address on every EVM chain.** This is unusual and it is real — verified by `eth_getCode`
returning identical 2,176-byte proxy runtime on base, optimism, arbitrum, polygon, unichain.

| contract | address | note |
|---|---|---|
| **TokenMessengerV2** | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | burn side; you call `depositForBurn` here |
| **MessageTransmitterV2** | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | attestation side; you call `receiveMessage` here |
| **TokenMinterV2** | `0xfd78ee919681417d192449715b2594ab58f5d002` | read `burnLimitsPerMessage` here. VERIFIED same on all 5 chains via `TokenMessengerV2.localMinter()` |

⚠️ **Both are proxies.** (TRAP 3 from `toolcraft.md` — a proxy's bytecode has no dispatch table, so
`gasless_scan` / `bruteforce` against these addresses will find nothing useful.) EIP-1967 impl slot
`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`, read 2026-08-12:

| chain | TokenMessengerV2 impl | MessageTransmitterV2 impl |
|---|---|---|
| base | `0x555e272506c06e7e559d57418563742afe363ec8` | `0x7db629f6acc20be49a0a7565c21cc178e9ac21e3` |
| optimism | `0x555e272506c06e7e559d57418563742afe363ec8` | `0x1f33335414afb7305367452d00a0d024b0184ea8` |
| arbitrum | `0x555e272506c06e7e559d57418563742afe363ec8` | `0x7b93db2bc72faf642cec0adcac4f91718831a1f4` |
| polygon | `0x555e272506c06e7e559d57418563742afe363ec8` | `0xd40518c1a3139e8f1f73f83e5de74e05c88f5ad3` |

Note the TokenMessengerV2 **implementation is the same address on all four chains**; the
MessageTransmitterV2 implementation is **different on every chain** (it is constructed with the local
domain baked in). That asymmetry is the reason for §2.

`feeRecipient()` on TokenMessengerV2 differs per chain (base `0xbea3621e…`, op/arb `0x6efa3205…`,
polygon `0xa64915ea…`). Irrelevant to us but do not assume it is constant.

---

## 2. THE DOMAIN TABLE, AND THE `localDomain()` TRAP

**`TokenMessengerV2` does NOT expose `localDomain()`.** Selector `0x8d3638f4` reverts on it on base,
optimism, arbitrum and polygon — measured, all four. Only `MessageTransmitterV2` answers it.
If your code asks the TokenMessenger which domain it is on, you get `execution reverted`, and if you
swallow that error you get `undefined` → `0` → you burn to **Ethereum**. Ask the MessageTransmitter.

```
localDomain()            0x8d3638f4   MessageTransmitterV2 ONLY
version()                0x54fd4d50   MessageTransmitterV2 ONLY -> returns 1
signatureThreshold()     0xa82f2e26   MessageTransmitterV2 ONLY -> returns 2
paused()                 0x5c975abb   MessageTransmitterV2 ONLY -> returns 0 (live on all 4)
messageBodyVersion()     0x9cdbb181   TokenMessengerV2 ONLY -> returns 1
localMessageTransmitter()0x2c121921   TokenMessengerV2 ONLY
localMinter()            0xcb75c11c   TokenMessengerV2 ONLY
feeRecipient()           0x46904840   TokenMessengerV2 ONLY
usedNonces(bytes32)      0xfeb61724   MessageTransmitterV2
```

### Domain IDs
Doc source: `developers.circle.com/cctp/concepts/supported-chains-and-domains.md` (fetched 2026-08-12).
**VERIFIED on-chain** rows are marked ✅ — I called `localDomain()` and got exactly this number.

| chain | EVM chainId | CCTP domain | |
|---|---|---|---|
| Ethereum | 1 | **0** | documented |
| Avalanche | 43114 | **1** | documented |
| OP Mainnet | 10 | **2** | ✅ measured |
| Arbitrum One | 42161 | **3** | ✅ measured |
| Noble | — | 4 | **V1 ONLY** |
| Solana | — | 5 | documented |
| **Base** | **8453** | **6** | ✅ measured |
| **Polygon PoS** | **137** | **7** | ✅ measured |
| Sui | — | 8 | **V1 ONLY** |
| Aptos | — | 9 | **V1 ONLY** |
| **Unichain** | **130** | **10** | ✅ measured |
| Linea | 59144 | 11 | documented |
| Codex | — | 12 | documented |
| Sonic | 146 | 13 | documented |
| World Chain | 480 | 14 | documented |
| Monad | — | 15 | documented |
| Sei | 1329 | 16 | documented |
| BNB Smart Chain | 56 | 17 | documented |
| XDC | 50 | 18 | documented |
| HyperEVM | 999 | 19 | documented (saw a live 19→6 delivery) |
| Ink | 57073 | 21 | documented |
| Plume | 98866 | 22 | documented |
| Starknet | — | 25 | documented |
| Arc testnet | — | 26 | documented, TESTNET |
| Stellar | — | 27 | documented |
| EDGE | — | 28 | documented |
| Injective | — | 29 | documented (saw a live 6→29 burn) |
| Morph | 2818 | 30 | documented |
| Pharos | — | 31 | documented |
| Cronos | 25 | 32 | documented |
| X Layer | 196 | 37 | documented |
| **Gnosis** | **100** | **NONE** | ✅ measured: `eth_getCode` = `0x` at both contracts. **CCTP does not exist on gnosis.** |

### 🔥 THE COLLISION THAT WILL BITE YOU
- **Unichain: chainId 130, CCTP domain 10.**
- **OP Mainnet: chainId 10, CCTP domain 2.**

So the number `10` means *OP Mainnet* if it is a chainId and *Unichain* if it is a CCTP domain. Any
code that keys a single map by "10" is a live footgun. ZERO runs on both chains. Keep chainId and
domain in differently-named fields and never pass one where the other is expected.

Also: **the domain is NOT the chainId, ever.** Base is chainId 8453 / domain 6. There is no formula.

---

## 3. `depositForBurn` — the burn side

Source: `circlefin/evm-cctp-contracts` `src/v2/TokenMessengerV2.sol`, fetched 2026-08-12.

```solidity
function depositForBurn(
    uint256 amount,               // burn amount, in burnToken's smallest unit (USDC = 6 dp)
    uint32  destinationDomain,    // CCTP DOMAIN, not chainId. See §2.
    bytes32 mintRecipient,        // address LEFT-PADDED to 32 bytes
    address burnToken,            // the NATIVE USDC on this chain. See §7.
    bytes32 destinationCaller,    // bytes32(0) = anyone may deliver. See §5.
    uint256 maxFee,               // cap on the destination-side fee, in burnToken units
    uint32  minFinalityThreshold  // 1000 = fast (paid) · 2000 = standard (free)
) external notDenylistedCallers;
```
selector **`0x8e0250ee`**

```solidity
function depositForBurnWithHook(
    uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken,
    bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold,
    bytes calldata hookData      // reverts "Hook data is empty" if zero-length
) external notDenylistedCallers;
```
selector **`0x779b432d`**

Prerequisite: `USDC.approve(0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d, amount)` on the source chain.

### Parameter shapes that are easy to get wrong
- **`mintRecipient` is `bytes32`, not `address`.** Encode as
  `'0x' + '000000000000000000000000' + addr.slice(2)`. Getting this wrong does not revert — it mints
  to a right-padded garbage address and the money is gone. There is no recovery.
- **`destinationDomain` is a domain.** See the collision warning above.
- **`burnToken` must be the token the local TokenMinter is configured for.** Bridged USDC has
  `burnLimitsPerMessage == 0` and the burn reverts. See §7.
- **`amount` must exceed `maxFee`.** A dust burn with a fast-lane maxFee is a guaranteed revert.

### `maxFee` and `minFinalityThreshold` — measured, not recalled

| `minFinalityThreshold` | name | `maxFee` you must set | what actually happened on-chain |
|---|---|---|---|
| **2000** | Standard / finalized | **0** | ✅ three live base burns (→ domains 1 and 7): `maxFee = 0`, `feeExecuted = 0`, `expirationBlock = 0`. **FREE.** |
| **1000** | Fast / confirmed | > 0, ≥ Iris minimum | ✅ live base→29 burn of 1308.279391 USDC: `maxFee = 0.654139` (5.0000 bps), `feeExecuted = 0.170076` (**exactly 1.3000 bps**) |

The doc says only "1000 = Fast, 2000 = Standard". The *free* part is not stated anywhere I found —
it is inferred from the fees API returning `minimumFee: 0` for threshold 2000 and confirmed by the
three zero-fee messages above.

Anything strictly between is undefined territory; do not invent values.

**The fee is quoted in BASIS POINTS.** `GET /v2/burn/USDC/fees/6/3` returns
`[{"finalityThreshold":1000,"minimumFee":1.3},{"finalityThreshold":2000,"minimumFee":0}]`, and the
live message's `feeExecuted / amount` was 1.3000 bps to four decimals. That is the confirmation that
`minimumFee` is bps and not, say, a dollar amount. It is fetched live, so **read it, don't hardcode
1.3** — it was 1.4 for arbitrum→base in the same minute.

`feeExecuted` is set by the destination and is capped by `maxFee`. Overpaying `maxFee` does not cost
you the difference; it just gives headroom if the rate moves between burn and mint. Setting `maxFee`
below the current minimum means the message attests but can sit unminted.

### `expirationBlock` — a fast-lane-only landmine
Measured: fast messages carry a non-zero `expirationBlock` (e.g. `178457810`, a source-chain block
number); standard messages carry **0 = never expires**. If a fast message is not delivered before
that block it must be **re-attested** (`POST /v2/reattest/{nonce}` on Iris, documented-only, not
tested) before it can be minted. **Standard transfers cannot expire.** One more reason a dust-
consolidating agent should never touch the fast lane.

### The `DepositForBurn` event — the topic hash you will actually need
```solidity
event DepositForBurn(
    address indexed burnToken,
    uint256 amount,
    address indexed depositor,
    bytes32 mintRecipient,
    uint32  destinationDomain,
    bytes32 destinationTokenMessenger,
    bytes32 destinationCaller,
    uint256 maxFee,
    uint32  indexed minFinalityThreshold,
    bytes   hookData
);
```
**topic0 = `0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5`** — ✅ confirmed by
`eth_getLogs` on base returning 48 hits in 900 blocks.

Other topic0s seen on TokenMessengerV2 (base):
- `MintAndWithdraw(address,uint256,address,uint256)` = `0x50c55e915134d457debfa58eb6f4342956f8b0616d51a89a3659360178e1ab63` (the mint side)
- `MessageSent(bytes)` = `0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036` (on MessageTransmitterV2)
- `MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)` = `0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c` ✅ used successfully

⚠️ **The v1 topic is different.** `DepositForBurn(uint64,address,uint256,address,bytes32,uint32,bytes32,bytes32)`
= `0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0`. Filtering with the v1 topic
against the v2 contract returns a clean, confident, completely empty result — TRAP 2.

---

## 4. THE MESSAGE BYTE LAYOUT — parsed from a real attested message

Do not trust a table you remembered. This one was byte-sliced out of
`iris-api.circle.com/v2/messages/6?transactionHash=0x70fc0c0e…549bdd6e`, total 376 bytes,
`status: complete`, on 2026-08-12.

### Header (148 bytes)
| offset | bytes | field | measured value in the specimen |
|---|---|---|---|
| 0 | 4 | `version` | **1** ← v2 messages carry version **1**. (v1 messages carry 0.) |
| 4 | 4 | `sourceDomain` | 6 (base) |
| 8 | 4 | `destinationDomain` | 29 |
| **12** | **32** | **`nonce`** | `0xcb157f294bfdcd4b47ebddebc5f850ed34668dd5313f066f51e9f5b68dc3f9ce` |
| 44 | 32 | `sender` | `0x…28b5a0e9…` (the source TokenMessengerV2) |
| 76 | 32 | `recipient` | `0x…28b5a0e9…` (the dest TokenMessengerV2) |
| 108 | 32 | `destinationCaller` | `0x00…00` = **anyone** |
| 140 | 4 | `minFinalityThreshold` | 1000 |
| 144 | 4 | `finalityThresholdExecuted` | 1000 |
| 148 | … | `messageBody` | see below |

**THE NONCE LIVES AT BYTE OFFSET 12 AND IS 32 BYTES.** `message.slice(2).slice(24, 88)` in hex-char
terms. It is also the indexed `topic[2]` of `MessageReceived`, and Iris returns it as `eventNonce`
and `decodedMessage.nonce` — all three matched in the specimen.

⚠️ **CCTP v1 nonces are `uint64`; v2 nonces are `bytes32`.** Any code that stores a nonce as a number
is v1 code and will silently truncate a v2 nonce to garbage.

### BurnMessageV2 body (offsets relative to byte 148)
| +offset | bytes | field | specimen |
|---|---|---|---|
| +0 | 4 | `version` | 1 |
| +4 | 32 | `burnToken` (bytes32) | base native USDC |
| +36 | 32 | `mintRecipient` | `0x…8f9d40a2…` |
| +68 | 32 | `amount` | 1,308,279,391 = 1308.279391 USDC |
| +100 | 32 | `messageSender` | `0x…8f9d40a2…` |
| +132 | 32 | `maxFee` | 654,139 = 0.654139 USDC (5.0000 bps) |
| +164 | 32 | `feeExecuted` | 170,076 = 0.170076 USDC (**1.3000 bps**) |
| +196 | 32 | `expirationBlock` | 178,457,810 |
| +228 | dyn | `hookData` | length 0 |

So a hookless v2 burn message is exactly **148 + 228 = 376 bytes**. A 376-byte message with a
zero-length tail is the normal case; anything longer carries hook data.

### Attestation
The specimen attestation was **130 bytes = 2 × 65-byte ECDSA signatures**, which matches
`signatureThreshold()` returning **2** (✅ measured on all four chains). Signatures must be
concatenated **in ascending attester-address order**; out of order is a revert, not a soft failure.
Attester public keys are readable free at `GET https://iris-api.circle.com/v2/publicKeys`, tagged
`cctpVersion: 1` or `2`.

---

## 5. `receiveMessage` — PERMISSIONLESS, AND THE REPLAY THAT COST US 12 DAYS

```solidity
function receiveMessage(bytes calldata message, bytes calldata attestation)
    external override whenNotPaused returns (bool success);
```
selector **`0x57ecfd28`**, on **MessageTransmitterV2 `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`**.

The only modifier is `whenNotPaused`. There is no owner, no allowlist, no relayer registry.

### ✅ PROVEN PERMISSIONLESS — the actual test, reproduce it any time
Took a message that had already been delivered on base (from domain 19), pulled its bytes and
attestation from Iris, and `eth_call`ed `receiveMessage` **from `0x000000000000000000000000000000000000dEaD`**,
an address with no history, no balance, no relationship to the transfer:

```
receiveMessage() as 0x…dEaD  ->  execution reverted: "Nonce already used"
receiveMessage() as original ->  execution reverted: "Nonce already used"
CONTROL, garbage attestation ->  execution reverted: "ECDSA: invalid signature 'v' value"
```

Read that carefully. `0x…dEaD` got **all the way to the nonce check**. There is no earlier gate it
could have failed. And the control proves the instrument works — a bad attestation reverts
*differently*, so the "Nonce already used" was not a generic catch-all. **Anyone can deliver anyone's
CCTP message.**

### What permissionless delivery means economically — this is the part ZERO should care about
- The destination gas is paid by **whoever calls `receiveMessage`**, not by the burner. So a wallet
  with USDC on chain A and **zero gas on chain B** can still get its USDC minted on B, *if* someone
  else delivers. Third-party relayers do this routinely for large transfers because Circle's own
  UI/SDK and several bots poll Iris and deliver.
- Nobody will deliver a $0.05 message for you. There is no fee to a relayer for a standard transfer —
  the `feeExecuted` goes to Circle's `feeRecipient`, not to the caller. **Delivering is pure
  altruism-or-self-interest**: relayers deliver messages they themselves burned. So *plan on
  delivering your own*, i.e. you need gas on the destination chain.
- Inverted, this is a capability: **you can deliver other agents' messages.** It costs you the gas
  and pays you nothing on-chain, so it is only a business if you charge off-chain — which is exactly
  what x402 §8 makes possible. "Someone else's transaction carries my state change" (method.md) with
  the roles reversed.
- `destinationCaller != bytes32(0)` closes this: only that address may deliver, and everyone else
  reverts `"Invalid caller for message"`. **Set `destinationCaller = bytes32(0)` unless you have a
  specific MEV reason not to** — a non-zero value means if you lose that key the money is stuck.

### Replay detection — the exact mechanism
```solidity
mapping(bytes32 => uint256) public usedNonces;   // selector 0xfeb61724
// ... inside _validateReceivedMessage:
require(usedNonces[_nonce] == 0, "Nonce already used");
// ... then, before dispatching to the handler:
usedNonces[_nonce] = NONCE_USED;                  // NONCE_USED == 1 (✅ measured)
```
✅ Measured on base: `usedNonces(0x079516453a2b7edb…2703)` = **1** (delivered),
`usedNonces(0x1111…1111)` = **0** (never seen).

### 🚨 THE 12-DAY BUG, AND HOW TO NEVER REPEAT IT
This project retried an already-delivered message for twelve days. The check is **one free
`eth_call`, on the destination chain, before you spend anything**:

```
eth_call { to: 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64,
           data: '0xfeb61724' + nonce.slice(2) }         // nonce = message bytes 12..44
  -> 0x…01  ALREADY DELIVERED. Stop. The USDC is at the mintRecipient. Go look at its balance.
  -> 0x…00  not yet delivered. Proceed.
```
Do this **on the DESTINATION chain**, not the source. `usedNonces` on the source chain will always
read 0 for your own outbound nonce and it means nothing.

And cheaper still: **`eth_call` the whole `receiveMessage` before you send it.** It is free, it is
unlimited, and it tells you the exact revert string. There is never a reason to send a CCTP delivery
transaction that has not been simulated first.

### Revert strings, in execution order
From `MessageTransmitterV2.sol` (fetched 2026-08-12). ✅ = I observed it live.

| # | check | revert string |
|---|---|---|
| 1 | attestation signatures | ✅ `"ECDSA: invalid signature 'v' value"` (observed); also documented: `"Invalid attestation length"`, `"Invalid signature order or dupe"`, `"Invalid signature: not attester"` — **documented-only, I could not fetch the AttesterManager source (404), treat as hypothesis** |
| 2 | message format | (length checks in `MessageV2._validateMessageFormat`) — documented-only |
| 3 | destination domain | `"Invalid destination domain"` |
| 4 | destinationCaller | `"Invalid caller for message"` |
| 5 | message version | `"Invalid message version"` |
| 6 | replay | ✅ `"Nonce already used"` (observed twice) |
| 7 | handler dispatch | `"handleReceiveFinalizedMessage() failed"` / `"handleReceiveUnfinalizedMessage() failed"` |

⚠️ Note the ordering consequence: a **bad attestation masks a used nonce**. If you are debugging and
you see an ECDSA error, you have learned nothing about whether the message was already delivered.

`sendMessage` (generic messaging, no token):
```solidity
function sendMessage(uint32 destinationDomain, bytes32 recipient, bytes32 destinationCaller,
                     uint32 minFinalityThreshold, bytes calldata messageBody) external whenNotPaused;
```
selector `0x14b157ab`.

---

## 6. IRIS ATTESTATION API — free, keyless, no signup

Base URLs: **mainnet `https://iris-api.circle.com`** · testnet `https://iris-api-sandbox.circle.com`.
All GET, no auth header, no key. ✅ Every endpoint below was called live on 2026-08-12.

### `GET /v2/messages/{sourceDomainId}?transactionHash=0x…`
### `GET /v2/messages/{sourceDomainId}?nonce=0x…`
At least one of the two query params is required. Messages for a tx are ordered by ascending log index.

⚠️ **`{sourceDomainId}` is the SOURCE domain — the domain the burn happened on.** Querying the
destination domain returns `404 {"error":"Message not found for provided parameters"}`, which looks
exactly like "no such message". I hit this first try: a message *delivered on base* is not found at
`/v2/messages/6`; it lives at `/v2/messages/19` because it was burned on HyperEVM. **A 404 here means
"wrong domain" far more often than it means "no message".** Get the source domain from the
`MessageReceived` log's first non-indexed word before you query.

Live pending response:
```json
{"messages":[{"attestation":"PENDING","message":null,
  "eventNonce":"0x7c2564fb…ef82","cctpVersion":2,
  "status":"pending_confirmations","decodedMessage":null,"delayReason":null}],
 "sourceTxHash":"0x399b9f2c…4e30a"}
```
Live complete response (truncated):
```json
{"messages":[{"attestation":"0xb88c881f…1c","message":"0x00000001000000060000001d…",
  "eventNonce":"0xcb157f29…f9ce","cctpVersion":2,"status":"complete",
  "decodedMessage":{"sourceDomain":"6","destinationDomain":"29","nonce":"0xcb157f29…f9ce",
    "sender":"0x…","recipient":"0x…","destinationCaller":"0x00…00",
    "minFinalityThreshold":"1000","finalityThresholdExecuted":"1000","messageBody":"0x…"}}],
 "sourceTxHash":"0x70fc0c0e…dd6e"}
```

**Status values observed live:** `pending_confirmations`, `complete`.
Documented additionally: `pending` / `failed` (documented-only — not observed).
There is also a `delayReason` field (null in every specimen I saw).

`decodedMessage` is a convenience. **It is Circle's parse, not yours.** For anything that moves money,
byte-slice `message` yourself using §4 — that is the field `receiveMessage` actually consumes.

### `GET /v2/burn/USDC/fees/{srcDomain}/{destDomain}` — live values, 2026-08-12
```
6 -> 3   [{"finalityThreshold":1000,"minimumFee":1.3},{"finalityThreshold":2000,"minimumFee":0}]
6 -> 2   [{"finalityThreshold":1000,"minimumFee":1.3},{"finalityThreshold":2000,"minimumFee":0}]
3 -> 6   [{"finalityThreshold":1000,"minimumFee":1.4},{"finalityThreshold":2000,"minimumFee":0}]
```
Units are **basis points** (confirmed against the 1.3000 bps `feeExecuted` in §4). Rates differ by
direction, so query the pair you actually intend to use.

### `GET /v2/fastBurn/USDC/allowance`
```json
{"allowance":54656758.473146,"lastUpdated":"2026-08-12T17:45:03.185Z"}
```
Global remaining fast-transfer capacity in USDC. Irrelevant at our size; if it hits 0, fast burns
queue. Standard burns are unaffected.

### `GET /v2/publicKeys`
Returns the attester public keys with `cctpVersion` tags. Use to verify an attestation offline.

### `POST /v2/reattest/{nonce}`
Re-attests an expired pre-finality (fast) message. **Documented-only — not tested, it is a POST and
we spend nothing.** Standard messages never expire so we should never need it.

### Latency — MEASURED, and it is the argument for planning around it
- A fast (1000) burn was `complete` with a full attestation within the window I observed.
- **Two standard (2000) burns on Base were still `pending_confirmations` roughly six minutes after
  the burn.** An older standard burn from ~2.5 hours earlier was `complete`.
- Circle documents standard as "hard finality on the source chain" — on Base/OP/Arb that is an
  L1 finalization, i.e. **on the order of 15 minutes, not seconds.** Do not build a loop that treats
  a 5-minute-old standard burn as failed. Poll with backoff; the message does not expire.
- These are two observations, not a distribution. **Treat any latency number here as a hypothesis
  until your own sweep measures it.**

---

## 7. NATIVE vs BRIDGED USDC — both say `symbol() == "USDC"`

This is the single most dangerous ambiguity in the whole stack, because the wrong token does not
error at approve time; it errors deep inside the burn, or worse, sits in a wallet looking correct.

### ✅ THE TEST THAT ACTUALLY DISCRIMINATES — one free `eth_call`
```
TokenMinterV2 0xfd78ee919681417d192449715b2594ab58f5d002
burnLimitsPerMessage(address token)   selector 0xa56ec632
```
Measured on base, optimism, arbitrum, polygon, unichain, 2026-08-12:

| token | `burnLimitsPerMessage` |
|---|---|
| **native USDC** (every chain) | **10000000000000** = 10,000,000 USDC |
| **any bridged USDC** (every chain) | **0** |

Ten million versus zero. There is no ambiguity, no near-miss, no chain where it differs. **This is
the check. Use it, not the symbol, not the name, not a hardcoded list.** A `burnLimitsPerMessage` of
0 means `depositForBurn` will revert — and it also means the address is not the CCTP token, which is
usually the real thing you wanted to know.

### `name()` as a secondary tell — and why it is NOT sufficient
| chain | token | `symbol()` | `name()` |
|---|---|---|---|
| base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` native | `USDC` | `USD Coin` |
| base | `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` USDbC | `USDbC` | `USD Base Coin` |
| optimism | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` native | `USDC` | `USD Coin` |
| optimism | `0x7F5c764cBc14f9669B88837ca1490cCa17c31607` bridged | **`USDC`** | **`USD Coin`** ← 🔥 |
| arbitrum | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` native | `USDC` | `USD Coin` |
| arbitrum | `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8` bridged | `USDC` | `USD Coin (Arb1)` |
| polygon | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` native | `USDC` | `USD Coin` |
| polygon | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` bridged | `USDC` | `USD Coin (PoS)` |
| unichain | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` native | — | `USDC` |
| gnosis | `0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0` USDC.e | — | (no CCTP on gnosis at all) |

**Look at the optimism row.** Bridged USDC.e on Optimism returns `symbol() == "USDC"` AND
`name() == "USD Coin"` — byte-identical to native. **`name()` does NOT discriminate on Optimism.**
Any heuristic built on strings fails there specifically. `burnLimitsPerMessage` returns 0 vs
10000000000000 on the same pair. That is why it is the test.

(Unichain's native returns `name() == "USDC"`, not `"USD Coin"` — the naming is not even consistent
among natives.)

### Native USDC address per chain — CCTP-burnable
| chain | chainId | domain | native USDC |
|---|---|---|---|
| Base | 8453 | 6 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` ✅ |
| OP Mainnet | 10 | 2 | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` ✅ |
| Arbitrum One | 42161 | 3 | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` ✅ |
| Polygon PoS | 137 | 7 | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` ✅ |
| Unichain | 130 | 10 | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` ✅ |
| Ethereum | 1 | 0 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (documented; not probed) |
| Gnosis | 100 | — | **none — CCTP is not deployed here.** USDC.e `0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0` cannot be bridged by CCTP. |

✅ = `burnLimitsPerMessage` measured at 10,000,000 USDC on 2026-08-12.

**Consequence for ZERO's tributary sweep:** gnosis and unichain are both free-relay chains, but
**gnosis value can never leave by CCTP.** Anything that accrues on gnosis needs a different exit or
must be spent there. Do not write a sweep that assumes six chains all reach Base this way — it is
five.

---

## 8. x402 — the HTTP 402 machine-payment protocol

### The economic fact this project exists on
**In x402 the BUYER constructs and settles the payment on-chain and pays the gas.** The seller only
has to (a) return an HTTP 402 describing what it wants, and (b) verify the payment landed. Verifying
is an `eth_getLogs` / `eth_call` — free. **So an agent with literally zero gas can sell.** That is
the whole reason ZERO has a storefront. It is not a workaround; it is the protocol's shape.

Corollary that is easy to miss: the seller never needs a facilitator either. A facilitator (`/verify`,
`/settle`) is a convenience for sellers who want the *facilitator* to submit the buyer's EIP-3009
authorization on-chain. If instead you accept "buyer already sent the USDC, here is the tx hash",
you need **no third party, no key, no account** — which is what ZERO's `shop.mjs` does.

### ⚠️ TWO INCOMPATIBLE VERSIONS ARE LIVE RIGHT NOW. Do not smooth this over.

| | **v1** (`x402Version: 1`) | **v2** (`x402Version: 2`, dated 2025-12-09) |
|---|---|---|
| requirements delivered in | **JSON response body** | **`PAYMENT-REQUIRED` response header**, base64 JSON |
| client sends | **`X-PAYMENT`** header | **`PAYMENT-SIGNATURE`** header |
| server replies | **`X-PAYMENT-RESPONSE`** header | **`PAYMENT-RESPONSE`** header |
| network field | `"base"` (bare string) | **CAIP-2: `"eip155:8453"`** |
| price field | `maxAmountRequired` | **`amount`** |
| resource | flat `resource` string on each accept | **`resource` object hoisted out of `accepts`** |
| body | required | *"Response bodies are a server implementation concern"* — headers carry everything |

**Which do I trust?** Both, because both are deployed. The v2 spec is the current one in
`coinbase/x402@main/specs/x402-specification-v2.md`, and `https://x402.org/facilitator/supported`
returns **only `x402Version: 2` kinds** — so new clients are v2. But plenty of live sellers still
emit v1 bodies. **A seller should emit BOTH** (v2 header + v1 body); a buyer should read the header
first and fall back to the body.

ZERO's own storefront already does exactly this — ✅ verified live 2026-08-12, `GET
https://zero-agent.broke2built.workers.dev/api/wallet-brief` returns HTTP 402 with a v2
`Payment-Required` header *and* a v1 JSON body. If you are changing `shop.mjs`, do not "clean up"
one of them.

### v1 — 402 response body
```json
{
  "x402Version": 1,
  "error": "payment required",
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "maxAmountRequired": "20000",
    "resource": "https://…/api/wallet-brief",
    "description": "Address activity brief",
    "mimeType": "application/json",
    "outputSchema": {},
    "payTo": "0x510601f59FDa068D70ad6760c9d9085B0F42cbb1",
    "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "maxTimeoutSeconds": 3600,
    "extra": { "name": "USDC", "version": "2" }
  }]
}
```
`maxAmountRequired` / `amount` are **strings in the asset's smallest unit**. `"20000"` = 0.02 USDC.
Not a float, not dollars. `extra.name` / `extra.version` are the **EIP-712 domain** of the asset,
needed by the buyer to sign a `transferWithAuthorization` — get them wrong and every signature the
buyer produces is invalid against your token.

### v2 — decoded `PAYMENT-REQUIRED` header (real, from our own live 402)
```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://zero-agent.broke2built.workers.dev/api/wallet-brief",
    "method": "GET",
    "description": "Plain-language brief on any Base address: …",
    "mimeType": "application/json"
  },
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "20000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x510601f59FDa068D70ad6760c9d9085B0F42cbb1",
    "maxTimeoutSeconds": 3600,
    "extra": { "name": "USD Coin", "version": "2" }
  }],
  "extensions": { "bazaar": { "info": {…}, "schema": {…} } }
}
```
⚠️ The header must be exposed to browsers: `Access-Control-Expose-Headers: Payment-Required,
X-Payment-Response`. Without it a browser-side buyer sees a 402 with no requirements and cannot pay.
CORS is a silent, total failure here.

### `PAYMENT-SIGNATURE` / `X-PAYMENT` — what the buyer sends (base64 JSON)
```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "base",
  "payload": {
    "signature": "0x…",
    "authorization": {
      "from": "0x…", "to": "0x…", "value": "20000",
      "validAfter": "0", "validBefore": "1786560000", "nonce": "0x…32 bytes"
    }
  }
}
```
The `authorization` is an **EIP-3009 `transferWithAuthorization`** — the same signature rail
`toolcraft.md` documents on USDC (`0x833589fC…` → impl `0x2ce6311d…`). This is why x402 settles in
USDC and not WETH: **WETH has no signature rail at all**, so it structurally cannot be an x402
`exact` asset. If a seller advertises WETH as `asset`, that seller is broken.

`validBefore` is a unix timestamp. `maxTimeoutSeconds` in the requirements tells the buyer how much
runway to leave.

### `PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE` — what the seller returns
```json
{ "success": true, "transaction": "0x…", "network": "base", "payer": "0x…", "errorReason": null }
```
v2 adds `amount` and `extensions`.

### Facilitator endpoints (optional — a seller with no gas does not need one)
Free, keyless facilitator: **`https://x402.org/facilitator`** — ✅ live, `GET /supported` returns 200
with no auth and no key. `POST /verify` with an empty body returns
`{"isValid":false,"invalidReason":"missing_parameters",…}` — a clean, well-shaped error, so the
endpoint is real and reachable.

| endpoint | method | shape |
|---|---|---|
| `/supported` | GET | `{"kinds":[{"x402Version":2,"scheme":"exact","network":"eip155:84532"}, …]}` |
| `/verify` | POST | req `{x402Version, paymentPayload, paymentRequirements}` → `{isValid, payer, invalidReason?}` |
| `/settle` | POST | same req → `{success, payer, transaction, network, errorReason?}` |

⚠️ **`https://api.cdp.coinbase.com/platform/v2/x402/supported` returns `Unauthorized`** — the
Coinbase CDP facilitator needs a key. **CDP is hard-banned for us anyway (§5 of global rules).** The
`x402.org/facilitator` one is keyless and is the one to reference. Schemes it advertises live:
`exact`, `upto`, `batch-settlement`, across `eip155:84532` (Base Sepolia), Solana, Algorand, Aptos.
Note that `/supported` there listed **testnet** eip155:84532, not mainnet 8453 — do not assume it
will settle a mainnet payment for you; that needs re-checking before it is load-bearing.

### Discovery
- **`GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=N`** — ✅ **returns
  200 with NO auth**, unlike `/supported` on the same host. This is the "Bazaar": a live index of
  x402-enabled endpoints with their full `accepts` arrays and JSON-Schema'd input/output. This is
  autonomous distribution — an index doing the finding — and it is free to read. Sample item:
  `amount "1000"`, `network "eip155:8453"`, `asset` = base native USDC, scheme `exact` and
  `batch-settlement`.
- **The `extensions.bazaar` block in your own 402 is what gets you indexed.** ZERO already emits one
  with `info.input` / `info.output` / `schema`. Keep it: it is the machine-readable listing.
- `GET /discovery/resources` is also specified on facilitators generally (`type`, `limit`, `offset`
  query params, paginated).
- **`/.well-known/x402`** is the convention ZERO's storefront serves (a catalogue JSON at
  `https://zero-agent.broke2built.workers.dev/.well-known/x402`, 200 OK, 4,288 bytes). ⚠️ **Honesty
  flag: I could not find `.well-known/x402` in either the v1 or v2 spec.** The v2 HTTP transport doc
  explicitly does not mention any `.well-known` path. So this is a **community/our-own convention,
  not a standard** — publish it (it costs nothing and crawlers do look), but do not expect arbitrary
  clients to check it, and do not treat it as the discovery mechanism. The Bazaar is.

---

## 9. THE SHORT VERSION — what to actually do

**Consolidating dust to Base:**
1. `burnLimitsPerMessage(token)` on `0xfd78ee91…d002`. Not 10000000000000? Wrong token, stop.
2. `MessageTransmitterV2.localDomain()` on the destination to get its domain. Never guess, never use chainId.
3. `approve(0x28b5a0e9…cf5d, amount)`, then `depositForBurn(amount, dstDomain, pad32(recipient),
   token, bytes32(0), 0, 2000)`. **maxFee 0, threshold 2000, free.**
4. Poll `GET https://iris-api.circle.com/v2/messages/{SOURCE_domain}?transactionHash=…` until
   `status == "complete"`. Minutes, not seconds. It cannot expire.
5. **Before delivering: `usedNonces(nonce)` on the destination MessageTransmitterV2.** `1` = already
   done, go check the balance. This is the 12-day bug.
6. `eth_call` the `receiveMessage(message, attestation)` first — free, exact revert string. Then send.

**Selling:** return 402 with both a v2 `PAYMENT-REQUIRED` header and a v1 JSON body, expose the
header via CORS, include an `extensions.bazaar` block, price in USDC smallest units as a string, and
verify payment by reading the USDC Transfer log yourself. **You need no gas, no key, and no account
to be the seller.**

---

## 10. DEAD OR GATED — recorded so nobody re-tries them

| URL / call | what happened |
|---|---|
| `https://developers.circle.com/cctp/technical-guide-cctp-apis` | **404.** The Iris API docs are at `developers.circle.com/api-reference/cctp/all/get-messages-v2` instead. |
| `https://raw.githubusercontent.com/coinbase/x402/main/specs/x402-specification.md` | **404** — no unversioned file. Use `x402-specification-v1.md` / `-v2.md`. |
| `https://raw.githubusercontent.com/circlefin/evm-cctp-contracts/master/src/roles/v2/AttesterManager.sol` | **404** — wrong path. The three attestation revert strings in §5 remain **documented-only / unverified**. |
| `https://api.cdp.coinbase.com/platform/v2/x402/supported` | **`Unauthorized`** — needs a CDP key. **CDP is hard-banned for us.** Use `https://x402.org/facilitator/supported`, which is keyless. |
| `https://base-rpc.publicnode.com` + `eth_getLogs` | **`"Archive requests require a personal token"`** — TRAP 2 fired live during this very sweep. publicnode is fine for `eth_call`/`eth_getCode`, **useless for logs**. Use `https://base.drpc.org`, which returned 37 and 48 logs on the identical queries. |
| `https://www.x402.org/protected` | 301 loop to `https://x402.org/protected`; never yielded a 402 demo. |
| `iris-api.circle.com/v2/messages/6?nonce=<a nonce delivered ON base>` | `404 "Message not found"` — **not a dead endpoint**, the domain must be the SOURCE domain. See §6. |
| `POST https://iris-api.circle.com/v2/reattest/{nonce}` | Not tried — it is a POST and this sweep spends nothing. Documented-only. |
| CCTP on **gnosis (100)** | `eth_getCode` = `0x` at both contracts. Genuinely absent, not a lookup failure — the same call on five other chains returned 2,176 bytes. |

---

## 11. REPRODUCE ANY OF THIS

```bash
# domain of the chain you're on (MessageTransmitterV2 ONLY)
curl -s -X POST https://base-rpc.publicnode.com -H 'content-type: application/json' \
 -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x81D40F21F12A8F0E3252Bccb954D722d4c464B64","data":"0x8d3638f4"},"latest"]}'
# -> 0x…06  (base)

# is this token CCTP-burnable? (10000000000000 = yes, 0 = no)
#   burnLimitsPerMessage(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
curl -s -X POST https://base-rpc.publicnode.com -H 'content-type: application/json' \
 -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xfd78ee919681417d192449715b2594ab58f5d002","data":"0xa56ec632000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913"},"latest"]}'

# has this message already been delivered? (0x…01 = YES, STOP)
curl -s -X POST https://base-rpc.publicnode.com -H 'content-type: application/json' \
 -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x81D40F21F12A8F0E3252Bccb954D722d4c464B64","data":"0xfeb61724<32-byte nonce, no 0x>"},"latest"]}'

# current CCTP fee, in basis points, for this exact direction
curl -s https://iris-api.circle.com/v2/burn/USDC/fees/6/3
```
