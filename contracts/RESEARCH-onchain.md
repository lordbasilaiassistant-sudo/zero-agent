# RESEARCH — Beefy harvest mechanics on Base, measured from chain

Read-only study for the ZERO batching contract (`contracts/src/ZeroHarvester.sol`).
No transactions sent, nothing signed, nothing deployed. Every number below came from an `eth_call`
or a verified source file fetched this session.

- **Date:** 2026-07-31. **Base head block at time of sweep: 49,376,111.**
- **RPCs:** `https://mainnet.base.org`, `https://base-rpc.publicnode.com`
- **Verified source:** Blockscout `https://base.blockscout.com/api/v2/smart-contracts/{addr}` (no key, `is_verified=true` on every file quoted)
- **Universe:** the 241 `status:"active"`, `chain:"base"` vaults in `_beefy_base.json`; `vault.strategy()` resolved for **241/241** via Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`.
- **⚠️ One assumption, flagged:** ETH/USD is taken as **$3,000, UNVERIFIED — I did not measure it.** The measured primitive everywhere is **WETH wei**. Divide/re-multiply as you like; every USD figure is `WETH × 3000` and nothing more.

---

## 0. THE DESIGN-CRITICAL ANSWER — can a CONTRACT call harvest and get paid?

# YES. UNAMBIGUOUSLY YES.

**No Beefy strategy on Base gates harvest on `tx.origin`, `msg.sender == tx.origin`, EOA-ness, a whitelist, a stake, or a payment from the caller.** The batching design is not blocked. Proven three independent ways:

### Proof 1 — source. The entrypoint has no modifier at all.
`0x68Ecddba8D4CfCa13923fC8d66f2678BF17aB4e1` (`StrategyRewardPool`, verified, solc 0.8.23) — the single implementation behind **215 of the 241** strategies (all EIP-1167 clones):

```solidity
    /// @notice Harvest rewards and collect a call fee reward
    function harvest() external {
        _harvest(tx.origin);
    }

    /// @notice Harvest rewards and send the call fee reward to a specified recipient
    /// @param _callFeeRecipient Recipient of the call fee reward
    function harvest(address _callFeeRecipient) external {
        _harvest(_callFeeRecipient);
    }
```
No `onlyEOA`, no `require`, no access modifier. `external` and open.

### Proof 2 — `tx.origin` IS present, but it is a DEFAULT RECIPIENT, never a gate.
This matters because a naive bytecode scan misleads. **241/241 implementations contain the `ORIGIN` (0x32) opcode.** Every single occurrence in source is one of exactly three benign shapes:

1. `harvest()` → `_harvest(tx.origin)` — pays whoever originated, since the no-arg form has no recipient parameter.
2. `beforeDeposit()` → `_harvest(tx.origin)` — same, on the deposit hook.
3. In `StrategyVelodromeGaugeV2` (`0x4A9E42102d11f6c0A59d77722887E6A104C53636`, line 106), a **withdrawal-fee exemption**, unrelated to harvest:
```solidity
        if (tx.origin != owner() && !paused()) {
            uint256 withdrawalFeeAmount = wantBal * withdrawalFee / WITHDRAWAL_MAX;
            wantBal = wantBal - withdrawalFeeAmount;
        }
```
`grep -n "tx\.origin\|onlyEOA"` over all four implementation sources returns 13 hits and **zero** are a require/revert on caller type.

> **Correction to my own working notes, recorded honestly:** my first scan walked *proxy* bytecode (45-byte EIP-1167 stubs) and reported "1/241 contain ORIGIN". That was wrong — it measured the clone, not the logic. Rescanning implementations gives 241/241. The conclusion (no EOA gate) survives, but it rests on the source and the simulations below, **not** on the opcode scan. An opcode scan can never answer this question.

### Proof 3 — empirical. A contract harvested 208 strategies and was paid, in simulation.
I simulated `Multicall3.aggregate3([WETH.balanceOf(safe), strat.harvest(safe), WETH.balanceOf(safe)])` via `eth_call`. `msg.sender` at the strategy is **Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` — a contract.** `tx.origin` is the zero address.

**208 of 216 eligible strategies transferred a nonzero WETH call fee to the Safe. 0 reverted for any caller-identity reason.**

### Proof 4 — a real mainnet tx where a contract's call reached `_harvest`.
tx `0xbabc07107b0511dca0ded86ac1c95fd9c39bddbf63ca19d6a18f3ffc6a41c299` — `tx.to` = `0x6F19Da51d488926C007B9eBaa5968291a2eC6a63` (**`BeefyZapRouter`**, verified), which deposited into vault `0xA20382dC7C06E7e2850f1154e7ED1D06Aeb47a0A`, firing `beforeDeposit() → _harvest(...)`. The `StratHarvest` event's indexed harvester is the **vault contract**, not an EOA.

**Design verdict: ZeroHarvester can call `harvest(address)` directly. Use the `harvest(address _callFeeRecipient)` overload — never `harvest()`, whose `tx.origin` default would pay the relayer instead of the beneficiary.**

---

## 1. The exact interface, and how much it pays

### Signatures (identical across all four implementations)
| Selector | Signature | Pays |
|---|---|---|
| `0x0e5c011e` | `harvest(address _callFeeRecipient)` | **the named recipient — use this** |
| `0x4641257d` | `harvest()` | `tx.origin` (wrong party for us) |
| — | `beforeDeposit()` | `tx.origin`, and `require(msg.sender == vault, "!vault")` — not callable by us |
| `0x97fd323d` | `callReward()` view | — |

`managerHarvest()` does **not** exist on any of the four implementations (grep returns nothing). ZERO's existing `harvest.mjs` already uses `0x0e5c011e`; that is correct and confirmed.

Measured across the 216-strategy sweep: **`harvest(address)` succeeded on 208, `harvest()` fallback was needed 0 times.** The overload is universal on Base.

### The fee math, quoted
`0x68Ecddba8D4CfCa13923fC8d66f2678BF17aB4e1`:
```solidity
    function _chargeFees(address _callFeeRecipient) internal {
        IFeeConfig.FeeCategory memory fees = getFees();
        uint256 nativeBal = IERC20Metadata(native).balanceOf(address(this)) * fees.total / DIVISOR;

        uint256 callFeeAmount = nativeBal * fees.call / DIVISOR;
        IERC20Metadata(native).safeTransfer(_callFeeRecipient, callFeeAmount);
```
with `uint256 constant DIVISOR = 1 ether;` (line 592).

**On-chain `getAllFees()`, read from 8 separate live strategies — all identical:**

| field | raw | meaning |
|---|---|---|
| `fees.total` | `95000000000000000` | 9.500 % of gross harvested reward |
| `fees.call` | `1052631578947368` | 0.10526 % **of that 9.5 % slice** |
| `fees.beefy` | — | 94.632 % of the slice |
| `fees.strategist` | — | 5.263 % of the slice |
| `label` / `active` | `"default"` / `true` | |

> **The caller's take is `0.095 × 0.00105263` = 0.0100 % of gross harvested value.** One basis point. Fee config lives at `0xfc69704cC3cAac545cC7577009Ea4AA04F1a61Eb` and is owner-mutable — re-read it, never hardcode.

Payment is a `safeTransfer` of `native` = WETH `0x4200000000000000000000000000000000000006` on every Base strategy sampled. **The fee arrives as an ERC-20, not as ETH.** A batcher that only accounts for ETH balance deltas will see zero profit and wrongly revert.

### `callReward()` — WHY it lies by ~4,478×, resolved from source
Line 310–313 of the master implementation:
```solidity
    function callReward() public view returns (uint256 callFee) {
        IFeeConfig.FeeCategory memory fees = getFees();
        callFee = rewardsAvailable() * fees.total / DIVISOR * fees.call / DIVISOR;
    }
```
and line 304:
```solidity
    function rewardsAvailable() public view returns (uint256 unclaimedReward) {
        unclaimedReward = IRewardPool(rewardPool).earned(address(this), rewards[0]);
    }
```

`rewardsAvailable()` is denominated in **`rewards[0]` — the reward token (AERO, CAKE, …)**. `callReward()` applies the fee fractions to it and returns the result **without ever price-converting to `native`**, despite the docstring saying "Amount of native reward". The real fee is charged in `_chargeFees` on the WETH balance *after* `_swapToNative()`.

**So `callReward()` overstates by exactly the reward-token/WETH price ratio.** Measured, per strategy:

- Aerodrome family (`rewards[0]` = AERO): ratio **4,429× – 4,479×** (n≈40, tight). Implies AERO ≈ $0.67 at ETH $3,000.
- PancakeSwap/Merkl family: ratio **1,271× – 1,284×**. A *different* constant.

> **This sharpens ZERO's existing "~4,300× liar" note into something usable: the multiplier is a price ratio, not a bug with one magic constant. `callReward()` is a valid ranking key ONLY within a single reward-token family, and comparing an Aerodrome strategy against a Pancake one by `callReward()` mis-ranks them by ~3.5×.** In the sweep the top Pancake strategy ranked #14 by `callReward()` but #7 by measured fee. **Rank by simulated delta, or at minimum bucket by `rewards[0]` first.**

---

## 2. What makes a harvest revert vs. pay — every guard, quoted

`_harvest` in full (master implementation, line 164):
```solidity
    function _harvest(address _callFeeRecipient) internal whenNotPaused {
        IRewardPool(rewardPool).getReward();
        _swapToNative();
        if (IERC20Metadata(native).balanceOf(address(this)) > 0) {
            if (!IBeefyVaultConcLiq(want).isCalm()) revert NotCalm();
            _chargeFees(_callFeeRecipient);
            _swapToWant();
            ...
            lastHarvest = block.timestamp;
            emit StratHarvest(msg.sender, wantHarvested, balanceOf());
        }
    }
```

| Guard | Selector | Source | Behaviour |
|---|---|---|---|
| **`whenNotPaused`** → `StrategyPaused()` | `0xe628b949` | `if (paused() \|\| factory.globalPause()) revert StrategyPaused();` (line 624) | **TWO pause sources** |
| **`NotCalm()`** | `0x26c87876` | `if (!IBeefyVaultConcLiq(want).isCalm()) revert NotCalm();` | volatility gate |
| **empty-balance** | *(none)* | `if (native.balanceOf(this) > 0)` | **succeeds, pays 0, no revert** |
| Panic div-by-zero | `0x4e487b71` + `0x12` | in swap path | observed on `aero-cow-weth-ethfi-vault` `0x87308630CBa79d65BABaE73f00aD7E18dBAd7eB9` |
| unresolved | `0xb317087b` | — | **UNVERIFIED** name; seen on `0xA7cf5A6844fbd128C6b301d6B5acF46629407D66` |

**There is NO caller gate, NO cooldown `require`, NO minimum-pending threshold, NO whitelist, NO stake, and the caller sends no value.** `lastHarvest` is only *written*; it is read solely by `lockedProfit()` (line 294) to drip vested profit. Re-harvesting early does not revert — it simply pays ~nothing.

### Three traps a batcher must handle

**(a) The factory kill switch.** `_whenStrategyNotPaused()` reads `factory.globalPause()`. For `0x9D15Bae…`: `factory()` = **`0x9476284d81121613DA5DF5C72f50853a455448F1`**, `globalPause()` = **`false`** (measured), owner `0x3B60F7f25b09E71356cdFFC6475c222A466a2AC9`. **One owner call flips every Beefy strategy on Base to reverting at once.** Cheap insurance: read `globalPause()` once per cycle and skip the batch entirely if true.

**(b) `paused()` on the target is NOT a sufficient pre-check.** `aerodrome-cow-base-weth-mseth-vault` strategy `0x233d3B9c63797D52e296c26fe28659bc285868E2` reads `paused() == false`, yet reverts `StrategyPaused()`. Measured cause: its `want` is CLM vault `0x43dd70fe89ff59A6658dfaf16eCd346d49626f93`, whose **own** strategy `0x763201c2FecC868DAd33E763e86c4f8D88f818F4` has `paused() == true`. The pause is one level down. **Only simulation is authoritative.**

**(c) `isCalm()` flips block to block.** In the 216-sweep, 8 strategies reverted. Re-probed minutes later, **3 of those 8 succeeded** (`ctr-usdc`, `weth-morpho`, `drb-weth`). `isCalm()` is a live volatility check against pool price. **A batch simulated at block N can revert at block N+1.** This is the single strongest argument for per-call failure isolation rather than an all-or-nothing MultiSend — and it is exactly the flaw in the current relay path, whose notes in `harvest.mjs:486` already record that MultiSend is all-or-nothing.

---

## 3. Real economics — full sweep, measured, not estimated

Method: for every non-paused strategy with `callReward() > 0` (216 of 241), one `eth_call` of
`aggregate3([balanceOf(safe), harvest(safe), balanceOf(safe)])`. The reported fee is the **actual WETH balance delta of the ZERO Safe `0x510601f59FDa068D70ad6760c9d9085B0F42cbb1`**, i.e. the real `safeTransfer`, not a view function's opinion.

```
PAY >0  : 208
REVERT  :   8
TOTAL harvestable caller fees RIGHT NOW: 0.00005749202657372 WETH  = $0.1725 @ $3000/ETH
max single: $0.02442   mean: $0.00083   median: $0.00007
```

**Cumulative capture by batch size — this is the batching business case:**

| batch size | cumulative | vs. best single |
|---|---|---|
| 1 | $0.0244 | 1.0× |
| 5 | $0.0708 | 2.9× |
| 10 | $0.1059 | 4.3× |
| **26** | **$0.1439** | **5.9×** |
| 40 | $0.1554 | 6.4× |
| 60 | $0.1639 | 6.7× |
| 100 | $0.1703 | 7.0× |
| 208 (all) | $0.1725 | 7.1× |

Named top payers (strategy address, measured WETH delta, `callReward()` overstatement):

| id | strategy | measured fee (WETH) | ≈USD | lie factor |
|---|---|---|---|---|
| `aero-cow-eurc-cbbtc-vault` | `0x9D15Bae40d2C127C6C69D2D61e0a0fBd0Fc86eAd` | 0.000003663258234569 | $0.01099 | 4478× |
| `aerodrome-cow-base-cbbtc-usdc-vault` | `0x8B45D51e015Dac924EeAEa754e6f768943206F05` | 0.000002651963149591 | $0.00796 | 4475× |
| `aero-cow-weth-usdc-vault` | `0x087A4Cb5299b178fc5dA6f47127c1B5d7B5bc6Bc` | 0.000001847867649827 | $0.00554 | 4479× |
| `aerodrome-cow-base-cbltc-cbbtc-vault` | `0xa0dBaE6a747BF5deB0254B62bb2557489d6b837D` | 0.000001638243686581 | $0.00491 | 4475× |
| `pancakeswap-cow-base-sol-cbbtc-vault` | `0xafF4f20E5F340f11944DB3eC9adE6A29c13FE67d` | 0.000001098621293642 | $0.00330 | 1284× |
| `aerodrome-cow-base-cbada-cbbtc-vault` | `0x50199073482b0413a4321B21da97aC090D70d05E` | 0.000000891292900506 | $0.00267 | 4479× |

### Honest read on the money — say this plainly

- **$0.1725 is the ENTIRE instantaneous Beefy-Base caller-fee pool**, if ZERO captured 100 % of it in one atomic sweep with zero competition. That is the ceiling of this specific rail, right now, measured.
- The pool refills as rewards accrue. On-chain `lastHarvest` across the top strategies spans **5 h to 48 h ago**, so full regeneration is on the order of a day. **Order-of-magnitude ceiling ≈ $0.17/day at 100 % capture** — and capture will not be 100 %, because Beefy's own keeper competes (§4).
- Cross-check against reality: ZERO's lifetime is $0.08447 over 26 harvests = **$0.0032/harvest**. My measured mean is $0.00083 and max $0.0244 — ZERO has been picking near the top of the distribution. The numbers agree; nothing here contradicts the ledger.
- Against the $16.66/day goal, a perfect drain of this rail is **~1 %**. **Batching is a genuine 5.9× on the scarce resource (relay slots) and is worth building — but it multiplies a rail whose measured ceiling is about $0.17/day. It does not reach the goal and should not be sold as if it might.**
- The curve is brutally concave: **26 calls capture 83 % of the pool; 100 calls capture 99 %.** Past ~26 targets you are paying gas and calldata for fractions of a cent. **Size the batch at ~20–30, not 256.**

---

## 4. Prior art — real deployed contracts, verified source

### 4a. Multicall3 — `0xcA11bde05977b3631167028862bE2a173976CA11` (verified, solc 0.8.12)
The canonical failure-isolation primitive, and the one I used to prove §0. Selector `aggregate3` = **`0x82ad56cb`** (note: Blockscout's function list renders it as `0xc2e047ff` from a `tuple[]` string — that is wrong; `0x82ad56cb` is what my working calls actually used).

```solidity
    function aggregate3(Call3[] calldata calls) public payable returns (Result[] memory returnData) {
        uint256 length = calls.length;
        returnData = new Result[](length);
        Call3 calldata calli;
        for (uint256 i = 0; i < length;) {
            Result memory result = returnData[i];
            calli = calls[i];
            (result.success, result.returnData) = calli.target.call(calli.callData);
            assembly {
                // Revert if the call fails and failure is not allowed
                if iszero(or(calldataload(add(calli, 0x20)), mload(result))) {
                    ... revert("Multicall3: call failed")
                }
            }
            unchecked { ++i; }
        }
    }
```

**Copy:** per-call `allowFailure` flag; the low-level `.call` that never bubbles; `calldata` struct pointer + `unchecked` increment (real gas savings at batch size 26).
**Do NOT copy — Multicall3 is unsafe as a harvester and these are exactly the gaps `ZeroHarvester.sol` already closes:**
1. **No per-call gas cap.** One target burning all gas kills the batch.
2. **It copies `returnData` into memory.** A malicious target returning megabytes inflates memory cost quadratically. ZeroHarvester's `outsize=0` note (design point 7) is correct and necessary.
3. **No profit check** — it will happily spend the relay slot on a batch that pays nothing.
4. **No reentrancy guard, no conservation invariant.** Multicall3 holds no value so it does not care; ZeroHarvester transiently might.

### 4b. Gelato Automate (Base) — proxy `0x2A6C106ae13B558BB9E2Ec64Bd2f1f7BEFF3A5E0` (EIP173Proxy) → impl `0x6C42e4c6eA536095344967Dd7e87597Bb2eb7146` (`Automate`, verified)
The pattern worth stealing is **one code path for simulation and execution**, selected by a parameter:
```solidity
function _call(
    address _add,
    bytes memory _data,
    uint256 _value,
    bool _revertOnFailure,
    string memory _tracingInfo
) returns (bool success, bytes memory returnData) {
    (success, returnData) = _add.call{value: _value}(_data);

    if (!success && _revertOnFailure)
        GelatoBytes.revertWithError(returnData, _tracingInfo);
}
```
`bool _revertOnFailure` is threaded through `exec`, `exec1Balance`, `execBypassModule`, `execBypassModuleSyncFee` — documented in-source as *"To revert or not if call to execAddress fails. (Used for off-chain simulations)"*.

**Recommendation for ZeroHarvester:** `ZeroHarvester.sol` currently argues (correctly) that `eth_call` on `execute` *is* the simulation. Gelato's refinement is better: add a `bool revertOnUnprofitable` (or simulate-only) parameter so an off-chain probe can get the **per-call success bitmap and the exact profit number back as return data** even when the batch would be unprofitable, instead of learning only "it reverted". Right now an `Unprofitable` revert tells you the batch failed but not which targets would have paid — you lose the information you most need to pick the next batch. Gelato also `_delegateCall`s; ZeroHarvester's blanket no-delegatecall rule is the right call for our threat model and should stay.

### 4c. BeefyZapRouter — `0x6F19Da51d488926C007B9eBaa5968291a2eC6a63` (verified, solc 0.8.19)
`executeOrder(tuple,tuple,bytes,tuple[])` / `executeOrder(tuple,tuple[])`, owner-pausable, uses Permit2. Not a keeper batcher, but it is the live proof (§0 proof 4) that a contract's call reaches `_harvest`.

### 4d. Beefy's own keeper on Base — and it does NOT batch
Every recent `StratHarvest` on the top strategies was sent by **EOA `0x03d9964f4D93a24B58c0Fc3a8Df3474b59Ba8557`**, calling the strategy **directly**, selector `0x0e5c011e`, **calldata length 36 bytes — one strategy per transaction**:

- `0xdf3cc34a9f74213a4f6f2511cf02c88b3040461a57411e8632307173234c3604`
- `0xa6557fb08622acb28177a938050b00e17ce5d98e264785673a3c5d063386bc28`
- `0xef72dd8dc35c5e7e47e5636068486df14a3fb45c29d5d4c70efdda8f3a49dd27`
- `0xe29ff8a541f79501388cbe59e8c95f273e7191429bb60a8d82226ba797cd1f99`

(The strategy's own `keeper()` is a different address, `0x4fED5491693007f0CD49f4614FFC38Ab6A04B619` — but `keeper` gates manager functions, not `harvest`.)

**I found no `BeefyHarvester` / `HarvestManager` batching contract deployed on Base. UNVERIFIED that none exists** — I searched by resolving the actual harvesters of live strategies rather than by name, so a batcher used only on other vaults would not show up. What is verified: **the dominant harvester on Base today is a single EOA doing one un-batched call per tx.** Two consequences: the competition is beatable on throughput-per-slot, and it also means the pool in §3 is being drained continuously by someone with no relay-slot constraint.

---

## 5. Concrete recommendations for `ZeroHarvester.sol`

1. **Ship it — the premise holds.** No EOA gate exists. §0.
2. **Always `harvest(address)` `0x0e5c011e` with BENEFICIARY.** Never `harvest()`; its `tx.origin` default pays the relayer.
3. **The profit invariant must count WETH, not ETH.** The fee arrives via `safeTransfer` of `0x4200…0006`. An ETH-only `minProfitWei` check reads zero on every successful harvest and reverts the batch. Make WETH a declared sweep token and measure profit as its delta.
4. **Cap the batch at ~20–30, not 256.** Measured: 26 calls capture 83 % of the pool, 100 calls capture 99 %. `MAX_CALLS = 256` is harmless as a bound but never worth filling.
5. **Failure isolation is load-bearing, not a nicety.** `isCalm()` flips between blocks — 3 of 8 reverters recovered within minutes. All-or-nothing MultiSend loses the whole slot to one volatile pool.
6. **Add a simulate-mode return (Gelato pattern, §4b)** so a probe recovers the success bitmap and profit figure even on an unprofitable batch.
7. **Pre-flight `factory.globalPause()`** (`0x9476284d81121613DA5DF5C72f50853a455448F1`) once per cycle — one owner call bricks every target simultaneously.
8. **Rank by simulated WETH delta, never by `callReward()`.** If you must pre-rank cheaply, bucket by `rewards[0]` first: the overstatement is a price ratio (~4,478× AERO, ~1,280× Pancake), so cross-family comparison mis-ranks by ~3.5×.
9. **Never pre-filter on `paused()` alone** — the mseth case reads `false` and still reverts (§2b).

---

## Appendix — reproduce

Every figure re-derivable with `ethers` v6 against `https://mainnet.base.org`:
- strategies: `vault.strategy()` over `_beefy_base.json` via Multicall3 `aggregate3` (0x82ad56cb)
- implementations: EIP-1167 regex `363d3d373d3d3d363d73<20b>5af43d82803e903d91602b57fd5bf3`; else EIP-1967 slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`; else beacon slot `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50` → `beacon.implementation()`. Measured mix: **215 EIP-1167, 25 beacon, 1 direct.**
- fee measurement: `eth_call` Multicall3 `aggregate3([balanceOf, harvest(addr), balanceOf])`, take the delta.
- ⚠️ `base-rpc.publicnode.com` rate-limits at 1200 req/60 s and its `eth_getLogs` rejected every range I tried; use `mainnet.base.org` for calls and **Blockscout `/api/v2/addresses/{addr}/logs` for logs** — direct `eth_getLogs` failed on both RPCs.
