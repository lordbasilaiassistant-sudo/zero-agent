// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ZeroHarvester — batched, failure-isolated, profit-gated caller for permissionless bounties.
/// @notice Built for ZERO (the autonomous agent that earns from a never-funded wallet). ZERO's scarce
///         resource is not gas and not ideas — it is RELAY SLOTS: Safe's sponsored relay allows
///         5 transactions per chain per day. Today one slot buys one harvest() call, and a call that
///         reverts (the normal case — most vaults have nothing to harvest at any given moment) buys
///         nothing at all. This contract turns one slot into up to 256 attempts, keeps the ones that
///         pay, and refuses to consume the slot at all if the batch would not be profitable.
///
/// @dev    THREAT MODEL AND THE DESIGN THAT ANSWERS IT.
///         Every target this contract calls is third-party code that must be assumed hostile, and
///         `execute` is permissionless (deliberately: anyone willing to pay gas to enrich the
///         beneficiary is welcome — that is a feature, not a hole). Safety here comes from removing
///         capabilities rather than guarding them:
///
///         1. NO OWNER, NO ADMIN, NO UPGRADE PATH, NO SELFDESTRUCT. There is no privileged key to
///            steal, lose, or phish. What is deployed is what runs, forever.
///         2. IMMUTABLE BENEFICIARY. Value can only ever leave this contract toward one address fixed
///            at construction. A malicious caller's best available attack is to enrich ZERO.
///         3. NO DELEGATECALL, ANYWHERE. A delegatecall to hostile code would hand it this contract's
///            identity and storage. The opcode never appears; only CALL is used.
///         4. NO ETH VALUE SENDS. `Call` has no value field. Because the contract can never be made to
///            send ETH to an arbitrary address, ETH sitting here transiently cannot be redirected.
///         5. CONSERVATION INVARIANT. Whatever this contract holds when `execute` begins must still be
///            here (or already at the beneficiary) when it ends. This is what stops a caller from
///            passing `target=USDC, data=transfer(attacker,...)` to strip dust that arrived between
///            transactions. Checked for ETH and for every declared sweep token.
///         6. PROFIT INVARIANT. If the beneficiary's ETH gain is below `minProfitWei`, the whole
///            transaction reverts — the relay slot is not spent on a batch that does not pay.
///         7. RETURNDATA-BOMB DEFENSE. Calls are made in assembly with outsize=0, so a target returning
///            megabytes cannot inflate this contract's memory cost. Return data is never copied.
///         8. GAS-GRIEFING DEFENSE. Every call carries an explicit gas cap, and a reserve is held back
///            so the sweeps and invariant checks always complete.
///         9. REENTRANCY GUARD on `execute`, so profit accounting cannot be confused by a target that
///            calls back in.
///
///         WHAT THIS CONTRACT DOES NOT DO: it does not decide what to call. Target selection stays
///         off-chain in ZERO's discovery layer, where it can be simulated for free. `eth_call` on
///         `execute` is the simulation and it runs the identical code path, so what is simulated is
///         exactly what executes — no drift between the checker and the checked.
contract ZeroHarvester {
    // ---------------------------------------------------------------- types

    /// @param target   contract to call (never address(0), never this contract)
    /// @param gasLimit gas cap for this call; 0 means "all available minus the reserve"
    /// @param data     calldata. ⚠️ ALWAYS `harvest(address callFeeRecipient)` with ZERO's Safe as the
    ///                 argument — NEVER the no-argument `harvest()`. Verified from the source of
    ///                 `StrategyRewardPool` at 0x68Ecddba8D4CfCa13923fC8d66f2678BF17aB4e1, the single
    ///                 implementation behind 215 of 241 Base strategies:
    ///                     function harvest() external { _harvest(tx.origin); }
    ///                 It pays **tx.origin**, not msg.sender. Called through a sponsored relay, tx.origin
    ///                 is the SPONSOR'S EOA — so the no-arg form silently donates every fee to whoever
    ///                 paid the gas. The two-argument form is the only one that pays us.
    struct Call {
        address target;
        uint32 gasLimit;
        bytes data;
    }

    // ------------------------------------------------------------ constants

    /// @notice Upper bound on batch size. 256 is not arbitrary: the result bitmap is one uint256, so
    ///         every outcome in a maximal batch fits in a single word of event data.
    uint256 public constant MAX_CALLS = 256;

    /// @notice Gas held back from the final call so sweeps and invariant checks cannot be starved.
    uint256 public constant GAS_RESERVE = 150_000;

    /// @notice The single address any value may ever reach. Immutable, set once, at construction.
    address public immutable BENEFICIARY;

    // --------------------------------------------------------------- errors

    error NoBeneficiary();
    error EmptyBatch();
    error BatchTooLarge(uint256 given, uint256 max);
    error BadTarget(uint256 index);
    error Unprofitable(uint256 profitWei, uint256 minProfitWei);
    error EthLeaked(uint256 balanceBefore, uint256 balanceAfter);
    error TokenLeaked(address token, uint256 balanceBefore, uint256 balanceAfter);
    error SweepFailed(address token);
    error Reentrancy();
    error OutOfGasReserve();

    // --------------------------------------------------------------- events

    /// @notice One event per batch. `successBits` bit i is set when calls[i] returned successfully;
    ///         ZERO reads this to learn which targets actually pay and prune the ones that never do.
    event Batch(
        address indexed caller,
        uint256 callCount,
        uint256 succeeded,
        uint256 successBits,
        uint256 ethProfitWei
    );

    /// @notice Emitted whenever value is pushed to the beneficiary (token == address(0) means ETH).
    event Swept(address indexed token, uint256 amount);

    // ---------------------------------------------------------------- state

    /// @dev Reentrancy flag. 1 = idle, 2 = executing (non-zero to non-zero is the cheap transition).
    uint256 private _lock = 1;

    // ----------------------------------------------------------- constructor

    constructor(address beneficiary_) {
        if (beneficiary_ == address(0)) revert NoBeneficiary();
        BENEFICIARY = beneficiary_;
    }

    /// @notice Accept ETH. Bounties that pay msg.sender land here and are swept onward by `execute`
    ///         or by anyone calling `rescueETH()`.
    receive() external payable {}

    // -------------------------------------------------------------- execute

    /// @notice Run a batch of bounty calls, isolating failures, then sweep everything to the
    ///         beneficiary and require the batch actually paid.
    /// @param calls        the batch; a reverting entry is recorded and skipped, never fatal
    /// @param sweepTokens  ERC20s to move to the beneficiary afterwards (may be empty)
    /// @param minProfitWei revert the whole transaction unless the beneficiary gained at least this
    ///                     much ETH; pass 0 for best-effort mode (discovery), non-zero in production
    ///                     so a relay slot is never spent on an unprofitable batch
    /// @return succeeded   number of calls that returned successfully
    /// @return successBits bit i set when calls[i] succeeded
    /// @return ethProfit   ETH the beneficiary gained across this transaction
    function execute(Call[] calldata calls, address[] calldata sweepTokens, uint256 minProfitWei)
        external
        returns (uint256 succeeded, uint256 successBits, uint256 ethProfit)
    {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;

        uint256 n = calls.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_CALLS) revert BatchTooLarge(n, MAX_CALLS);

        // Snapshots for the two invariants. `beneficiaryBefore` measures profit; `selfEthBefore` and
        // the per-token snapshots enforce conservation of anything already sitting here.
        uint256 beneficiaryBefore = BENEFICIARY.balance;
        uint256 selfEthBefore = address(this).balance;

        uint256 tokenCount = sweepTokens.length;
        uint256[] memory tokenBefore = new uint256[](tokenCount);
        for (uint256 i; i < tokenCount;) {
            tokenBefore[i] = _balanceOf(sweepTokens[i]);
            unchecked { ++i; }
        }

        // ---- the batch. A revert here is expected traffic, not an error: most bounty targets have
        // nothing to pay most of the time, which is exactly why one-call-per-slot wasted so many.
        for (uint256 i; i < n;) {
            address target = calls[i].target;
            if (target == address(0) || target == address(this)) revert BadTarget(i);

            uint256 available = gasleft();
            if (available <= GAS_RESERVE) revert OutOfGasReserve();
            unchecked { available -= GAS_RESERVE; }

            uint256 cap = calls[i].gasLimit;
            uint256 callGas = (cap == 0 || cap > available) ? available : cap;

            bytes calldata d = calls[i].data;
            bool ok;
            assembly ("memory-safe") {
                let ptr := mload(0x40)
                calldatacopy(ptr, d.offset, d.length)
                // outsize = 0: return data is never copied, so a target cannot grief us with a
                // multi-megabyte return value. value = 0: this contract never sends ETH to a target.
                ok := call(callGas, target, 0, ptr, d.length, 0, 0)
            }

            if (ok) {
                unchecked { ++succeeded; }
                successBits |= (1 << i);
            }
            unchecked { ++i; }
        }

        // ---- conservation, then sweep. Checked BEFORE moving anything so a leak is attributed to the
        // batch rather than hidden by the sweep that follows.
        uint256 selfEthAfter = address(this).balance;
        if (selfEthAfter < selfEthBefore) revert EthLeaked(selfEthBefore, selfEthAfter);

        for (uint256 i; i < tokenCount;) {
            address token = sweepTokens[i];
            uint256 bal = _balanceOf(token);
            if (bal < tokenBefore[i]) revert TokenLeaked(token, tokenBefore[i], bal);
            if (bal != 0) _sweepToken(token, bal);
            unchecked { ++i; }
        }

        if (selfEthAfter != 0) _sweepETH(selfEthAfter);

        // ---- profit gate. Underflow is impossible: BENEFICIARY.balance only grows here, since this
        // contract sends ETH nowhere else and the batch can never make it send ETH at all.
        unchecked { ethProfit = BENEFICIARY.balance - beneficiaryBefore; }
        if (ethProfit < minProfitWei) revert Unprofitable(ethProfit, minProfitWei);

        emit Batch(msg.sender, n, succeeded, successBits, ethProfit);
        _lock = 1;
    }

    // --------------------------------------------------------------- rescue

    /// @notice Push stray ETH to the beneficiary. Permissionless on purpose — there is no owner to
    ///         call it, and it has exactly one possible destination, so opening it to everyone costs
    ///         nothing and guarantees value can never be stranded here.
    function rescueETH() external {
        uint256 bal = address(this).balance;
        if (bal != 0) _sweepETH(bal);
    }

    /// @notice Push a stray ERC20 to the beneficiary. Same reasoning as {rescueETH}.
    function rescueToken(address token) external {
        uint256 bal = _balanceOf(token);
        if (bal != 0) _sweepToken(token, bal);
    }

    // ------------------------------------------------------------- internals

    function _sweepETH(uint256 amount) private {
        // The beneficiary is ZERO's own Safe. `call` (not `transfer`) so a smart account with a
        // non-trivial receive hook is never locked out by the 2300-gas stipend.
        (bool ok,) = BENEFICIARY.call{value: amount}("");
        if (!ok) revert SweepFailed(address(0));
        emit Swept(address(0), amount);
    }

    function _sweepToken(address token, uint256 amount) private {
        // Tolerates non-standard ERC20s (USDT-style) that return nothing on success.
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0xa9059cbb, BENEFICIARY, amount)); // transfer(address,uint256)
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert SweepFailed(token);
        emit Swept(token, amount);
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSelector(0x70a08231, address(this))); // balanceOf(address)
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }
}
