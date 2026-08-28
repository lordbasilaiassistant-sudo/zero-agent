# DEPLOY PLAN — ZeroHarvester → Base, on a never-funded wallet

**HISTORICAL (GENESIS I, 2026-08-01). Do not send.** `contracts/deploy-payload.mjs --i-have-consent`
refuses: beneficiary/`SAFE` is the retired Safe `0x5106…`. Re-pin to `shop.mjs` `SMART_ACCOUNT`
before any live relay.

**Status: built, simulated GREEN, and deliberately not sent.** Nothing was signed, no relay request was
made, no account was created, no wei moved. All measurements 2026-08-01 ~00:00–00:20 UTC against live Base
mainnet (block 49,376,507 → 49,376,900, `https://mainnet.base.org`, reth/v2.3.0, chainId 8453).

---

## THE ADDRESS

```
0x922075A88d80bFb3d8a3dbF6436F6853C1FD6fA9
```

| | |
|---|---|
| CREATE2 factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` (deterministic-deployment-proxy, 69 bytes, live) |
| salt | `0x29346424585bd5e774046c66c09162e8bb8bbdb9364b5e867c59f3921711d6fd` = `keccak256("ZERO/ZeroHarvester/v1")` |
| keccak256(initcode) | `0xa02040cf38bed29731d5cd0f90b1d48f228b7aa6e64c5c1221e31282493dc1ea` |
| initcode | 2,515 bytes (2,483 creation + 32 constructor arg) |
| runtime | 2,306 bytes |
| constructor arg | `beneficiary_ = 0x510601f59FDa068D70ad6760c9d9085B0F42cbb1` (GENESIS I Safe — **retired**) |
| pinned at commit | `0e0c06d` (`contracts/` working tree clean) |

**Verified empty on Base right now** — `eth_getCode` → `0x`, `eth_getBalance` → `0x0`,
`eth_getTransactionCount` → `0x0`. The counterfactual property holds: this address is citable, and can
receive ETH or tokens, before a single wei is spent creating it.

**The address is reproducible from source, not just from the checked-in artifact.** A clean
`forge build --force` into a scratch directory (repo untouched) produced initcode hashing to
`0xa02040cf…dc1ea` — byte-identical to `contracts/out/`. Cross-checked with `cast keccak`, which returns
the same hash independently of ethers.

> Salt choice: `keccak256("ZERO/ZeroHarvester/v1")` over `0x00…00`. Both were measured empty
> (`0x00…00` → `0x1c91d0b1231075839363f093eB6F0210E14b93E2`, also empty), but the zero salt is the most
> contested slot on every chain and a namespaced salt documents intent and versions cleanly.

---

## THE EXACT PAYLOAD

Runnable, self-checking, and **refuses to send by default**:
**`C:/Users/drlor/OneDrive/Desktop/AutoGLMwallet/contracts/deploy-payload.mjs`**

```bash
node contracts/deploy-payload.mjs                    # prints payload + pre-flight, sends nothing
node contracts/deploy-payload.mjs --i-have-consent   # signs and POSTs (spends 1 of 5 daily slots)
```

Without the flag the script `process.exit(0)`s before the key is ever read — the refusal is the default
code path, not a comment, and the send path is additionally gated on every pre-flight check passing.

### Layer 1 — the inner Safe transaction

| field | value |
|---|---|
| `to` | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |
| `value` | `0` |
| `operation` | `0` — **CALL**, not DELEGATECALL. The Safe never delegatecalls anything in this plan, so no deployment path can touch Safe storage. |
| `data` | `salt (32 bytes) ++ initcode` = **2,547 bytes** |

The proxy's calling convention is positional, not ABI-encoded: the first 32 bytes are the salt, everything
after is initcode. Beginning of the actual bytes:

```
0x29346424585bd5e774046c66c09162e8bb8bbdb9364b5e867c59f3921711d6fd   <- salt
  60a03461009857601f6109b338819003918201601f19168301916001600160…   <- initcode
```

### Layer 2 — the Safe wrapper

```solidity
execTransaction(
  to:             0x4e59b44847b379578588920cA78FbF26c0B4956C,
  value:          0,
  data:           <the 2,547 bytes above>,
  operation:      0,
  safeTxGas:      0,
  baseGas:        0,
  gasPrice:       0,          // no refund logic — the Safe holds nothing to refund with
  gasToken:       0x0,
  refundReceiver: 0x0,
  signatures:     <65-byte EIP-712 SafeTx signature by 0x50624F77…0dB9 over nonce 19>
)
```
→ **3,044 bytes** of outer calldata.

### Layer 3 — the relay request

```http
POST https://safe-client.safe.global/v1/chains/8453/relay
User-Agent: Mozilla/5.0 … Chrome/126.0 …
Origin: https://app.safe.global

{ "version": "1.4.1",
  "to":      "0x510601f59FDa068D70ad6760c9d9085B0F42cbb1",
  "data":    "0x6a761202…" }
```

Expected `201` with a `taskId`, then poll `https://api.gelato.digital/tasks/status/{taskId}` to
`ExecSuccess`.

---

## SIMULATION EVIDENCE

### The deployment executes, and the immutable lands correctly

This is the one thing that must be true and that a wrong constructor arg would break **forever** —
`BENEFICIARY` is `immutable`, so it is burned into the runtime bytecode at construction and there is no
setter, no owner, and no upgrade path to fix it afterwards.

Method: a single `eth_call` to Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) whose
`aggregate3` batch is `[deploy via CREATE2 proxy, BENEFICIARY(), MAX_CALLS(), GAS_RESERVE()]`. Sub-calls in
one `aggregate3` share an EVM context, so calls 2–4 execute **against the contract that call 1 just
created** — a real read off freshly deployed code, on live mainnet state, with no fork and no side effects.

```
call[0] CREATE2 success  : true
call[0] returned address : 0x922075A88d80bFb3d8a3dbF6436F6853C1FD6fA9   == PREDICTED ✓
call[1] BENEFICIARY()    : 0x510601f59FDa068D70ad6760c9d9085B0F42cbb1   == GENESIS I Safe (retired; historical) ✓
call[2] MAX_CALLS()      : 256
call[3] GAS_RESERVE()    : 150000
```

The address the EVM actually produced equals the address computed offline — the CREATE2 derivation is
confirmed by execution, not only by arithmetic.

### The full Safe path returns success

```
eth_call  from=0x50624F77…0dB9  to=<Safe>  data=execTransaction(…)
  → 0x0000…0001   (success = true) ✓
```

Method note worth keeping: Safe accepts an **approved-hash signature** (`r = owner`, `s = 0`, `v = 1`) when
`msg.sender` is that owner. That exercises the entire `execTransaction` code path — decoding, threshold
check, the inner CALL, the return — **with no private key and nothing signed.** The real submission uses a
genuine ECDSA signature, which costs slightly more (an `ecrecover`) and is the only difference.

### Post-condition: nothing was sent

```
eth_getCode 0x922075A88d80bFb3d8a3dbF6436F6853C1FD6fA9 → 0x   STILL EMPTY ✓
Safe nonce  → 19 (unchanged)
```

---

## GAS AND SLOT REALITY

| what | gas | at 0.006 gwei / ETH $1,860.61 |
|---|---|---|
| bare CREATE2 through the proxy | 584,791 | $0.00653 |
| **full Safe relay path (`execTransaction` + CREATE2 + 2,306-byte code deposit)** | **661,922** | **$0.00739** |
| Safe wrapper overhead alone | 77,131 | $0.00086 |

Measured via `eth_estimateGas` on the exact calldata above. `eth_gasPrice` = 6,000,000 wei = 0.006 gwei;
base fee 0.005 gwei; ETH = $1,860.61 (Coinbase spot, cross-checked against Kraken at $1,861.61 earlier).

**Does it fit the relay's per-transaction limit?**

- **The gateway imposes none on this path.** `ExceedsMaxGasLimitError` is checked only in
  `NoFeeCampaignRelayer`, not in `DailyLimitRelayer` (which is what serves ZERO's 5/day), and
  `GelatoApi.relay()` forwards only `{chainId, to, data, payment:{type:'sponsored'}}` — it never sends a
  `gasLimit` at all.
- **Gelato publishes no maximum** for `sponsoredCall`. **UNVERIFIED whether an internal cap exists.**
- **Empirical bound, and it is comfortable.** Across ZERO's 19 executed Safe transactions, the relay has
  successfully carried up to **2,928,523 gas** (nonce 11, status `0x1`, relayer `0xe2d4a7ff…`), with
  several others in the 2.0–2.9M range. **The deployment at 661,922 gas is 4.4× below gas the relay has
  already demonstrably carried for this exact Safe.** Base's block gas limit measured 400,000,000, so the
  deploy is 0.17% of a block.
- Forward-looking flag, not a blocker for this deploy: `FINDINGS.md` measures a single Aerodrome COW
  harvest at **3,464,506 gas** — *above* the largest relay transaction observed so far. Batch sizing will
  run into this ceiling long before it reaches `MAX_CALLS = 256`, and the real cap is UNVERIFIED. Worth
  establishing empirically with a deliberately large batch once the contract is live.

**Reconciling the two independent deploy measurements.** `FINDINGS.md` records 576,384 gas / $0.0064 and I
measured 584,791 / $0.00653 for the bare CREATE2 — they differ because they are not the same transaction:
576,384 is a raw `CREATE`, while 584,791 routes through the CREATE2 proxy (extra calldata + an outer CALL
frame), and the two were taken against different bytecode (see failure mode 4). The full relayed cost — the
number that will actually be paid — is **661,922 gas / $0.00739**, and none of it is paid by ZERO.

**One correction worth stating plainly:** `FINDINGS.md` §5 says ZERO "can fund its own first contract out
of its own earnings." Measured tonight, **the EOA holds 0 wei and the Safe holds 0 wei** — the $0.0113 is
token value, not gas. Converting it to ETH would itself require a gas-paying transaction, which is the
circularity the relay exists to break. The sponsored deployment is not a nice-to-have here; it is the only
path that does not require a first funded transaction from somewhere else.

**Slot cost: 1 of 5.** Measured now, all four of ZERO's chains read `{"remaining":0,"limit":5}` — **there is
no slot to spend today.** Confirmed against Safe's own defaults (`configuration.ts`: `limit: 5`,
`ttlSeconds: 86400`). The deploy must wait for the next refill; the script blocks on this automatically.

---

## FAILURE MODES AND THEIR PRE-CHECKS

Ordered by how likely they are to actually bite.

### 1. The initcode differs by one byte → different address, silently — **THIS ALREADY HAPPENED**

Not hypothetical. Between my first memo and this plan the address moved:

| commit | initcode hash | address |
|---|---|---|
| `4ba722b` | `0xe5ac5f71…b97c9` | `0xB5eda258d63a65194546a965E59D6151E8AbddF6` ← now dead |
| `0e0c06d` | `0xa02040cf…dc1ea` | **`0x922075A88d80bFb3d8a3dbF6436F6853C1FD6fA9`** |

The intervening change was **a doc comment** — the `@param data` block on the `Call` struct, warning never
to use the no-arg `harvest()`. solc hashes the source text into the CBOR metadata appended to the bytecode,
so a comment moves the address. Proof that only metadata moved: comparing the two runtimes, the first
differing byte is **2263**, and the CBOR metadata region begins at byte **2253** of 2306 — every executable
byte is identical, and the contract still relocated.

**Pre-check (implemented, `deploy-payload.mjs` step 1):** recompute `keccak256(initcode)` from the artifact
on every run and assert it against the pinned `EXPECTED_INIT_HASH`; assert the derived address against
`EXPECTED_ADDRESS`. Mismatch → refuse before anything else runs. Additionally verified once here that
`forge build --force` reproduces the committed artifact exactly, so the pin is anchored to source, not to a
possibly-stale `out/`.
**Cost if missed:** the slot is spent and a *valid* contract appears at an address nobody wrote down.

### 2. The salt was already used

**Behaviour:** the proxy **reverts** — its 69 bytes end
`…f5 80 15 15 6039 57 8182 fd 5b…`: `CREATE2`, then jump-if-nonzero to the success path, else fall through
to `REVERT`. A collision is a loud on-chain failure, not a silent no-op. But the relay slot is still gone.

**Pre-check (implemented, step 2):** `eth_getCode(predicted) == '0x'` immediately before sending. Measured
`0x` now. Free, one RPC call.
**Note:** a front-runner who deploys this exact initcode is *harmless* — the beneficiary is baked in, so
they deploy our contract at our address and pay for it. The pre-check turns that into "don't spend the
slot", not "we lost something".

### 3. The relay rejects the target

**Cost: nothing.** From `DailyLimitRelayer.relay()`, the order is `getLimitAddresses()` → `canRelay()` →
`relayApi.relay()` → *then* `incrementRelayCount()`. An `InvalidTransferError` is thrown by the first step,
before any counter moves. A rejection is a free `422`, not a burned slot.

**Pre-check:** the validity rules were replicated locally against this exact calldata and all pass —
decodes as `execTransaction` ✓; inner selector is not `transfer`/`transferFrom` ✓; inner `to`
(`0x4e59b448…`) ≠ the Safe, so `!toSelf` returns `true` immediately ✓; `operation` is never inspected ✓;
outer `to` is an official 1.4.1 mastercopy known to the tx service ✓ (its API answered 200 for this Safe).
Residual: **UNVERIFIED** that Safe's deployed gateway matches the `main` branch read here.

### 4. The Safe's nonce moved between building and sending

**Behaviour and cost:** the SafeTx hash commits to the nonce, so a stale signature fails
`checkNSignatures` and `execTransaction` reverts (`GS026`) **on-chain**. Gelato has by then accepted the
task, so the counter has already incremented — **this one does cost a slot.** The most expensive failure of
the four.

**Pre-check (implemented, the send path):** read `nonce()` → sign → **re-read `nonce()` and abort if it
moved** → `eth_call` the *actually signed* calldata (not the approved-hash stand-in) and require `true` →
only then POST. That closes everything but a sub-second race. Measured now: nonce `19`, and ZERO's other
lanes cannot move it while the quota is `0/5`, so the safest window to deploy is the first action after a
refill.

### 5. Relay accepts, Gelato's transaction runs out of gas

Bounded empirically above: 661,922 needed vs 2,928,523 already carried for this Safe. Low risk.
**Detection:** the Gelato task status goes `Cancelled`/`Reverted` rather than `ExecSuccess`; the script
polls for it and exits non-zero. **Cost if it happens: one slot.**

---

## READY-TO-GO CHECKLIST

- [x] Address computed, cross-checked two ways, and verified empty on chain
- [x] Artifact reproduces from source via clean rebuild
- [x] Deployment simulated on live state — succeeds, lands at the predicted address
- [x] `BENEFICIARY()` on the deployed instance returns ZERO's Safe
- [x] Full `execTransaction` path simulated — returns `true`
- [x] Gas measured (661,922) and shown to be 4.4× under gas the relay has already carried
- [x] Payload script written, pre-flighted, and refusing to send by default
- [ ] **A relay slot.** All chains `0/5` right now — blocked until refill.
- [ ] **The founder's go.** One command: `node contracts/deploy-payload.mjs --i-have-consent`

---

### Files

- `C:/Users/drlor/OneDrive/Desktop/AutoGLMwallet/contracts/DEPLOY-PLAN.md` — this document
- `C:/Users/drlor/OneDrive/Desktop/AutoGLMwallet/contracts/deploy-payload.mjs` — the payload builder,
  pre-flight, and gated sender

No ZERO source file was modified. These two files are new.
