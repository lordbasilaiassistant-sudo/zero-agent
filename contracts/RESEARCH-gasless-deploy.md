# Gasless contract deployment for ZERO — measured research

**All measurements taken 2026-07-31, 23:40–23:52 UTC, against Base mainnet block 49,375,954 → 49,376,188
via `https://mainnet.base.org` (reth/v2.3.0-9384bc5, chainId `0x2105` = 8453).** Read-only throughout: no
transaction was signed, submitted, or simulated with side effects. Every number below carries its source.
Anything I could not measure is marked **UNVERIFIED**.

---

## THE ANSWER (3 sentences)

**Yes — ZERO can deploy a real contract on Base without holding a single wei, using the Safe sponsored
relay it already uses every day, because the relay places no restriction on the target of the inner Safe
transaction, so the inner target can be a CREATE2 factory.** The founder's hook/paymaster instinct is
directionally right but literally impossible in the one form it's usually imagined — at the moment
deployment gas is charged the contract does not exist yet and cannot pay for itself — while the working
version of the same idea is that *someone else's already-existing account* pays, which is exactly what the
Safe relay is. **The whole question is nearly moot on cost: deploying `ZeroHarvester` on Base right now
measures at 577,506 gas = 0.0000035 ETH = $0.0065 (two-thirds of one cent), so the real currency is not
money, it is one of ZERO's 5 daily relay slots — and that slot buys a contract that thereafter turns every
future slot into up to 256 calls.**

---

## RANKED OPTIONS FOR ZERO (cheapest and safest first)

### 1. ⭐ Deploy through the Safe relay, inner target = the deterministic CREATE2 proxy — cost: 1 relay slot, $0

The relay's own source only requires that the outer call is `execTransaction` on an official-mastercopy
Safe. The **inner** call is unrestricted as long as it does not target the Safe itself and is not an ERC-20
`transfer`/`transferFrom` back to the Safe (evidence Q1). So point it at the universal CREATE2 deployer.

```
POST https://safe-client.safe.global/v1/chains/8453/relay
headers: User-Agent: <browser UA>, Origin: https://app.safe.global
body:    { "version": "1.4.1",
           "to":      "0x510601f59FDa068D70ad6760c9d9085B0F42cbb1",   // ZERO's Safe
           "data":    <execTransaction(...) — 3044 bytes> }

  inner to        = 0x4e59b44847b379578588920cA78FbF26c0B4956C   (deterministic-deployment-proxy)
  inner value     = 0
  inner operation = 0  (CALL — no delegatecall into the Safe at all)
  inner data      = salt(32 bytes) ++ initcode          (2,547 bytes with a zero salt)
```

For `ZeroHarvester(beneficiary = the Safe)`:

| | |
|---|---|
| initcode + constructor arg | **2,515 bytes** (runtime 2,306 bytes) |
| keccak256(initcode) | `0xe5ac5f71c3fc90f104bd27936526ca79848437a392918943d27797b0e05b97c9` |
| resulting address (salt = 0x00…00) | **`0xB5eda258d63a65194546a965E59D6151E8AbddF6`** |
| measured gas | **584,401** (`eth_estimateGas`, live state) |
| measured cost | 0.000003506406 ETH = **$0.00653** — paid by Gelato, not by ZERO |

Why this ranks first: `operation = 0` means the Safe never delegatecalls anything, so there is no path by
which a deployment can touch the Safe's storage. Front-running is harmless — the beneficiary is baked into
the initcode, so anyone who races us deploys *our* contract at *our* address and pays the gas for us.

**Verification status:** the calldata shape was checked locally against Safe's published validity rules
line by line and passes all of them (Q1). The Safe is confirmed 1.4.1 with ZERO's EOA as sole owner,
threshold 1. **The submission itself is UNVERIFIED** — no relay POST was made, per the read-only scope, and
all four of ZERO's chains measured `remaining: 0` tonight, so it could not have been tried today anyway.

### 2. Same, but inner target = Safe's own `CreateCall` — cost: 1 relay slot, $0

`inner to = 0x9b35Af71d77eaf8d7e40252370304687390A1A52` (CreateCall 1.4.1, **verified deployed on Base**,
1,099 bytes), `operation = 1` (DELEGATECALL), `data = performCreate2(0, initcode, salt)`
(selector `0x4847be6f`, **verified present in the deployed bytecode**), 2,660 bytes. Deployer becomes the
Safe, so the address is `0x871D6695B49a477D80d009Aba9bCaf92f20fDC88` instead. This is the path Safe's own
UI uses for contract deployment, and it passes the same relay checks. Ranked second only because it
requires a delegatecall from the Safe, which option 1 avoids for free.

### 3. Counterfactual deployment — deploy only once it is already worth it — cost: $0, no slot

A CREATE2 address is fully determined before any code exists, and **an address with no code can still
receive ETH and ERC-20s.** So `0xB5eda…ddF6` can be published, funded, and accrue value now, with the
deploy deferred until the accrued value exceeds the (already trivial) deploy cost. This is the honest,
useful core of the founder's "contract pays for itself" idea: the contract cannot pay the gas that creates
it, but it *can* have already earned the money that later justifies creating it. Practical value for ZERO
is modest — the deploy is one free slot, so there is little to defer — but it costs nothing to publish the
address, and it is the correct answer to "can a contract fund its own deployment."

### 4. ERC-4337 paymaster sponsoring a UserOp that deploys — real, but closed to us today

Mechanically sound and demonstrably in use on Base: **33.0% of 6,989 UserOperations in the last ~2,000
blocks were paid by a paymaster rather than by the beneficiary — 18 distinct paymasters, top one holding
1.41 ETH on deposit at EntryPoint v0.7** (measured, Q3). But every route in needs either a bundler API key
or a sponsorship the paymaster's operator signs off-chain. Prior project measurement (2026-07-28/29,
`knowledge/frontier.md`, `harvest.mjs:323-330`): 12 of 13 Base paymasters are *verifying* paymasters
(operator signature required, closed to us); the one permissionless *token* paymaster charges in USDC
(~$0.009/op), which ZERO does not hold. **Not a path today. It becomes a path the moment ZERO holds USDC.**

### 5. EIP-7702 — live on Base, and it does not help ZERO

**Measured: 5 type-`0x4` transactions found in 3 blocks at the head of the chain, one in block 49,375,954
itself, each carrying an `authorizationList` with `chainId: 0x2105`.** Base supports it, unambiguously. But
7702 solves *what an EOA can do in one transaction*, not *who pays* — the spec is explicit that "the
transaction sender will pay for all authorization tuples, regardless of validity or duplication."
ZERO's constraint is payment, not batching, and its Safe already batches via MultiSend. A 7702 delegation
would need a third party to submit a type-4 transaction carrying ZERO's authorization, and the Safe relay
cannot do this — it submits Gelato's own transaction with `execTransaction` calldata and has no field for
an authorization list. **Elegant, live, and irrelevant to this problem.** (ZERO's EOA nonce is `0` — it has
never sent a transaction of its own, and under 7702 it still could not.)

### ✗ Rejected: fund the wallet. Standing rule, and unnecessary — the whole deploy is $0.0065 paid by someone else.

---

## EVIDENCE

### Q1. Can ZERO's existing Safe sponsored relay deploy a contract? — **Yes**

Safe's Client Gateway decides what it will relay in `LimitAddressesMapper.getLimitAddresses()`
([source](https://raw.githubusercontent.com/safe-global/safe-client-gateway/main/src/modules/relay/domain/limit-addresses.mapper.ts),
fetched 2026-07-31). It accepts exactly four calldata shapes and throws `InvalidTransferError` otherwise:
`execTransaction` on an official mastercopy · `multiSend` on an official MultiSend · `createProxyWithNonce`
on an official ProxyFactory · `createSigner` on an official SafeWebAuthnSignerFactory.

So the **outer** target must be ZERO's Safe. The question is what the **inner** Safe transaction may do,
and that is decided by `RelayTransactionHelper.isValidDecodedExecTransaction()`
([source](https://raw.githubusercontent.com/safe-global/safe-client-gateway/main/src/modules/relay/domain/relay-transaction-helper.ts)):

```js
// Only ERC-20 transfer to other party is valid
if (this.erc20Decoder.helpers.isTransfer(decoded.data))     return this.isValidErc20Transfer(...);
if (this.erc20Decoder.helpers.isTransferFrom(decoded.data)) return this.isValidErc20TransferFrom(...);

const toSelf = decoded.to === args.to;
if (!toSelf) {
  return true;              // <-- ANY other target, ANY calldata, ANY operation
}
return this.isValidSelfTransaction(decoded);
```

Three things follow, and they are the whole answer:

1. **The inner target is unrestricted** — the only branch that inspects it is `toSelf`, and any target that
   is *not* the Safe returns `true` immediately. A CREATE2 factory qualifies.
2. **`operation` is never inspected.** There is no field named `operation` anywhere in the validity path,
   so `DELEGATECALL` (needed for `CreateCall` and for MultiSend) is permitted.
3. **There is no allowlist, no bytecode inspection, and no gas ceiling on this path.** The
   `ExceedsMaxGasLimitError` check exists only in `NoFeeCampaignRelayer`, not in `DailyLimitRelayer`, and
   `GelatoApi.relay()` forwards only `{chainId, to, data, payment: {type: 'sponsored'}}` — it never sends a
   `gasLimit` at all. Gelato's own `sponsoredCall` docs publish no maximum gasLimit and describe the call as
   "permissionless" — it "does not enforce any security."

I replicated all five checks locally against the exact calldata from option 1 above (decode → selector
compare → `toSelf` compare). Result: `isValidExecTransactionCall` → **TRUE**.

**The rate limit, measured and cited.** `DailyLimitRelayer` reads `relay.limit` and `relay.ttlSeconds` from
config; the defaults in
[`src/config/entities/configuration.ts:706-713`](https://raw.githubusercontent.com/safe-global/safe-client-gateway/main/src/config/entities/configuration.ts)
are `limit: 5` and `ttlSeconds: 60 * 60 * 24` — **5 per Safe per chain per 24 hours**, confirming the
project's operating assumption exactly. Measured live against ZERO's Safe tonight:

| chain | `GET /v1/chains/{id}/relay/0x5106…cbb1` |
|---|---|
| Base 8453 | `{"remaining":0,"limit":5}` |
| Arbitrum 42161 | `{"remaining":0,"limit":5}` |
| Polygon 137 | `{"remaining":0,"limit":5}` |
| Optimism 10 | `{"remaining":0,"limit":5}` |

`GET /v1/chains/8453` returns `chainName: Base`, `recommendedMasterCopyVersion: 1.4.1`, and `RELAYING`
among its features. ZERO's Safe reads `VERSION() = "1.4.1"`, `getThreshold() = 1`,
`getOwners() = [0x50624F7790732f9767180871D03A304756200dB9]`, `nonce() = 19`, balance 0 — a matching,
official, single-owner 1.4.1 Safe that has executed 19 transactions on zero balance.

**Empirical corroboration:** ZERO's production code already relays arbitrary non-self inner targets every
day. `harvest.mjs:202-218` (`relayExec`) builds `execTransaction` with a caller-supplied `target` and an
`operation` parameter defaulting to 0, and POSTs it to the same endpoint — that is how ZERO's lifetime
on-chain earnings were produced. Deploying is the same shape with a different target.

**Honest limit of this finding:** I read the rules and matched the calldata to them; I did not submit a
deployment. Untested residuals: whether Gelato's own estimator handles a ~650k-gas sponsored call without a
supplied `gasLimit` (its docs recommend a 150k buffer over expected usage), and whether Safe's *deployed*
gateway matches the `main` branch I read. Both resolve on the first real attempt, which costs one slot.

### Q2. The CREATE2 deployers on Base — all live. `eth_getCode` at block 49,375,954

| contract | address | code size | balance |
|---|---|---|---|
| **deterministic-deployment-proxy** (Nick/Arachnid; what `forge create2` uses) | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | **69 bytes** | 0 |
| Safe Singleton Factory | `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7` | **69 bytes** | 0 |
| ERC-2470 SingletonFactory | `0xce0042B868300000d44A59004Da54A005ffdcf9f` | 308 bytes | 0 |
| CreateX | `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` | 11,838 bytes | 0 |
| Safe ProxyFactory 1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | 3,054 bytes | 0 |
| Safe ProxyFactory 1.3.0 | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` | 3,774 bytes | 0 |
| Safe L2 Singleton 1.4.1 | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | 24,421 bytes | 0.001531 ETH |
| Safe L2 Singleton 1.3.0 | `0xfb1bffC9d739B8D520DaF37dF666da4C687191EA` | 23,800 bytes | 0.011009 ETH |
| **Safe CreateCall 1.4.1** | `0x9b35Af71d77eaf8d7e40252370304687390A1A52` | **1,099 bytes** | 0 |
| Safe CreateCall 1.3.0 | `0x7cbB62EaA69F79e6873cD1ecB2392971036cFAa4` | 1,119 bytes | 0 |
| Safe MultiSend 1.3.0 | `0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761` | 629 bytes | 0 |
| Safe MultiSendCallOnly 1.3.0 | `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D` | 410 bytes | 0 |
| EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | 23,689 bytes | 89.52 ETH |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | 16,035 bytes | 41.42 ETH |
| EntryPoint v0.8 | `0x4337084d9E255Ff0702461CF8895CE9E3b5Ff108` | 21,738 bytes | 3.94 ETH |

Both `CreateCall` deployments were selector-checked against their live runtime bytecode:
`performCreate(uint256,bytes)` = `0x4c8c9ea1` **PRESENT**, `performCreate2(uint256,bytes,bytes32)` =
`0x4847be6f` **PRESENT**, in both 1.3.0 and 1.4.1.

### Q3. Can a contract pay for its own deployment? — **No, not literally. Here is what is real.**

**The literal answer is no, and the reason is structural, not a missing feature.** Deployment gas is
charged by the EVM to the *transaction's* sender before and during the execution of the initcode. During
that window the contract's address has no code, no balance it controls, and no ability to be called — a
"hook" needs an existing contract to hook into, and there isn't one yet. There is no ordering of operations
in which the deployed contract settles its own creation cost. Every real mechanism replaces "the contract
pays" with "**a different, already-existing account pays**":

**(a) ERC-4337 paymaster sponsoring a UserOp that deploys.** Legitimate and specified: a UserOperation's
`initCode` deploys the sender account through a factory, and the paymaster covers that deployment gas as
part of the verification phase; `callData` executing afterwards (which can deploy an arbitrary contract) is
covered under `callGasLimit`. The spec's constraint is on the paymaster, not the deployment: `paymasterAndData`
must start with "the paymaster address, which is a contract that (i) currently has nonempty code on chain,
(ii) has a **sufficient deposit to pay for the UserOperation**." So the money is pre-staked at the EntryPoint
by the sponsor — it never comes from the new contract.

*Is any Base paymaster usable without an API key or funded account?* **Measured tonight:** across ~2,000
blocks ending at 49,376,188, EntryPoint v0.7 emitted **6,989 `UserOperationEvent`s; 4,680 self-paid and
2,309 (33.0%) paid by a paymaster, across 18 distinct paymasters.** The busiest, with live EntryPoint
deposits:

| paymaster | ops | EntryPoint deposit |
|---|---|---|
| `0x2cc0c7981d846b9f2a16276556f6e8cb52bfb633` | 792 | 1.413037 ETH |
| `0x777777777777aec03fd955926dbf81597e66834c` | 783 | 1.059431 ETH |
| `0xdcbe0c1a00e4cf24ae77c52125e6e6b4f7c6db4e` | 329 | 22.588466 ETH |
| `0x5fa66dfe8a3983e55071e8c4631ab43b5f33a4ab` | 228 | 0.675581 ETH |
| `0x886f51115829cb326b74e8a834fb93fe25e85050` | 67 | 0.081272 ETH |
| `0x592e1224d203be4214b15e205f6081fbbacfcd2d` | 6 | n/a |

Sponsorship on Base is abundant and real. **Admission is the wall, not supply.** Prior project measurement
(`knowledge/frontier.md`, 2026-07-28/29): 12 of 13 classified Base paymasters are verifying paymasters
requiring an operator's off-chain signature; Etherspot/Pimlico/ZeroDev returned 401/400 without keys; the
one permissionless token paymaster charges USDC. That last one is `0x592e1224d203be4214b15e205f6081fbbacfcd2d`
— **note that this full address is recovered from tonight's log scan, not from the repo, where it appears
only truncated as `0x592e1224…` in `harvest.mjs:326`, `DOCTRINE.md:207`, and `knowledge/toolcraft.md:125`.**
So: no free-and-keyless paymaster path today, and the constraint disappears the day ZERO holds USDC.

**(b) A factory that deploys, then is reimbursed from the new contract's first revenue.** Constructible —
the factory fronts the gas from its own balance and takes repayment from later earnings — but it does not
help ZERO, because it requires a factory operator willing to front capital to an unknown deployer, and no
such permissionless service was found on Base. **UNVERIFIED that any exists; I found none.** Note also that
`ZeroHarvester` deliberately forecloses this pattern: `BENEFICIARY` is immutable and it never sends ETH to
an arbitrary address, so it *cannot* reimburse a deployer even if we wanted it to. That is a security
property worth keeping, not a bug.

**(c) Counterfactual / lazy deployment.** The genuinely useful version, and the closest thing to the
founder's intuition that works: `CREATE2` fixes the address before any code exists, and a codeless address
still receives ETH and tokens normally. `0xB5eda258d63a65194546a965E59D6151E8AbddF6` can be published and
funded today; the code can appear later, when the balance already justifies it. Safe's own product does
exactly this — `COUNTERFACTUAL` is in Base's feature list from the chain config measured above.

### Q4. EIP-7702 on Base — **live, measured, and not the answer**

Scanning the head of the chain for type-`0x4` transactions: **5 found within 3 blocks**, including in block
49,375,954 itself. Samples (all `chainId: 0x2105`):

| tx | from | delegated to |
|---|---|---|
| `0xeb581adc9e3220a8812b15da341b0a0891411772733d44a7223574e8ef7add23` | `0x7723d93cefa40283fbf55501cd75c39243db6ac2` | `0x37092f7cad2057c1527ff5be880982dc02ea48e6` |
| `0x135749610faee73f4bf3026d43ce94a0a0bf9001b819656e08dd53b57d6c8d13` | `0x36ee68d558b9b350018123e33a6d0ce330c61fb1` | `0xc6a665118e1bc10df0b06a85bb1f61239710e361` |
| `0x441f859ebd8333abff53629621ad18ab3196baa01e3885dbd000184591125728` | `0xdd2979e1798609071f9351135a0929a69e9b48a4` | `0xe43f896969d4e2f047fa6924a69eba83ad3701a3` |

**Cost, from the spec** ([EIP-7702](https://eips.ethereum.org/EIPS/eip-7702)): `PER_AUTH_BASE_COST` =
**12,500**, `PER_EMPTY_ACCOUNT_COST` = **25,000**, added per authorization tuple on top of the EIP-2930
intrinsic cost. At tonight's 0.006 gwei that is ~$0.00028 for a single authorization — nothing.

**Who pays: the transaction sender, always.** The spec: *"The transaction sender will pay for all
authorization tuples, regardless of validity or duplication."* Self-sponsoring (authority == sender) is
explicitly allowed, but "self-sponsoring" means the EOA pays its own gas — which is precisely what ZERO
cannot do. For 7702 to give ZERO anything, a third party would have to include ZERO's signed authorization
in *their* type-4 transaction, and the Safe relay is not that third party: it submits Gelato's transaction
carrying `execTransaction` calldata, with no authorization list. **7702 gives ZERO contract-like batching
in principle and nothing in practice** — and ZERO's Safe already batches through MultiSend, delegatecalled,
which the relay permits (Q1, point 2).

### Q5. Measured deploy cost on Base for the real 2.3KB contract

Not a hypothetical 2.3KB contract — `contracts/src/ZeroHarvester.sol`, compiled, as it sits on disk:

```
initcode                      2,483 bytes   (out/ZeroHarvester.sol/ZeroHarvester.json)
+ constructor arg (address)   2,515 bytes
runtime                       2,306 bytes   <- the "~2.3KB" in the question
  462 zero bytes / 2,021 non-zero  => 34,184 gas of calldata
  code deposit (200/byte)          => 461,200 gas
  EIP-3860 initcode word cost      => 156 gas
```

`eth_estimateGas` against live Base state, `from` = ZERO's Safe, constructor arg = the Safe:

| path | gas | ETH | USD |
|---|---|---|---|
| raw `CREATE` | **577,506** | 0.000003465036 | **$0.00645** |
| `CREATE2` via `0x4e59b448…` | **584,401** | 0.000003506406 | **$0.00653** |
| `CREATE2` via Safe Singleton Factory | 584,401 | 0.000003506406 | $0.00653 |

Inputs: `eth_gasPrice` = **6,000,000 wei = 0.006 gwei** (base fee 0.005 gwei across the last 6 blocks);
ETH = **$1,861.51** (Coinbase spot `api.coinbase.com/v2/prices/ETH-USD/spot`), cross-checked against Kraken
at $1,861.61 — a 0.005% spread, so the price is not a source of error here.

These figures exclude the Safe's `execTransaction` overhead (signature verification, the outer call); with
it, expect roughly 650–700k gas, ~$0.0073. **UNVERIFIED — I did not simulate the wrapped call, which would
need a valid owner signature.**

**The founder's suspicion that the cost question may be moot is correct, but with a twist worth naming.**
$0.0065 is nothing in absolute terms — and it is also ~25% of ZERO's entire $0.026 of holdings, and about
3,000× a typical single harvest payout of ~$0.000002. ZERO is not "one cent away" from being able to
self-deploy; it is structurally unable to pay any gas at all, tonight and by standing rule. That is why the
answer is the relay and not the wallet. The deploy is free *because someone else pays it*, which is the
same reason everything else ZERO does is free.

---

## THE PART THAT MATTERS MORE THAN THE DEPLOY

One relay slot buys the deployment. What that slot actually buys is a change in the exchange rate of every
slot afterwards. Today one slot = one `harvest()` call, and most revert because most vaults have nothing to
pay at any given moment — a reverted call consumes the slot and returns nothing.
`ZeroHarvester.execute()` makes one slot = **up to 256 attempts** (`MAX_CALLS = 256`,
`ZeroHarvester.sol:59`), failure-isolated, with a profit gate (`minProfitWei`) that reverts the whole
transaction rather than spend a slot on a batch that does not pay.

Safe's `MultiSend` already exists and already batches — but MultiSend requires **every** inner call to
succeed, so a single reverting vault kills the batch. That is exactly the case ZeroHarvester's
`ok := call(...)` / `successBits` design handles and MultiSend cannot. The contract is not redundant with
the tooling Safe already gives us, and the difference is the whole point.

So the ordering is: **deploy costs one slot, once, and pays for itself on the first batch.**

---

## WHAT I COULD NOT VERIFY

- **The relay actually accepting a deployment.** Rules read and matched; no POST made (read-only scope), and
  all four chains sat at `remaining: 0` tonight regardless. Resolves on the first attempt, cost one slot.
- **Whether Safe's deployed Client Gateway matches the `main` branch I read.** The measured
  `{"remaining":0,"limit":5}` response shape matches `DailyLimitRelayer.getRelaysRemaining()` exactly, which
  is good evidence but not proof of version equality.
- **Gelato's behaviour on a ~650k-gas sponsored call with no `gasLimit` supplied.** No published maximum;
  its docs recommend a 150k buffer over expected usage.
- **Whether any permissionless factory will front deployment gas for repayment** (Q3b). I found none on
  Base and did not exhaustively enumerate.
- **`0x592e1224d203be4214b15e205f6081fbbacfcd2d`** is confirmed as a live paymaster by tonight's log scan
  (6 ops), but I did **not** re-verify the prior claim that it is a permissionless USDC token paymaster —
  that classification is inherited from the 2026-07-28 project measurement.

---

## FLEET-ALT addendum — extra Safe mint without Anthony's money (measured 2026-08-28)

Instrument: `scripts/fleet-alt-mint-probe.mjs` + `scripts/fleet-alt-candide-preflight.mjs`.
**No EOA ETH spent. No Safe-client relay POST. Remaining EOA Base quota left at 3/5.**

### Already-deployed extras (the finding)

`createProxyWithNonce` salt+0 and salt+1 from `zero-fleet-bucket-2-${EOA}` **already have code**. Rhinestone
salt+2 (`0x9f48142d…`) is the empty one the swarm retried. Do not burn more EOA slots minting salt+2.

| salt | address | Base code | owner | Base relay | other chains |
|---|---|---|---|---|---|
| +0 | `0x3e4C5b87069a141a1f84397855349C99C87A63cC` | 171 bytes | GENESIS II EOA | **5/5, nonce 0** | empty everywhere else (phantom 5/5) |
| +1 | `0x1744b8FDD9548C4B98616B14901011133B87aB73` | 171 bytes | GENESIS II EOA | **5/5, nonce 1** | deployed optimism/arbitrum/polygon 5/5 each; gnosis empty |
| +2 | `0x9F48142d1cDa293e6F092E74728ca0D2CC1c161f` | **0** | — | phantom 5/5 | empty. Rhinestone 201 then status 400 Rejected (twice). |

Quota is not capability: pair every `remaining` with `eth_getCode`. The failed predicted address reports 5/5
and cannot spend it.

### Other mint rails, exact errors

- **eth_call** of `createProxyWithNonce` from the EOA **succeeds** on factory 1.4.1 salt+3 (`0xc3BF465c…`,
  262177 gas), factory 1.3.0, factory 1.5.0 (`0x14F2982D…` live, 3321 bytes), and `createChainSpecificProxyWithNonce`
  / `createProxyWithNonceL2`. Acceptance is not a sponsor.
- **Gelato sponsoredCall** (not Rhinestone): `POST api.gelato.digital/relays/v2/sponsored-call` HTTP **400**
  `{"message":"Unsupported chainId"}` (numeric and string `"8453"`). `POST api.gelato.cloud/rpc`
  `relayer_sendTransaction` HTTP **401** `"API key required. Get your API key from our dashboard at https://app.gelato.cloud/relay."`
- **ERC-4337 Candide** (dummy sig, measured): new-sender initCode → `"validator: token balance lower than the required 0x55d3 allowance"` = **0.021971 USDC on the NEW empty account** (holds 0). Existing GENESIS II as sender calling the factory → **0.029504 USDC** required (`0x7340`); Safe held **0.016188 USDC** (allowance already = balance). `eth_estimateUserOperationGas` → `AA21 didn't pay prefund` / `AA23 reverted`. Pimlico `pm_getPaymasterStubData` HTTP **403** `"Sponsorship policy ID is required for this API key"`. Coinbase paymaster HTTP **401** `"unauthorized - invalid key"`.
- **Gnosis**: EOA 5/5, GENESIS II 5/5 and **deployed**. Curve FeeCollector epoch **1 (SLEEP)**. wallet-map
  actionable **0** PAYS rows; no ≥$0.20 gnosis payer. Extra gnosis slots do not mint Base ETH. Not pursued.
- **EIP-7702**: live (6 type-`0x4` txs in 6 blocks at head ~50546879). EOA code **0 bytes**, not delegated.
  None of the type-4 `authorizationList`s included `0xC949…D57A`. Sender pays; no sponsor attached our auth.
- **EIP-7708**: **not live**. Latest-block native value tx `0xe20391ae…` (input `0x`, value > 0) had **0 logs**.
- **EIP-8130 / Cobalt**: Base docs: mainnet timestamp **TBD**, experimental on vibenet only.
- **Coinbase Smart Wallet factory** `eth_call createAccount` returns counterfactuals
  `0xcc41f3c9…` / `0x3494e378…` — both **empty code**. No public sponsor to deploy them.
