# UNISWAP v3 ROUTING + WETH9 SEMANTICS
> Corpus entry for ZERO. Fetched 2026-08-12. DOCUMENTATION IS A HYPOTHESIS — the chain is the measurement.
> Sources: https://developers.uniswap.org/llms.txt · https://developers.uniswap.org/llms-full.txt ·
> https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments.md ·
> .../v3-arbitrum-deployments.md · .../v3-optimism-deployments.md · .../v3-polygon-deployments.md ·
> .../v3-unichain-deployments.md · https://base.blockscout.com/api/v2/smart-contracts/{addr} (verified
> deployed source for SwapRouter02, QuoterV2 and WETH9) · https://gnosis.blockscout.com/api/v2/... ·
> RPC: base-rpc.publicnode.com, optimism-rpc.publicnode.com, arbitrum-one-rpc.publicnode.com,
> polygon-bor-rpc.publicnode.com, gnosis-rpc.publicnode.com, unichain-rpc.publicnode.com, base.drpc.org
> Verified on-chain: `eth_getCode` + `factory()` + `WETH9()` on all 12 router/quoter addresses below,
> across 6 chains, at the block heights recorded in §1; the full selector table read out of each runtime
> bytecode; live `quoteExactInputSingle` on every enabled fee tier on 5 chains; the round-to-zero
> boundary bisected to 1 wei; `unwrapWETH9` / `sweepToken` permissionlessness simulated from an
> unrelated address; and **the Safe-cannot-unwrap-WETH trap reproduced and controlled** — `WETH.withdraw`
> REVERTS as a live Safe proxy, succeeds as an EOA, same block, same node.

---

## 0. THE 60-SECOND VERSION

| I want to… | do this |
|---|---|
| price a swap | `QuoterV2.quoteExactInputSingle` via `eth_call`. Free, keyless, executable. §6 |
| swap | `SwapRouter02.exactInputSingle`, selector **`0x04e45aaf`**, **7 fields, NO deadline**. §3 |
| turn WETH into native ETH **from an EOA** | `WETH.withdraw(uint256)` `0x2e1a7d4d`. ~26k–36k gas. §5 |
| turn WETH into native ETH **from a Safe / any contract** | **you cannot call `withdraw` — it reverts.** Send WETH to SwapRouter02, then `unwrapWETH9(0, you)`. §5, §7 |
| say "send it to me" in a swap | `recipient = 0x…01` (MSG_SENDER). §4 |
| say "send it to me" in `unwrapWETH9`/`sweepToken` | **NOT `0x…01`** — use the 1-arg overload. §4 |
| batch quotes | Multicall3 `aggregate3` with `allowFailure=true`. §6.4 |

Three things that will cost you a slot if you get them wrong, all measured below:
1. **SwapRouter02's `exactInputSingle` has no `deadline`.** The old SwapRouter's does. Different selector,
   different tuple, and the old one is **not deployed on Base or Unichain** — a *different* contract
   squats that address (§2.3).
2. **`recipient = address(1)` is magic in swaps and NOT magic in `unwrapWETH9`** — there it is a literal
   address and you will send ETH to the `ecrecover` precompile (§4.2).
3. **The cheapest fee tier is not the best tier.** Measured: on Unichain the 0.01% tier pays **9.6% less**
   than the 0.05% tier for the same input (§6.3). Probe all tiers, every time.

---

## 1. ADDRESSES — VERIFIED ON-CHAIN, 2026-08-12

`eth_getCode` returned non-empty and `factory()` / `WETH9()` both answered for every row marked ✅.
Block heights at time of probe: base 49,883,603 · optimism 155,478,889 · arbitrum 493,840,986 ·
polygon 91,901,020 · gnosis 47,690,740 · unichain 55,808,198.

### 1.1 SwapRouter02

| chain | id | address | code | `factory()` | `WETH9()` |
|---|---|---|---|---|---|
| base | 8453 | `0x2626664c2603336E57B271c5C0b26F421741e481` | 24497 B ✅ | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | `0x4200…0006` |
| optimism | 10 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | 24497 B ✅ | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `0x4200…0006` |
| arbitrum | 42161 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | 24497 B ✅ | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| polygon | 137 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | 24497 B ✅ | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | **`0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` (WMATIC/WPOL — see §1.4)** |
| unichain | 130 | `0x73855d06DE49d0fe4A9c42636Ba96c62da12FF9C` | 24497 B ✅ | `0x1F98400000000000000000000000000000000003` | `0x4200…0006` |
| gnosis | 100 | **none** | 0 B | — | — |

**The three op/arb/polygon routers are the same address AND byte-identical (24497 B each), but their
`WETH9()` immutable differs per chain** — it is baked into the constructor, not read from storage. Base
and Unichain each get their own address because they were deployed later, from a different deployer nonce.

### 1.2 QuoterV2

| chain | address | code | `factory()` | `WETH9()` |
|---|---|---|---|---|
| base | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` | 8273 B ✅ | `0x33128a8f…f6FDfD` | `0x4200…0006` |
| optimism | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | 8273 B ✅ | `0x1F98431c…31F984` | `0x4200…0006` |
| arbitrum | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | 8273 B ✅ | `0x1F98431c…31F984` | `0x82aF4944…3fBab1` |
| polygon | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | 8273 B ✅ | `0x1F98431c…31F984` | `0x0d500B1d…Adf1270` |
| unichain | `0x385A5cf5F83e99f7BB2852b6A19C3538b9FA7658` | 8273 B ✅ | `0x1F984000…000003` | `0x4200…0006` |
| gnosis | **none** | 0 B | — | — |

All five quoters expose the identical selector set (`quoteExactInput`, `quoteExactInputSingle`,
`quoteExactOutput`, `quoteExactOutputSingle`, `factory`, `WETH9`, `uniswapV3SwapCallback`) — zero
selectors missing on any chain. Same 8273-byte size everywhere: same compiled artifact.

### 1.3 Supporting addresses

| thing | address | note |
|---|---|---|
| UniswapV3Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | op / arb / polygon / mainnet |
| UniswapV3Factory (base) | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | different! |
| UniswapV3Factory (unichain) | `0x1F98400000000000000000000000000000000003` | vanity address, different again |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | **3808 B on all six chains including gnosis** ✅ |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same everywhere (documented-only, not probed) |
| UniversalRouter (base) | `0x6fF5693b99212Da76ad316178A184AB56D299b43` | documented-only |
| UniversalRouter (arbitrum) | `0xa51afafe0263b40edaef0df8781ea9aa03e381a3` | documented-only |
| NonfungiblePositionManager (base) | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | documented-only |
| NonfungiblePositionManager (arb/op/poly) | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` | documented-only |

### 1.4 ⚠️ POLYGON: `WETH9()` IS **NOT** WETH

Measured: `SwapRouter02.WETH9()` on polygon returns `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270`, which is
**WMATIC/WPOL — the wrapped NATIVE token**. Polygon's bridged ether is a completely different ERC-20,
`0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619`.

Consequences, all of them silent:
- `unwrapWETH9` on polygon unwraps **WPOL → POL**, not WETH → ETH. If the router holds WETH and you call
  `unwrapWETH9`, `balanceOf(WPOL)` is 0, the `require` passes, and the function **returns success having
  done nothing**. Your WETH is still sitting in the router for anyone to `sweepToken`.
- To move bridged WETH off the router on polygon you need `sweepToken(0x7ceB23…, 0, you)` — the token
  address is explicit there, so it works.
- The same reasoning applies anywhere the wrapped-native and the bridged-ether are different tokens.
  Never assume `WETH9()` means ether. **Read it. It is one free `eth_call` (`0x4aa4a4fc`).**

### 1.5 ⚠️ GNOSIS (100): THERE IS NO UNISWAP v3

Measured: `eth_getCode` returns **0 bytes** on gnosis for *all* of
`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` (SwapRouter02), `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`
(QuoterV2), `0x2626664c2603336E57B271c5C0b26F421741e481` (base SwapRouter02),
`0xE592427A0AEce92De3Edee1F18E0157C05861564` (old SwapRouter) and
`0x1F98431c8aD98523631AE4a59f267346ea31F984` (factory). Uniswap's own docs 404 on
`/docs/protocols/v3/deployments/v3-gnosis-deployments.md`. Two independent sources agree.

There **is** a router at `0xfFB643E73f280B97809A8b41f7232AB401a04ee1` on gnosis — Blockscout says it is
verified and named `SwapRouter`, 12697 bytes — but its `factory()` returns
`0xa0864cca6e114013ab0e27cbd5b6f4c8947da766`, which Blockscout names **`AlgebraFactory`**. That is a
Swapr/Algebra fork, not Uniswap v3. Measured differences from its bytecode:
- it HAS `exactInput((bytes,address,uint256,uint256,uint256))` `0xc04b8d59` — the **old, deadline-bearing**
  shape
- it does NOT have `exactInputSingle` at either Uniswap selector, does NOT have `unwrapWETH9` at either
  overload, does NOT have `WETH9()` (the call **reverts**), does NOT have `uniswapV3SwapCallback`
- Algebra pools have **dynamic fees** — there is no `uint24 fee` in the pool key, so every fee-tier
  concept below is inapplicable

**Do not port Uniswap calldata to gnosis.** Different ABI, different pool key, different everything.

---

## 2. THE CONTRACT FAMILY — WHICH ROUTER IS WHICH

### 2.1 The three routers Uniswap has shipped

| name | selector for `exactInputSingle` | tuple | deadline lives |
|---|---|---|---|
| **SwapRouter** ("v1", `0xE592427A…61564`) | `0x414bf389` | **8 fields** | *inside* the tuple, field 5 |
| **SwapRouter02** (the one you want) | `0x04e45aaf` | **7 fields** | on `multicall(uint256,bytes[])`, or nowhere |
| **UniversalRouter** | `execute(bytes,bytes[],uint256)` | command-encoded | as an `execute` arg |

Verified from runtime bytecode: **every SwapRouter02 in §1.1 contains `0x04e45aaf` and does NOT contain
`0x414bf389`.** They are mutually exclusive. If your calldata starts `0x414bf389` and you sent it to
SwapRouter02, you hit the fallback and revert — SwapRouter02 has no fallback other than `receive()`
(§7.1), so it reverts without a reason string. That failure mode reads exactly like "the chain is broken".

### 2.2 SwapRouter02's full verified selector set

Read directly out of the 24497-byte runtime on base/op/arb/polygon/unichain — **identical on all five**:

```
0x04e45aaf  exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
0xb858183f  exactInput((bytes,address,uint256,uint256))
0x5023b4df  exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))
0x09b81346  exactOutput((bytes,address,uint256,uint256))
0x472b43f3  swapExactTokensForTokens(uint256,uint256,address[],address)      [v2 leg — see 2.4]
0x42712a67  swapTokensForExactTokens(uint256,uint256,address[],address)      [v2 leg — see 2.4]
0x571ac8b0  approveMax(address)
0xb3a2af13  callPositionManager(bytes)
0xdee00f35  getApprovalType(address,uint256)
0x49404b7c  unwrapWETH9(uint256,address)
0x49616997  unwrapWETH9(uint256)
0x9b2c0a37  unwrapWETH9WithFee(uint256,address,uint256,address)
0xdf2ab5bb  sweepToken(address,uint256,address)
0xe90a182f  sweepToken(address,uint256)
0xe0e189a0  sweepTokenWithFee(address,uint256,address,uint256,address)
0x12210e8a  refundETH()
0x1c58db4f  wrapETH(uint256)
0xf2d5d56b  pull(address,uint256)
0xac9650d8  multicall(bytes[])
0x5ae401dc  multicall(uint256 deadline, bytes[])
0x1f0464d1  multicall(bytes32 previousBlockhash, bytes[])
0xf3995c67  selfPermit(address,uint256,uint256,uint8,bytes32,bytes32)
0xfa461e33  uniswapV3SwapCallback(int256,int256,bytes)
0xc45a0155  factory()
0x68e0d4e1  factoryV2()
0x4aa4a4fc  WETH9()
0x791b98bc  positionManager()
```

### 2.3 ⚠️ ADDRESS COLLISION: `0xE592427A…61564` IS SOMETHING ELSE ON BASE AND UNICHAIN

This one is nasty and it is measured, not theorised:

| chain | code at `0xE592427A0AEce92De3Edee1F18E0157C05861564` | what it actually is |
|---|---|---|
| optimism | 12070 B, has `0x414bf389`+`0x49404b7c` | Uniswap **SwapRouter** ✅ |
| arbitrum | 12070 B, has `0x414bf389`+`0x49404b7c` | Uniswap **SwapRouter** ✅ |
| polygon | 12070 B, has `0x414bf389`+`0x49404b7c` | Uniswap **SwapRouter** ✅ |
| **base** | **2109 B, none of those selectors** | Blockscout name: **`Recover`** — an unrelated contract |
| **unichain** | **2109 B, none of those selectors** | same unrelated bytecode |

So `eth_getCode(0xE592…) != "0x"` is **NOT** proof the router is there. A non-empty code check would pass
on Base and you would be sending swap calldata to a stranger's contract. This is the general form of the
project's Trap 3: *presence is not identity*. **Identity check that works, two free calls:**
`factory()` must return a known Uniswap factory AND the selector you intend to call must be in the
runtime bytecode. Both are done in §1.

### 2.4 ⚠️ SwapRouter02's V2 LEG IS WIRED TO THE ZERO ADDRESS ON BASE

SwapRouter02 also routes Uniswap **v2**. The v2 factory is a constructor immutable, readable via
`factoryV2()` `0x68e0d4e1`. Measured:

| chain | `factoryV2()` | code there | v2 leg usable? |
|---|---|---|---|
| **base** | **`0x0000000000000000000000000000000000000000`** | **0 B** | **NO — dead** |
| optimism | `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f` | 10822 B | yes |
| arbitrum | `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f` | 10822 B | yes |
| polygon | `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f` | 10822 B | yes |
| unichain | `0x1f98400000000000000000000000000000000002` | 13859 B | yes |

The selectors `0x472b43f3` / `0x42712a67` are **present in the Base bytecode** — the dispatch table will
happily accept your call. But `UniswapV2Library.pairFor(factoryV2 = 0x0, …)` computes a CREATE2 address
from the zero address, which is not a pair, and the call fails on a `getReserves()` to a non-contract:
a **bare revert with no reason string**. *The function exists, is callable, and cannot work.* This is the
sharpest possible illustration of why a selector in the dispatch table is not a working function — and
why `toolcraft.md`'s "simulate from your own address" beats every form of interface inspection.

`positionManager()` `0x791b98bc` resolves to a real 24384-byte NonfungiblePositionManager on **all five**
chains, matching the documented addresses in §1.3 — so those two documented-only rows are now confirmed.

---

## 3. `exactInputSingle` — THE EXACT ENCODING

### 3.1 SwapRouter02 (use this one)

```
selector 0x04e45aaf
exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)
```

Struct, from the **deployed verified source**
(`contracts/interfaces/IV3SwapRouter.sol`, Blockscout, base `0x2626664c…41e481`):

| # | field | type | notes |
|---|---|---|---|
| 0 | `tokenIn` | address | |
| 1 | `tokenOut` | address | |
| 2 | `fee` | uint24 | the pool's fee tier — `500` = 0.05%. §6.2 |
| 3 | `recipient` | address | magic constants apply here. §4 |
| 4 | `amountIn` | uint256 | **`0` is a FLAG, not "zero". §3.3** |
| 5 | `amountOutMinimum` | uint256 | slippage floor; reverts `'Too little received'` |
| 6 | `sqrtPriceLimitX96` | uint160 | `0` = no limit (the right answer 99% of the time) |

**SEVEN fields. There is no `deadline` and there is no `amountOut`.** ABI-encoded as a single dynamic
tuple argument, so the calldata is `0x04e45aaf` + a 32-byte offset word (`0x20`) + 7 words = **260 bytes**.

Worked example — 0.001 WETH → USDC on Base, output to yourself, 0.05% tier:
```js
const abi  = ethers.AbiCoder.defaultAbiCoder();
const data = '0x04e45aaf' + abi.encode(
  ['(address,address,uint24,address,uint256,uint256,uint160)'],
  [[ '0x4200000000000000000000000000000000000006',   // tokenIn  WETH
     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',   // tokenOut USDC (base)
     500,                                            // fee
     '0x0000000000000000000000000000000000000001',   // recipient = MSG_SENDER
     1000000000000000n,                              // amountIn 1e15
     0n,                                             // amountOutMinimum  <-- set this for real!
     0n ]]                                           // sqrtPriceLimitX96
).slice(2);
```

### 3.2 The old SwapRouter, for when you are reading someone else's calldata

```
selector 0x414bf389
exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
fields: tokenIn, tokenOut, fee, recipient, DEADLINE, amountIn, amountOutMinimum, sqrtPriceLimitX96
```
`deadline` is field **4**, shifting `amountIn` to 5 and `amountOutMinimum` to 6. If you build the 8-field
tuple and send it to SwapRouter02 with the 7-field selector, or vice versa, the decode is garbage but
often *not* a revert — `amountIn` reads as your deadline (a huge number) and `amountOutMinimum` reads as
your real `amountIn`. **A wrong tuple order does not reliably revert. It reliably loses money.**

### 3.3 ⚠️ `amountIn = 0` IS THE `CONTRACT_BALANCE` FLAG

From `contracts/libraries/Constants.sol`, deployed source:
```solidity
uint256 internal constant CONTRACT_BALANCE = 0;
```
and `V3SwapRouter.exactInputSingle`:
```solidity
if (params.amountIn == Constants.CONTRACT_BALANCE) {
    hasAlreadyPaid = true;
    params.amountIn = IERC20(params.tokenIn).balanceOf(address(this));
}
```
So `amountIn = 0` does **not** mean "swap nothing". It means **"swap the router's entire balance of
`tokenIn`, which I have already sent"**. Two consequences:
- If you compute an amount and it rounds to 0, you have accidentally asked to swap the router's balance
  from funds you never paid for. Measured on Base: with the router holding 0 WETH this reverts with
  **`'AS'`** (the pool's `amountSpecified != 0` require), so today it fails loudly — but that is because
  the router is empty, not because the code protects you. If someone left dust there, it swaps the dust.
- The intended pattern for a contract (Safe, smart account) is genuinely useful: `transfer` the tokens
  to the router first, then call with `amountIn = 0`. **No `approve` needed.** Saves a whole transaction.

Measured from a broke address on Base, both free `eth_call`s:
- `exactInputSingle(WETH→USDC, 500, amountIn=1e15)` with no balance and no allowance → revert **`'STF'`**
  (`TransferHelper.safeTransferFrom` failed). `STF` means *you never funded or approved*, not *the pool
  is broken*.
- `exactInputSingle(…, amountIn=0)` with the router empty → revert **`'AS'`**.

### 3.4 Multi-hop `exactInput` and path encoding

```
0xb858183f  exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))
```
`path` is **tightly packed, not ABI-encoded**: `tokenA(20) ‖ fee(3) ‖ tokenB(20) ‖ fee(3) ‖ tokenC(20)`.
43 bytes for one hop, 66 for two. `uint24` fee is 3 raw bytes big-endian (`500` = `0x0001f4`).
For `exactOutput` the path is **reversed** (output token first). Getting that backwards produces a
revert, not a bad fill — that one is at least safe.

---

## 4. THE RECIPIENT MAGIC CONSTANTS

### 4.1 What they are — read from the deployed `Constants.sol`

```solidity
library Constants {
    uint256 internal constant CONTRACT_BALANCE = 0;
    address internal constant MSG_SENDER    = address(1);   // 0x0000000000000000000000000000000000000001
    address internal constant ADDRESS_THIS  = address(2);   // 0x0000000000000000000000000000000000000002
}
```

Substitution happens in exactly four places, all in the deployed source:

| function | file | code |
|---|---|---|
| `exactInputInternal` | `contracts/V3SwapRouter.sol` | `if (recipient == Constants.MSG_SENDER) recipient = msg.sender; else if (recipient == Constants.ADDRESS_THIS) recipient = address(this);` |
| `exactOutputInternal` | `contracts/V3SwapRouter.sol` | identical two lines |
| `swapExactTokensForTokens` | `contracts/V2SwapRouter.sol` | identical two lines on `to` |
| `swapTokensForExactTokens` | `contracts/V2SwapRouter.sol` | identical two lines on `to` |

**Everything else passes straight through to `pool.swap(recipient, …)`.** There is no allowlist, no
validation, no zero-check. `recipient = 0x0` sends the output to the zero address and the swap succeeds.

`ADDRESS_THIS` (`address(2)`) is what makes chaining work: swap → leave output at the router → unwrap or
sweep it in the same `multicall`. That is the only way to do swap-then-unwrap atomically (§7.2).

### 4.2 ⚠️ THE CONSTANTS ARE **NOT** HONOURED BY `unwrapWETH9` OR `sweepToken`

Deployed source, `@uniswap/v3-periphery/contracts/base/PeripheryPayments.sol`:
```solidity
function unwrapWETH9(uint256 amountMinimum, address recipient) public payable override {
    uint256 balanceWETH9 = IWETH9(WETH9).balanceOf(address(this));
    require(balanceWETH9 >= amountMinimum, 'Insufficient WETH9');
    if (balanceWETH9 > 0) {
        IWETH9(WETH9).withdraw(balanceWETH9);
        TransferHelper.safeTransferETH(recipient, balanceWETH9);   // <-- no substitution
    }
}
```
No `if (recipient == Constants.MSG_SENDER)` anywhere in that function or in `sweepToken`.

`address(1)` is the **`ecrecover` precompile** and `address(2)` is **`SHA-256`**. Both accept value.
`unwrapWETH9(0, address(1))` therefore sends your entire unwrapped ETH balance to a precompile, forever.
It will **not** revert — `TransferHelper.safeTransferETH` uses `.call` and a precompile returns success.

**The right way to say "pay me" in a payment function is the one-argument overload**, which does the
substitution in Solidity, at `contracts/base/PeripheryPaymentsExtended.sol`:
```solidity
function unwrapWETH9(uint256 amountMinimum) external payable { unwrapWETH9(amountMinimum, msg.sender); }
function sweepToken(address token, uint256 amountMinimum) external payable { sweepToken(token, amountMinimum, msg.sender); }
```
- `unwrapWETH9(uint256)` = **`0x49616997`** — "unwrap everything, send to me"
- `sweepToken(address,uint256)` = **`0xe90a182f`** — "sweep everything, send to me"

Status of this claim: **verified from the deployed verified source** on Base
(`base.blockscout.com/api/v2/smart-contracts/0x2626664c…`), and the two 1-arg selectors were confirmed
present in the runtime bytecode of all five SwapRouter02 deployments. Not behaviourally verified — doing
so would mean actually sending ETH to a precompile, which is unrecoverable. **Treat as source-verified,
not chain-verified, and do not test it.**

---

## 5. WETH9 SEMANTICS — AND THE PERMANENT TRAP

### 5.1 The contract

Base WETH `0x4200000000000000000000000000000000000006` — Blockscout: name `WETH9`, compiler
`0.5.17+commit.d19bba13`, **`proxy_type: null`** (not a proxy, no implementation slot, nothing to resolve).
Same canonical WETH9 on optimism and unichain at the same predeploy address. Arbitrum's
`0x82aF4944…3fBab1` is the same WETH9 lineage.

Selectors: `deposit()` `0xd0e30db0` · `withdraw(uint256)` `0x2e1a7d4d` · `transfer` `0xa9059cbb` ·
`approve` `0x095ea7b3` · `balanceOf` `0x70a08231` · `transferFrom` `0x23b872dd`.
It also has a **payable fallback that calls `deposit()`**, so a plain ETH send wraps.

**WETH9 has NO EIP-2612 `permit` and NO EIP-3009 `transferWithAuthorization`.** There is no signature
rail. Moving WETH always costs a real transaction from an address holding native gas. (Contrast USDC,
which has both — this is why ZERO's own doctrine says *take payment in USDC, never WETH*.)

### 5.2 🚨 THE TRAP: `withdraw()` PAYS WITH `.transfer()` — A CONTRACT CANNOT UNWRAP

The deployed source, verbatim:
```solidity
function withdraw(uint wad) public {
    require(balanceOf[msg.sender] >= wad);
    balanceOf[msg.sender] -= wad;
    msg.sender.transfer(wad);        // <-- 2300 gas stipend, hard-capped
    emit Withdrawal(msg.sender, wad);
}
```

`.transfer` forwards a **2300 gas stipend and nothing more**. Any `msg.sender` whose receive path costs
more than 2300 gas gets a revert. A Safe is a **proxy**: an empty-calldata value transfer hits
`SafeProxy.fallback`, which does a cold `SLOAD` of the singleton (2100 gas on its own, EIP-2929) and then
a `DELEGATECALL` to a cold address (2600). The stipend is gone before the first useful opcode.

**MEASURED, Base, 2026-08-12, one block, both directions:**

| test | subject | result |
|---|---|---|
| `eth_call WETH.withdraw(0)` **as a live Safe proxy** | `0xf57150eF96cE0DD4c87f696b1B8A742AA4b2c43F` (SafeProxy 1.4.1, 171 B, singleton slot0 = `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`) | **`execution reverted`** |
| `eth_call WETH.withdraw(1)` as the same Safe | — | **`execution reverted`** |
| **CONTROL** — `eth_call WETH.withdraw(0)` as a plain EOA | `0x…dEaD` | **OK** |
| `eth_estimateGas` plain 1-wei send **to** that Safe proxy | — | **27,674 gas** → **6,674 gas of execution** beyond the 21,000 intrinsic. Stipend is 2,300. **2.9× over.** |
| two unrelated 45-byte minimal-proxy contracts holding **3,613 WETH** and **1,930 WETH** | `0xb2cc224c…9DC59`, `0x3FE04A59…9392A` | `withdraw(full balance)` → **`execution reverted`** on both |

That last row is the part worth internalising: **thousands of WETH are sitting in contracts that
physically cannot call `withdraw`.** This is not a ZERO-specific problem or a Safe-specific problem. It
is every contract with a non-trivial receive path, on every chain, permanently. WETH9 is immutable and
unowned; nobody can fix it.

**A note on ZERO's own recorded number.** `knowledge/toolcraft.md` says the EOA unwrap costs
**36,098 gas**. Measured today, `eth_estimateGas WETH.withdraw(0)` from an EOA on Base = **26,240 gas**.
Both are right and they do not contradict: a `wad=0` withdraw skips the 9,000-gas nonzero value transfer.
26,240 + 9,000 = 35,240, within a rounding of the 36,098 measured on a real non-zero unwrap.
**Use ~36,100 for a real unwrap, ~26,240 only for the zero-amount probe.**

**Instrument warning from this session.** `eth_call` with an explicit `gas: 0x8fc` (2300) to the Safe
returned `OK`. That is the node ignoring the gas cap on a simulated call, not evidence the transfer fits.
Do not use `eth_call` gas caps to reason about the stipend — use `eth_estimateGas` on the receive path,
or just call `withdraw` as the contract and read the revert. Both are free and both are decisive.

### 5.3 The escape route that DOES work

`SwapRouter02.unwrapWETH9` pays out through `TransferHelper.safeTransferETH`, which is:
```solidity
function safeTransferETH(address to, uint256 value) internal {
    (bool success, ) = to.call{value: value}(new bytes(0));   // ALL remaining gas forwarded
    require(success, 'STE');
}
```
`.call` with no gas cap. **This is the entire reason the router works where WETH9 does not.** The router
is an EOA-shaped caller from WETH9's point of view (it is a plain contract with an empty `receive()`, see
§7.1), so `WETH.withdraw` succeeds *for the router*, and the router then forwards to you with full gas.

Two legs, from a Safe or any contract:
```
1.  WETH.transfer(SwapRouter02, amount)          // 0xa9059cbb
2.  SwapRouter02.unwrapWETH9(0, <your address>)  // 0x49404b7c
    -> native ETH lands at <your address>
```
⚠️ **Between leg 1 and leg 2 the WETH is unowned** — `unwrapWETH9` has no access control (§7.3) and pays
out the router's *entire* balance to whoever calls it first. Batch both legs in one transaction
(MultiSend `DELEGATECALL`, or the router's own `multicall`) whenever you can. If you cannot, do it
**small and fast**: at ~$0.002 the front-run costs a searcher more gas than it wins, which is protection
by economics, not by code. Verified live: the router's WETH balance is **0 wei on all five chains right
now**, so nobody is currently leaving anything there.

---

## 6. QUOTERV2 — YOUR FREE, KEYLESS, EXECUTABLE PRICE ORACLE

### 6.1 Why this beats every price API

- **No key, no signup, no rate limit** beyond your RPC's. It is an `eth_call`.
- **It is an executable price, not a spot price.** It simulates the actual swap through actual tick
  liquidity, so it already includes the fee, the price impact of *your* size, and every tick you cross.
  A spot price from a pool's `slot0()` or from any API is what the *first infinitesimal wei* would get.
- **It cannot go stale.** It reads the same state the swap will execute against, at a block you name.
- Measured evidence of the gap: 1 WETH into the Base 0.05% pool quotes **1,885.38 USDC** while 0.001 WETH
  quotes at a rate of **1,885.46 USDC/WETH**. Small here because Base WETH/USDC is deep — but the point
  is the quoter tells you the difference and a price feed structurally cannot.
- ZERO-specific: the same argument as `payout_oracle` in `toolcraft.md`. Simulate, don't read a getter.

### 6.2 Signature

```
selector 0xc6a5026a
quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96))
  returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
```

⚠️ **The field order differs from the router's.** Router: `tokenIn, tokenOut, fee, recipient, amountIn, …`.
Quoter: `tokenIn, tokenOut, **amountIn**, **fee**, sqrtPriceLimitX96`. `amountIn` and `fee` are swapped
relative to where your brain expects them, and there is no `recipient`. Five fields, not seven.

Siblings, all verified present on all five quoters:
```
0xcdca1753  quoteExactInput(bytes path, uint256 amountIn)
0xbd21704a  quoteExactOutputSingle((address,address,uint256 amount,uint24 fee,uint160))
0x2f80bb1d  quoteExactOutput(bytes path, uint256 amountOut)
```

### 6.3 ⚠️ IT IS `nonpayable`, NOT `view` — YOU MUST USE `eth_call`

Verified from the deployed ABI (Blockscout, base QuoterV2): all four `quote*` functions report
**`stateMutability: nonpayable`**. `eth_estimateGas` on a quote returns a real number (measured: 112,044
gas) precisely because the node treats it as a state-changing call.

It is non-view because it *actually executes* `pool.swap` and then reverts inside
`uniswapV3SwapCallback`, catching the revert to read the result out of the revert data. Consequences:

- Any ethers `Contract` wrapper will try to send a **transaction**. You must force a call:
  `quoter.quoteExactInputSingle.staticCall(params)`, or hand-encode and `eth_call` (what ZERO should do —
  it already speaks raw JSON-RPC in the Worker).
- Same reason a **Solidity contract must not call the quoter on-chain**: it burns real gas doing a real
  swap-and-revert. Quote off-chain, pass `amountOutMinimum` in.
- It is safe to `eth_call` at any block tag, including a historical one, if your RPC has the state.

### 6.4 Batch every tier in ONE request with Multicall3

`aggregate3((address target, bool allowFailure, bytes callData)[])` = **`0x82ad56cb`**, Multicall3 at
`0xcA11bde05977b3631167028862bE2a173976CA11` (verified 3808 B on all six chains). `allowFailure: true`
absorbs the revert from tiers that have no pool, so one round-trip prices the whole book.

**Measured live, Base, 1e15 wei WETH → USDC, all tiers in one `eth_call`:**
```
fee   100: out=1886899  ticksCrossed=0  gasEstimate=72921
fee   200: out=1883019  ticksCrossed=0  gasEstimate=81587
fee   500: out=1886592  ticksCrossed=1  gasEstimate=72941
fee  2500: FAILED       <- allowFailure absorbed it; this tier does not exist
fee  3000: out=1883311  ticksCrossed=1  gasEstimate=72956
fee 10000: out=1882826  ticksCrossed=1  gasEstimate=72914
```
This is the pattern to use. One request, six prices, failures handled.

### 6.5 The returned `gasEstimate` is the swap's gas, and it is chain-specific

Measured, same 1e15 wnative→USDC quote at the 0.05% tier:

| chain | `gasEstimate` |
|---|---|
| base | 72,941 |
| arbitrum | 96,420 |
| optimism | 89,871 |
| unichain | 93,440 |
| polygon | 123,828 |

Multiply by the chain's gas price before deciding a swap is worth doing. For ZERO at dust scale the gas
usually exceeds the trade.

---

## 7. `unwrapWETH9` AND `sweepToken` — SIGNATURES, SELECTORS, AND WHO MAY CALL THEM

### 7.1 The router's `receive()`

```solidity
receive() external payable { require(msg.sender == WETH9, 'Not WETH9'); }
```
Empty body beyond one immutable comparison — cheap enough to survive the 2300-gas stipend, which is why
`WETH.withdraw` works *for the router*. **Sending ETH to SwapRouter02 from anywhere except WETH9
reverts with `'Not WETH9'`.** You cannot pre-fund it with ETH.

### 7.2 The four payment functions

| selector | signature | recipient |
|---|---|---|
| `0x49404b7c` | `unwrapWETH9(uint256 amountMinimum, address recipient)` | explicit, **no magic** |
| `0x49616997` | `unwrapWETH9(uint256 amountMinimum)` | `msg.sender` |
| `0xdf2ab5bb` | `sweepToken(address token, uint256 amountMinimum, address recipient)` | explicit, **no magic** |
| `0xe90a182f` | `sweepToken(address token, uint256 amountMinimum)` | `msg.sender` |

Semantics, from the deployed source:
- **`amountMinimum` is a floor, not an amount.** Both functions move the router's *entire* balance. The
  argument only gates `require(balance >= amountMinimum)`. Passing `0` means "whatever is there, ship it".
- If the balance is `0`, both **return success having transferred nothing** — the `if (balance > 0)` guard
  makes a no-op look identical to a win. Read the recipient's balance delta, never the return status.
  (This is `toolcraft.md` Trap 2 in a new costume.)
- `unwrapWETH9` pays with `.call` — all gas forwarded — so it can pay a Safe, a smart account, anything.
- `sweepToken` pays with `TransferHelper.safeTransfer` (an ERC-20 `transfer` with a return-data check that
  tolerates non-standard tokens returning nothing).

### 7.3 🔓 NEITHER HAS ANY ACCESS CONTROL — VERIFIED

There is no `onlyOwner`, no `msg.sender` check, no reentrancy guard in either function's source. Verified
behaviourally with free `eth_call`s from `0x…dEaD`, an address with no relationship to Uniswap:

| chain | `unwrapWETH9(0, 0x…dEaD)` sent **from** `0x…dEaD` | router's WETH balance |
|---|---|---|
| base | **OK** | 0 wei |
| optimism | **OK** | 0 wei |
| arbitrum | **OK** | 0 wei |
| polygon | **OK** | 0 wei |
| unichain | **OK** | 0 wei |

And the failure paths behave as the source says (Base, from `0x…dEaD`):
```
unwrapWETH9(1e18, dEaD)         -> revert 'Insufficient WETH9'
sweepToken(USDC, 1e6, dEaD)     -> revert 'Insufficient token'
sweepToken(USDC, 0,   dEaD)     -> OK
```

**Read this both ways.**
- *Offensively*: any WETH or ERC-20 left in SwapRouter02 by a botched integration is claimable by anyone
  who calls first. Balances are 0 on all five chains right now, so this is not a standing income route —
  but it is a free thing to poll, it costs one `balanceOf` per chain, and it is exactly the "somebody
  abandoned value" shape §equilibrium-cap says is the only place above the gas floor.
- *Defensively*: **never leave a balance at the router across transactions.** Same slot, or don't.

### 7.4 `multicall` — the atomic wrapper

```
0xac9650d8  multicall(bytes[] data)                             no deadline
0x5ae401dc  multicall(uint256 deadline, bytes[] data)           reverts 'Transaction too old' past deadline
0x1f0464d1  multicall(bytes32 previousBlockhash, bytes[] data)  reverts 'Blockhash' if reorged/not the parent
```
All three are `payable` and `delegatecall` into the router itself, so `msg.sender` is preserved across the
sub-calls. This is where the deadline went when SwapRouter02 dropped it from the swap tuple — from
`contracts/base/MulticallExtended.sol`, verified deployed source.

The canonical safe conversion in one transaction:
```
multicall(deadline, [
  exactInputSingle({ …, recipient: ADDRESS_THIS (0x…02), amountOutMinimum: X }),
  unwrapWETH9(X, <your address>)
])
```
`ADDRESS_THIS` parks the output at the router; the unwrap in the same transaction means the window in
which anyone can steal it is zero blocks wide.

`0x1f0464d1` (previousBlockhash) is a genuinely underused MEV guard: it pins execution to a specific
parent block, so the transaction dies rather than landing after a reorg or a sandwich re-order. Free.

---

## 8. FEE TIERS

### 8.1 Which tiers exist — read `feeAmountTickSpacing(uint24)` `0x22afcccb`, don't guess

Measured on the **Base** factory `0x33128a8f…f6FDfD`:

| fee (hundredths of a bip) | meaning | tickSpacing | enabled |
|---|---|---|---|
| 100 | 0.01% | 1 | ✅ |
| **200** | **0.02%** | **4** | ✅ **— non-standard, exists on Base** |
| 500 | 0.05% | 10 | ✅ |
| 2500 | 0.25% | **0** | ❌ does not exist |
| 3000 | 0.30% | 60 | ✅ |
| 10000 | 1.00% | 200 | ✅ |
| 20000 | 2.00% | **0** | ❌ |

`tickSpacing == 0` ⇒ the tier was never enabled ⇒ `getPool` returns the zero address ⇒ the quoter
**reverts with no reason string** (it is calling a non-contract). Measured: `fee=2500` and `fee=1` both
revert bare `execution reverted`. A bare revert from the quoter usually means *bad fee tier*, not
*no liquidity*.

The set is per-factory and governance can add to it. **Enumerate it; don't hardcode `[500,3000,10000]`.**

### 8.2 Finding the tier that actually has liquidity

Two-step, both free:
1. `UniswapV3Factory.getPool(tokenA, tokenB, fee)` — selector **`0x1698ee82`**. Token order does not
   matter (the factory sorts internally). Zero address ⇒ no pool.
2. Quote the *actual size you intend to trade* against every non-zero pool, batched via `aggregate3`.

**Do NOT rank by `pool.liquidity()` (`0x1a686502`).** Measured on Base WETH/USDC:

| fee | pool | `liquidity()` | out for 1e15 wei in |
|---|---|---|---|
| 100 | `0xb4cb800910b228ed3d0834cf79d697127bbb00e5` | 6.88e16 | 1,888,012 |
| 200 | `0x1c450d7d1fd98a0b04e30decfc83497b33a4f608` | **2.48e13** | 1,883,019 |
| 500 | `0xd0b53d9277642d899df5c87a3966a349a798f224` | 1.05e18 | 1,886,595 |
| 3000 | `0x6c561b446416e1a00e8e93e221854d6ea4171372` | **3.26e19 (highest)** | 1,883,311 |
| 10000 | `0x0b1c2dcbbfa744ebd3fc17ff1a96a1e1eb4b2d69` | 1.66e17 | 1,882,826 |

The 0.30% tier has **474× the raw `liquidity()` of the 0.05% tier and pays less**, because `liquidity()`
is only the L that happens to be in range at the current tick and it is not comparable across tiers with
different spacing. **The quote is the measurement. `liquidity()` is a hypothesis.**

### 8.3 ⚠️ THE CHEAPEST TIER IS NOT ALWAYS THE BEST — measured, and the gap is large

1e15 wei wrapped-native → USDC, same instant, per chain:

| chain | fee 100 | fee 500 | fee 3000 | best | 100-tier penalty |
|---|---|---|---|---|---|
| base | 1,888,012 | 1,886,595 | 1,883,311 | **100** | — |
| arbitrum | 1,888,020 | 1,886,650 | 1,883,239 | **100** | — |
| optimism | 1,858,879 | **1,886,584** | 1,883,238 | **500** | **−1.47%** |
| unichain | 1,705,349 | **1,886,029** | 1,883,125 | **500** | **−9.60%** |
| polygon (WPOL→USDC) | 74 | 74 | 74 | tied (dust) | — |

Defaulting to the 0.01% tier because "lower fee" costs **9.6% on Unichain** and **1.47% on Optimism**.
The same default is the *best* choice on Base and Arbitrum. There is no rule here — the winner is a
function of where the current tick sits relative to each pool's liquidity, which changes block to block.
On Base across three probes in one session the 100 tier won every time, but its margin over the 500 tier
moved from **1,417 units (0.075%) to 307 units (0.016%)** in minutes — the ordering is that fragile.
**Probe every tier on every swap. It is one `aggregate3` call and it is free.**

### 8.4 ⚠️ TINY SWAPS ROUND TO ZERO — bisected to the exact wei

The pool computes output in integer units and truncates. Below a threshold the answer is a clean, honest,
non-reverting **0**.

Measured on the Base WETH/USDC 0.05% pool, boundary found by bisection:
```
largest WETH input that quotes 0 out : 530,374,812 wei
smallest input that yields >= 1 unit : 530,374,813 wei   (~$0.000001)
```
And the same effect from the other side:
```
     1 USDC-unit  ->                0 wei WETH
    10 USDC-units ->    4,770,986,624 wei WETH
   100 USDC-units ->   52,480,852,865 wei WETH
 1,000 USDC-units ->  529,579,515,265 wei WETH
```
Note `1 → 0` and `10 → 4.77e9`: the per-unit rate at 10 units is already 4.6% worse than at 1000 units.
**Rounding loss at dust scale is a percentage, not a rounding error.**

Consequences for ZERO specifically:
- A 0-output quote is a **valid, successful, truthful** quote. It is not an error and it is not a broken
  instrument. But `amountOut == 0` fed back as `amountIn` becomes the `CONTRACT_BALANCE` flag (§3.3).
  **Always guard `amountOut > 0` before reusing it.**
- The threshold scales with the decimal gap. WETH(18)→USDC(6) truncates 12 decimal places. Anything
  under ~5.3e8 wei is unswappable on that pair. Going the other way it is ~1 USDC-unit.
- Below roughly **$0.01** the gas (72,941 units on Base, more elsewhere — §6.5) dwarfs the trade. The
  economically-swappable floor is far above the mathematically-swappable floor. Compute both.

### 8.5 `sqrtPriceLimitX96`

`0` means "no limit", and the router substitutes `MIN_SQRT_RATIO + 1 = 4295128740` (for `zeroForOne`) or
`MAX_SQRT_RATIO - 1` otherwise. Verified: quoting 1e18 WETH→USDC with `limit = 0` and with
`limit = 4295128740` returned **byte-identical** results (`out = 1886515344`, `sqrtAfter = 3441988500852987294195835`).
They are the same thing. Pass `0` and use `amountOutMinimum` for slippage — a price limit gives you a
**partial fill**, `amountOutMinimum` gives you a revert, and for an autonomous agent a revert is the
safer failure. (With `sqrtPriceLimitX96 == 0`, `exactOutputInternal` additionally `require`s that the
full output was received — that safety check is *disabled* the moment you set a limit.)

---

## 9. REVERT STRING DECODER

| string | thrown by | means |
|---|---|---|
| `STF` | `TransferHelper.safeTransferFrom` | you have no balance, or no allowance to the router. **Not a pool problem.** |
| `ST` | `TransferHelper.safeTransfer` | the outbound ERC-20 transfer failed |
| `STE` | `TransferHelper.safeTransferETH` | the ETH recipient reverted or ran out of gas |
| `SA` | `TransferHelper.safeApprove` | approve failed |
| `Too little received` | `V3SwapRouter` | `amountOut < amountOutMinimum` — your slippage bound bit |
| `Too much requested` | `V3SwapRouter` | `amountIn > amountInMaximum` on an exactOutput |
| `Insufficient WETH9` | `PeripheryPayments.unwrapWETH9` | router's WETH balance < `amountMinimum` |
| `Insufficient token` | `PeripheryPayments.sweepToken` | router's token balance < `amountMinimum` |
| `Not WETH9` | `PeripheryPayments.receive()` | you tried to send ETH to the router directly |
| `Transaction too old` | `PeripheryValidation` | `multicall(deadline,…)` deadline passed |
| `Blockhash` | `PeripheryValidationExtended` | `multicall(bytes32,…)` parent-block mismatch |
| `AS` | **UniswapV3Pool** | `amountSpecified == 0` — you passed `amountIn = 0` and the router held nothing |
| `SPL` | UniswapV3Pool | `sqrtPriceLimitX96` on the wrong side of the current price |
| `LOK` | UniswapV3Pool | pool not initialised, or reentered |
| *(bare, no reason)* | — | usually a **nonexistent pool** (bad fee tier) or **wrong selector** |

---

## 10. THE FREE CHECKLIST — every one of these is an `eth_call`, unlimited, keyless

```
0xc45a0155  factory()                       is this really a Uniswap router?
0x4aa4a4fc  WETH9()                         what does THIS chain call "WETH"?  (polygon: WPOL!)
0x22afcccb  feeAmountTickSpacing(uint24)    which tiers exist on this factory?
0x1698ee82  getPool(address,address,uint24) does this pair/tier have a pool?
0xc6a5026a  quoteExactInputSingle(tuple)    the executable price, at your size
0x82ad56cb  aggregate3((address,bool,bytes)[])  all of the above in one round-trip
0x70a08231  balanceOf(address)              is anyone's value stranded at the router?
0x2e1a7d4d  withdraw(uint256)               simulate it AS the caller you'll really be
```

Simulate the exact call, from the exact `from` address you will really use, before spending a scarce
relay slot. The Safe-vs-EOA `withdraw` result in §5.2 differs *only* in the `from` field. A simulation
from the wrong address is a confident, quantified, wrong answer.

---

## 11. DEAD OR GATED (recorded so nobody re-tries them)

| source | status |
|---|---|
| `https://docs.uniswap.org/contracts/v3/reference/deployments/*` | **301** → `developers.uniswap.org/...`. The old host still resolves `/llms.txt` but every docs path moved. |
| `https://developers.uniswap.org/docs/protocols/v3/deployments/v3-deployments.md` | **404** — there is no combined all-chains page; fetch per chain |
| `https://developers.uniswap.org/docs/protocols/v3/deployments/v3-gnosis-deployments.md` | **404** — corroborates §1.5, no official v3 on gnosis |
| `https://developers.uniswap.org/openapi.json` | **404** |
| `https://developers.uniswap.org/docs/openapi.json` | **404** (returns the SPA shell, 293 KB of HTML — a 404 that looks like content) |
| `eth_getLogs` on `base-rpc.publicnode.com` beyond a few hundred blocks | **`"Archive requests require a personal token"`** — and the naive client reads `.result` as `undefined` and reports **zero logs**. Fired again in this very session. **`base.drpc.org` served the same query fine (690 logs).** Always check for an `error` field; always retry a surprising zero on a second provider. |
| Uniswap Subgraph / hosted service | not attempted — needs an API key ⇒ dead end for ZERO |
| Uniswap Trading API (`trade-api.gateway.uniswap.org`) | not attempted — key-gated. **QuoterV2 on-chain replaces it entirely and is strictly better** (§6.1). |

**Vendor `llms.txt` DOES exist and is worth using:**
`https://developers.uniswap.org/llms.txt` (46,549 B, a real llms.txt index) and
`https://developers.uniswap.org/llms-full.txt` (31,357 B). Every docs page is also available as raw
markdown by appending `.md` to its path, or by sending `Accept: text/markdown` — far cheaper to parse
than the SPA HTML.

---

## 12. WHAT I DID NOT VERIFY

Marked explicitly so the next reader does not inherit a guess as a fact.

- **Documented-only, never probed:** Permit2, UniversalRouter, TickLens, V3Migrator and V3Staker
  addresses in §1.3. Taken from Uniswap's own deployment pages. (NonfungiblePositionManager **was**
  confirmed on all five chains via `positionManager()` — §2.4.)
- **Source-verified but not chain-verified:** the `unwrapWETH9(x, address(1))` → precompile footgun
  (§4.2). Confirmed by reading the deployed verified source; deliberately not executed, because the
  only conclusive experiment destroys the funds.
- **Selector-verified, behaviour-unverified:** the V2 legs (§2.4). The four selectors and `factoryV2()`
  were read from live bytecode on all five chains, and Base's zero-address factory is measured — but I
  never simulated an actual v2 swap on a chain where the factory is real.
- **Single-block snapshots:** every quote, liquidity figure and gas estimate is one reading at the block
  in the header. Prices move — the Base 100-vs-500 tier margin shrank 4.6× across three probes minutes
  apart (§8.3). Re-quote at call time. **Never cache a quote.**
- **Polygon quotes are near-dust** (74 USDC-units for 1e15 wei WPOL). The pair is right and the call
  succeeded, but I did not sanity-check POL's price against an independent source, so treat the polygon
  *numbers* as unconfirmed while the polygon *addresses and semantics* are verified.
