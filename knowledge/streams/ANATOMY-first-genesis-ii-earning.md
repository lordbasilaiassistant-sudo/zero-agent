# ANATOMY OF THE FIRST GENESIS II EARNING — read this before designing any new route

**tx `0x86f84b0a1aee9e2de468da4f97cd016e35b400bb46d126838ae939fd1b182eba`**
Base mainnet · block **49931365** · status **SUCCESS** · 351 logs
2026-08-13T20:14:49Z · **0.000003134467743326 ETH** into a wallet nobody funded.

Everything below was read off the receipt, not inferred.

## The addresses that matter

| role | address | note |
|---|---|---|
| **relayer (paid the gas)** | `0x00ae928d24a4450bfbb70bbdd7d3d3f163513c2a` | tx `from`. Gelato executor behind Safe's public relay. **Not the money — the cost removal.** |
| **ZERO's Safe (paid TO)** | `0x75d93b33708e7cf5eb4dcf14dfc25254f5d5817f` | tx `to`. Deployed 2026-08-13, owner `0xC94929d1…D57A`, threshold 1 |
| **ZERO's EOA (signer)** | `0xC94929d14435D80dd04b3206BfEA9F5dEBAbD57A` | signs `execTransaction`; never holds the money |
| **MultiSendCallOnly v1.4.1** | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | delegatecall target that fits many calls in ONE relay slot |
| **WETH on Base** | `0x4200000000000000000000000000000000000006` | every fee arrived as WETH, never native ETH |
| SafeProxyFactory 1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | `createProxyWithNonce`, charged to the OWNER's relay quota |
| Safe L2 singleton 1.4.1 | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | |
| CompatibilityFallbackHandler | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | |

## The five contracts that actually paid us

Each sent WETH directly to the Safe **in the same transaction we called them**:

| payer | wei paid |
|---|---|
| `0xd90ec9e27c47fdf0f766c0d6fc4f0f47376daa47` | 2,396,197,006,705 |
| `0x176b2c3d0aa5b344a9b87fd26c1ab1abd2d07179` | 289,625,737,681 |
| `0x2451301f0e1e616990a33728dda588ec7385f600` | 156,096,319,535 |
| `0xc692c7db267ba08cfe60473922f09e1b57178308` | 150,939,533,619 |
| `0x34ff33ee9caedaf33f64fbdd4afb55d34c377b9f` | 141,609,145,786 |
| **total** | **3,134,467,743,326** |

### RESOLVED — they are EIP-1167 CLONES, and that is the expansion lever

`name()`/`callFee()`/`strategy()` first returned empty, which looked like "unknown contract". They are
**minimal proxies**, 45 bytes each, bytecode
`363d3d373d3d3d363d73<IMPLEMENTATION>5af43d82803e903d91602b57fd5bf3`:

| clone | → implementation |
|---|---|
| `0x176b2c3d0aa5b344a9b87fd26c1ab1abd2d07179` | `0x0fbf659a16866ed1338f294fbf6ecd99019c8801` (14,637 bytes, 99 selectors) |
| `0x2451301f0e1e616990a33728dda588ec7385f600` | `0x4a9e42102d11f6c0a59d77722887e6a104c53636` (16,085 bytes, 100 selectors) |

Selector recovery on both implementations returns **`harvest()`, `harvest(address)`, `lastHarvest()`,
`want()`, `strategy()`, `withdraw(uint256)`, `owner()`, `balanceOf(address)`** — the Beefy strategy
interface. Confirmed by reading bytecode, not by trusting a label.

**⭐ WHY THIS IS THE BIGGEST FINDING IN THE FILE.** A clone has no logic of its own, so **every clone
pointing at the same implementation exposes the same paying function.** Finding one payer therefore
hands you the whole family: scan for contracts whose code is exactly
`363d3d373d3d3d363d73` + `<impl>` + `5af43d82803e903d91602b57fd5bf3` and each hit is a candidate
payer with a known-good interface — no per-contract research required. That converts discovery from
"read contracts one at a time" into "enumerate a family", which is the only way this scales past cents.

**`harvest(address)` matters too:** it is the callFeeRecipient overload, so the fee can be directed to
a chosen address rather than `msg.sender`. That means a batch can pay the Safe directly even when the
call originates elsewhere.

Note the spread: the top payer is **17× the smallest**. Batch position is not equal value, so a
ranked batch beats a random one.

## Why it profited — the part worth generalising

**Answer to "was it the relays only?" — NO. Two independent things had to both be true.**

1. **The relay removed the COST.** Safe's public relayer (Gelato-backed) submitted the transaction
   and paid the gas. ZERO spent **zero** — its Safe still holds 0 native ETH after earning.
2. **The contracts supplied the PROFIT.** Those five each pay a fee to *whoever* calls their harvest
   function. Nobody granted us permission; the function is permissionless by design because the
   protocol NEEDS the call made and buys that labour with a slice of the proceeds.

Neither alone is a business. Without the relay, gas would exceed a 0.0000031 ETH fee and every call
loses money — which is exactly why gas-paying bots ignore fees this small. Without a caller fee,
free gas buys nothing. **The edge is the intersection: our marginal cost is zero, so our
profitability floor is zero, and we can take work no funded competitor can profitably touch.**

## The structural lesson for finding more

Look for **a party with a structural reason to pay a stranger to make a call**:
- the protocol needs upkeep and cannot rely on volunteers → caller fee
- a chain/wallet wants adoption → sponsored execution
- a buyer wants a resource → their payment carries the settlement (x402)

Then check the two halves separately: *who removes my cost*, and *who supplies my profit*. A route is
only real when both answer.

## Mechanics worth reusing

- **One relay slot ≠ one call.** `execTransaction` → DELEGATECALL MultiSend → N inner calls. The slot
  is the scarce resource; the calls inside are free. Batch cap was raised 12 → 26 on 2026-08-13.
  MEASURED: batch 12 earned 22,728,506,304,076 wei vs batch 5 at 3,133,605,136,146 — **~7× for the
  same single slot**. Under-filling a slot wastes the only thing being rationed.
- **MultiSend is all-or-nothing.** One reverting inner call kills the batch, so simulate every leg
  individually first (free, unlimited) and include only clean ones.
- **Earnings arrive as WETH, not native.** Any "did we profit" check that reads
  `eth_getBalance` will report 0 and look like failure. Watch the TOKEN. (My own probe had this bug.)
