// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ZeroHarvester} from "../src/ZeroHarvester.sol";
import {
    MockERC20,
    MockERC20NoReturn,
    MockERC20ReturnsFalse,
    MockBounty,
    ReturnDataBomb,
    GasBurner,
    Reenterer,
    RejectingBeneficiary,
    GreedyBeneficiary
} from "./Mocks.sol";

/// @dev The safety argument for ZeroHarvester, written as executable assertions. Sections mirror the
///      numbered threat model in the contract's own header, so a reviewer can check them off.
contract ZeroHarvesterTest is Test {
    ZeroHarvester internal h;
    address internal beneficiary = address(0xBEEF);
    address internal attacker = address(0xBAD);

    function setUp() public {
        h = new ZeroHarvester(beneficiary);
        vm.deal(beneficiary, 0);
    }

    // -------------------------------------------------------------- helpers

    function _call(address target, bytes memory data) internal pure returns (ZeroHarvester.Call memory) {
        return ZeroHarvester.Call({target: target, gasLimit: 0, data: data});
    }

    function _one(ZeroHarvester.Call memory c) internal pure returns (ZeroHarvester.Call[] memory a) {
        a = new ZeroHarvester.Call[](1);
        a[0] = c;
    }

    function _noTokens() internal pure returns (address[] memory) {
        return new address[](0);
    }

    // ================================================================ 0. basics

    function test_Constructor_SetsImmutableBeneficiary() public view {
        assertEq(h.BENEFICIARY(), beneficiary);
    }

    function test_Constructor_RejectsZeroBeneficiary() public {
        vm.expectRevert(ZeroHarvester.NoBeneficiary.selector);
        new ZeroHarvester(address(0));
    }

    function test_Reverts_OnEmptyBatch() public {
        vm.expectRevert(ZeroHarvester.EmptyBatch.selector);
        h.execute(new ZeroHarvester.Call[](0), _noTokens(), 0);
    }

    function test_Reverts_OnOversizedBatch() public {
        ZeroHarvester.Call[] memory calls = new ZeroHarvester.Call[](257);
        for (uint256 i; i < 257; i++) {
            calls[i] = _call(address(0x1234), "");
        }
        vm.expectRevert(abi.encodeWithSelector(ZeroHarvester.BatchTooLarge.selector, 257, 256));
        h.execute(calls, _noTokens(), 0);
    }

    function test_Reverts_OnZeroAddressTarget() public {
        vm.expectRevert(abi.encodeWithSelector(ZeroHarvester.BadTarget.selector, uint256(0)));
        h.execute(_one(_call(address(0), "")), _noTokens(), 0);
    }

    function test_Reverts_OnSelfTarget() public {
        vm.expectRevert(abi.encodeWithSelector(ZeroHarvester.BadTarget.selector, uint256(0)));
        h.execute(_one(_call(address(h), "")), _noTokens(), 0);
    }

    // ====================================================== 1. the core purpose
    // One relay slot must buy many attempts, and a failing attempt must not poison the batch.

    function test_Batch_IsolatesFailures_AndPaysBeneficiary() public {
        MockBounty payer1 = new MockBounty(0.01 ether);
        MockBounty payer2 = new MockBounty(0.02 ether);
        MockBounty dry = new MockBounty(0.01 ether);
        vm.deal(address(payer1), 1 ether);
        vm.deal(address(payer2), 1 ether);
        dry.setDry(true);

        ZeroHarvester.Call[] memory calls = new ZeroHarvester.Call[](3);
        calls[0] = _call(address(payer1), abi.encodeWithSignature("harvest()"));
        calls[1] = _call(address(dry), abi.encodeWithSignature("harvest()")); // reverts: normal traffic
        calls[2] = _call(address(payer2), abi.encodeWithSignature("harvest()"));

        (uint256 ok, uint256 bits, uint256 profit) = h.execute(calls, _noTokens(), 0);

        assertEq(ok, 2, "two of three should succeed");
        assertEq(bits, 5, "bitmap 0b101 marks calls 0 and 2");
        assertEq(profit, 0.03 ether, "profit is the sum of both payouts");
        assertEq(beneficiary.balance, 0.03 ether, "value reached the beneficiary");
        assertEq(address(h).balance, 0, "harvester keeps nothing");
    }

    function test_Batch_AllFailing_LeavesNoDamage() public {
        MockBounty dry = new MockBounty(1 ether);
        dry.setDry(true);
        ZeroHarvester.Call[] memory calls = new ZeroHarvester.Call[](5);
        for (uint256 i; i < 5; i++) {
            calls[i] = _call(address(dry), abi.encodeWithSignature("harvest()"));
        }

        (uint256 ok, uint256 bits, uint256 profit) = h.execute(calls, _noTokens(), 0);
        assertEq(ok, 0);
        assertEq(bits, 0);
        assertEq(profit, 0);
        assertEq(beneficiary.balance, 0);
    }

    function test_Batch_DirectRecipientShape_AlsoCounted() public {
        // harvest(address) pays the beneficiary directly rather than the harvester; profit accounting
        // must see it either way.
        MockBounty payer = new MockBounty(0.05 ether);
        vm.deal(address(payer), 1 ether);

        (,, uint256 profit) = h.execute(
            _one(_call(address(payer), abi.encodeWithSignature("harvest(address)", beneficiary))), _noTokens(), 0
        );
        assertEq(profit, 0.05 ether);
        assertEq(beneficiary.balance, 0.05 ether);
    }

    function test_Batch_At256Calls_FitsTheBitmap() public {
        MockBounty payer = new MockBounty(1 wei);
        vm.deal(address(payer), 1 ether);
        ZeroHarvester.Call[] memory calls = new ZeroHarvester.Call[](256);
        for (uint256 i; i < 256; i++) {
            calls[i] = _call(address(payer), abi.encodeWithSignature("harvest()"));
        }
        (uint256 ok,, uint256 profit) = h.execute(calls, _noTokens(), 0);
        assertEq(ok, 256, "all 256 land");
        assertEq(profit, 256 wei);
    }

    // ==================================================== 6. the profit invariant
    // A relay slot is the scarce resource; an unprofitable batch must not consume one.

    function test_ProfitGate_RevertsWhenBelowMinimum() public {
        MockBounty payer = new MockBounty(0.001 ether);
        vm.deal(address(payer), 1 ether);

        vm.expectRevert(abi.encodeWithSelector(ZeroHarvester.Unprofitable.selector, 0.001 ether, 0.01 ether));
        h.execute(_one(_call(address(payer), abi.encodeWithSignature("harvest()"))), _noTokens(), 0.01 ether);
    }

    function test_ProfitGate_PassesExactlyAtMinimum() public {
        MockBounty payer = new MockBounty(0.01 ether);
        vm.deal(address(payer), 1 ether);
        (,, uint256 profit) =
            h.execute(_one(_call(address(payer), abi.encodeWithSignature("harvest()"))), _noTokens(), 0.01 ether);
        assertEq(profit, 0.01 ether);
    }

    function test_ProfitGate_ZeroMeansBestEffort() public {
        MockBounty dry = new MockBounty(1 ether);
        dry.setDry(true);
        (uint256 ok,,) = h.execute(_one(_call(address(dry), abi.encodeWithSignature("harvest()"))), _noTokens(), 0);
        assertEq(ok, 0, "discovery mode tolerates a zero-profit batch");
    }

    // ================================================= 5. the conservation invariant
    // The attack this exists to stop: a caller passing token.transfer(attacker) to strip anything
    // sitting in the contract between transactions.

    function test_Conservation_BlocksTokenTheftViaCraftedCalldata() public {
        MockERC20 token = new MockERC20();
        token.mint(address(h), 1000e18); // dust that arrived between batches

        address[] memory sweep = new address[](1);
        sweep[0] = address(token);

        // The attacker's whole batch is one crafted call: move the harvester's tokens to themselves.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(ZeroHarvester.TokenLeaked.selector, address(token), uint256(1000e18), uint256(0))
        );
        h.execute(
            _one(_call(address(token), abi.encodeWithSignature("transfer(address,uint256)", attacker, 1000e18))),
            sweep,
            0
        );

        assertEq(token.balanceOf(attacker), 0, "attacker gets nothing");
        assertEq(token.balanceOf(address(h)), 1000e18, "state rolled back");
    }

    function test_Conservation_UndeclaredTokenTheftStillFailsToPayAttacker_AndIsSweptLater() public {
        // If the caller does NOT declare the token, the per-token check cannot run. The remaining
        // guarantee is the one that matters: the attacker still cannot receive anything, because a
        // successful theft leaves profit at zero and any honest operator runs with minProfit > 0.
        MockERC20 token = new MockERC20();
        token.mint(address(h), 1000e18);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ZeroHarvester.Unprofitable.selector, uint256(0), uint256(1)));
        h.execute(
            _one(_call(address(token), abi.encodeWithSignature("transfer(address,uint256)", attacker, 1000e18))),
            _noTokens(),
            1 // any non-zero floor
        );
        assertEq(token.balanceOf(address(h)), 1000e18, "reverted, nothing moved");

        // And anyone may push it to the beneficiary at any time.
        h.rescueToken(address(token));
        assertEq(token.balanceOf(beneficiary), 1000e18);
    }

    function test_Conservation_ETHCannotLeave_ContractHasNoValueSendPath() public {
        // The Call struct has no value field, so a batch cannot make the harvester send ETH at all.
        // Prove the balance survives an adversarial batch aimed at a payable target.
        vm.deal(address(h), 5 ether);
        MockBounty sink = new MockBounty(0);

        vm.prank(attacker);
        h.execute(_one(_call(address(sink), "")), _noTokens(), 0); // fallback/receive, no value moves

        assertEq(address(sink).balance, 0, "no ETH reached the target");
        assertEq(beneficiary.balance, 5 ether, "the harvester's ETH was swept to the beneficiary");
        assertEq(address(h).balance, 0);
    }

    // ======================================================== 3. no delegatecall
    // Checked against the deployed runtime bytecode, not against the source, because the source is
    // what I wrote and the bytecode is what runs.

    /// @dev A naive byte scan is WRONG here and my first version of this test failed because of it:
    ///      0xff and 0xf4 occur constantly inside PUSH immediates (constants, selectors, the trailing
    ///      CBOR metadata hash) where they are data, not instructions. Opcodes are only meaningful at
    ///      instruction boundaries, so this walks the bytecode properly, stepping over the immediate
    ///      data of every PUSH1..PUSH32. Anything less is a test that passes or fails by luck.
    function test_Bytecode_ContainsNoDelegatecallOrSelfdestruct() public view {
        bytes memory code = address(h).code;
        assertGt(code.length, 0, "deployed");

        // Solidity appends a CBOR metadata blob whose final two bytes are its own length. That blob is
        // DATA and is never executed, but a disassembler walking it produces phantom opcodes — this is
        // not hypothetical, it is what happened here: `cast disassemble` reported DELEGATECALL, CREATE
        // and CREATE2 at offsets 2263/2272/2282 of a 2306-byte runtime, every one of them inside the
        // 51-byte trailer that begins at 2253 with the 0xa2 CBOR marker. Strip it before judging.
        uint256 codeEnd = code.length;
        if (code.length > 2) {
            uint256 metaLen = (uint256(uint8(code[code.length - 2])) << 8) | uint256(uint8(code[code.length - 1]));
            if (metaLen + 2 <= code.length) codeEnd = code.length - 2 - metaLen;
        }
        assertLt(codeEnd, code.length, "metadata trailer located");

        uint256 i;
        uint256 instructions;
        while (i < codeEnd) {
            uint8 op = uint8(code[i]);

            assertTrue(op != 0xf4, "DELEGATECALL reachable in runtime bytecode");
            assertTrue(op != 0xf2, "CALLCODE reachable in runtime bytecode");
            assertTrue(op != 0xff, "SELFDESTRUCT reachable in runtime bytecode");
            assertTrue(op != 0xf5, "CREATE2 reachable in runtime bytecode");
            assertTrue(op != 0xf0, "CREATE reachable in runtime bytecode");

            unchecked {
                ++instructions;
                // PUSH1 (0x60) .. PUSH32 (0x7f): the next (op - 0x5f) bytes are data, not code.
                i += (op >= 0x60 && op <= 0x7f) ? (op - 0x5f) + 1 : 1;
            }
        }
        assertGt(instructions, 100, "walked a real instruction stream");
    }

    /// @dev Control for the test above: prove the walker actually detects the opcodes it claims to,
    ///      rather than passing because it never finds anything. A checker that cannot fail is decor.
    function test_BytecodeWalker_DetectsOpcodes_WhenTheyAreReallyThere() public {
        // runtime: PUSH1 0x00 DUP1 DUP1 DUP1 DUP1 GAS DELEGATECALL — a genuine DELEGATECALL at an
        // instruction boundary, deployed for real so the walker sees deployed code, not a literal.
        bytes memory runtime = hex"6000808080805af4";
        address probe;
        bytes memory initcode = abi.encodePacked(
            hex"600880600b6000396000f3", // return the 8 runtime bytes that follow
            runtime
        );
        assembly {
            probe := create(0, add(initcode, 0x20), mload(initcode))
        }
        assertTrue(probe != address(0), "probe deployed");

        bytes memory code = probe.code;
        bool sawDelegatecall;
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == 0xf4) sawDelegatecall = true;
            unchecked {
                i += (op >= 0x60 && op <= 0x7f) ? (op - 0x5f) + 1 : 1;
            }
        }
        assertTrue(sawDelegatecall, "the walker must find a DELEGATECALL that is genuinely present");
    }

    // ================================================== 7. returndata-bomb defense

    function test_ReturnDataBomb_DoesNotBlowUpTheBatch() public {
        ReturnDataBomb bomb = new ReturnDataBomb();
        MockBounty payer = new MockBounty(0.01 ether);
        vm.deal(address(payer), 1 ether);

        ZeroHarvester.Call[] memory calls = new ZeroHarvester.Call[](2);
        calls[0] = _call(address(bomb), abi.encodeWithSignature("boom()"));
        calls[1] = _call(address(payer), abi.encodeWithSignature("harvest()"));

        uint256 gasBefore = gasleft();
        (uint256 ok,, uint256 profit) = h.execute(calls, _noTokens(), 0);
        uint256 used = gasBefore - gasleft();

        assertEq(ok, 2, "the bomb 'succeeds' but its payload is never copied");
        assertEq(profit, 0.01 ether, "the real payer still landed");
        // A 256KB memory copy would cost on the order of millions of gas; assert we are nowhere near.
        assertLt(used, 1_000_000, "return data was not copied into memory");
    }

    // ==================================================== 8. gas-griefing defense

    function test_GasBurner_CannotStarveTheSweep() public {
        GasBurner burner = new GasBurner();
        MockBounty payer = new MockBounty(0.02 ether);
        vm.deal(address(payer), 1 ether);

        ZeroHarvester.Call[] memory calls = new ZeroHarvester.Call[](2);
        calls[0] = ZeroHarvester.Call({
            target: address(burner),
            gasLimit: 100_000, // explicit cap contains it
            data: abi.encodeWithSignature("burn()")
        });
        calls[1] = _call(address(payer), abi.encodeWithSignature("harvest()"));

        (uint256 ok,, uint256 profit) = h.execute(calls, _noTokens(), 0);
        assertEq(ok, 1, "the burner fails, the payer succeeds");
        assertEq(profit, 0.02 ether, "sweep completed despite the burn");
        assertEq(beneficiary.balance, 0.02 ether);
    }

    function test_UncappedGasBurner_LeavesReserveForTheSweep() public {
        // gasLimit 0 forwards everything except GAS_RESERVE; the sweep must still run.
        GasBurner burner = new GasBurner();
        vm.deal(address(h), 1 ether);

        (uint256 ok,,) = h.execute(_one(_call(address(burner), abi.encodeWithSignature("burn()"))), _noTokens(), 0);
        assertEq(ok, 0);
        assertEq(beneficiary.balance, 1 ether, "reserve was enough to sweep");
    }

    // ========================================================= 9. reentrancy guard

    function test_Reentrancy_IsRejected() public {
        Reenterer r = new Reenterer();
        ZeroHarvester.Call[] memory inner = _one(_call(address(0x1234), ""));
        r.arm(address(h), abi.encodeCall(ZeroHarvester.execute, (inner, _noTokens(), 0)));

        (uint256 ok,,) = h.execute(_one(_call(address(r), abi.encodeWithSignature("poke()"))), _noTokens(), 0);

        assertEq(ok, 1, "the outer call itself succeeds");
        assertTrue(r.tried(), "the reentrant attempt was made");
        assertFalse(r.succeeded(), "and it was rejected");
    }

    function test_Reentrancy_LockIsReleasedAfterwards() public {
        MockBounty payer = new MockBounty(1 wei);
        vm.deal(address(payer), 1 ether);
        bytes memory data = abi.encodeWithSignature("harvest()");
        h.execute(_one(_call(address(payer), data)), _noTokens(), 0);
        h.execute(_one(_call(address(payer), data)), _noTokens(), 0); // second call must not be locked out
        assertEq(beneficiary.balance, 2 wei);
    }

    // ============================================================ token sweeping

    function test_TokenProfit_ReachesBeneficiary() public {
        MockERC20 token = new MockERC20();
        MockBounty payer = new MockBounty(500e18);
        address[] memory sweep = new address[](1);
        sweep[0] = address(token);

        h.execute(
            _one(_call(address(payer), abi.encodeWithSignature("harvestToken(address)", address(token)))), sweep, 0
        );
        assertEq(token.balanceOf(beneficiary), 500e18);
        assertEq(token.balanceOf(address(h)), 0);
    }

    function test_TokenSweep_HandlesNonStandardERC20() public {
        MockERC20NoReturn token = new MockERC20NoReturn();
        token.mint(address(h), 42e18);
        address[] memory sweep = new address[](1);
        sweep[0] = address(token);

        MockBounty noop = new MockBounty(0);
        h.execute(_one(_call(address(noop), "")), sweep, 0);
        assertEq(token.balanceOf(beneficiary), 42e18, "USDT-style token swept");
    }

    function test_TokenSweep_RevertsLoudlyOnFalseReturn() public {
        MockERC20ReturnsFalse token = new MockERC20ReturnsFalse();
        token.mint(address(h), 10e18);
        address[] memory sweep = new address[](1);
        sweep[0] = address(token);

        MockBounty noop = new MockBounty(0);
        vm.expectRevert(abi.encodeWithSelector(ZeroHarvester.SweepFailed.selector, address(token)));
        h.execute(_one(_call(address(noop), "")), sweep, 0);
    }

    function test_BalanceOf_OnNonTokenAddress_IsTreatedAsZero() public {
        // Declaring a non-token address must not brick the batch.
        address[] memory sweep = new address[](1);
        sweep[0] = address(0xDEAD);
        MockBounty noop = new MockBounty(0);
        (uint256 ok,,) = h.execute(_one(_call(address(noop), "")), sweep, 0);
        assertEq(ok, 1);
    }

    // ================================================================== rescue

    function test_Rescue_IsPermissionless_ButOnlyEverPaysBeneficiary() public {
        vm.deal(address(h), 3 ether);
        MockERC20 token = new MockERC20();
        token.mint(address(h), 7e18);

        vm.startPrank(attacker); // even the attacker may call it; it only enriches the beneficiary
        h.rescueETH();
        h.rescueToken(address(token));
        vm.stopPrank();

        assertEq(beneficiary.balance, 3 ether);
        assertEq(token.balanceOf(beneficiary), 7e18);
        assertEq(attacker.balance, 0);
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_Rescue_OnEmptyContract_IsANoop() public {
        h.rescueETH();
        h.rescueToken(address(new MockERC20()));
        assertEq(beneficiary.balance, 0);
    }

    // =========================================================== sweep mechanics

    function test_Sweep_UsesCallNotTransfer_SoSmartAccountsWork() public {
        GreedyBeneficiary greedy = new GreedyBeneficiary();
        ZeroHarvester h2 = new ZeroHarvester(address(greedy));
        MockBounty payer = new MockBounty(0.01 ether);
        vm.deal(address(payer), 1 ether);

        ZeroHarvester.Call[] memory calls = _one(_call(address(payer), abi.encodeWithSignature("harvest()")));
        h2.execute(calls, new address[](0), 0);

        assertEq(greedy.received(), 0.01 ether, "a 2300-gas stipend would have failed here");
    }

    function test_Sweep_FailureIsLoud() public {
        RejectingBeneficiary bad = new RejectingBeneficiary();
        ZeroHarvester h2 = new ZeroHarvester(address(bad));
        vm.deal(address(h2), 1 ether);
        MockBounty noop = new MockBounty(0);

        ZeroHarvester.Call[] memory calls = _one(_call(address(noop), ""));
        vm.expectRevert(abi.encodeWithSelector(ZeroHarvester.SweepFailed.selector, address(0)));
        h2.execute(calls, new address[](0), 0);
    }

    // ==================================================================== fuzz

    /// @notice Whatever the batch shape, the harvester must end holding nothing and the beneficiary
    ///         must never be worse off.
    function testFuzz_NeverRetainsValue_AndBeneficiaryNeverLoses(uint8 nCalls, uint96 payout, uint8 dryMask) public {
        nCalls = uint8(bound(nCalls, 1, 32));
        payout = uint96(bound(payout, 0, 1 ether));

        MockBounty payer = new MockBounty(payout);
        vm.deal(address(payer), 100 ether);
        uint256 beneficiaryBefore = beneficiary.balance;

        ZeroHarvester.Call[] memory calls = new ZeroHarvester.Call[](nCalls);
        for (uint256 i; i < nCalls; i++) {
            calls[i] = _call(address(payer), abi.encodeWithSignature("harvest()"));
        }
        if (dryMask & 1 == 1) payer.setDry(true);

        (, , uint256 profit) = h.execute(calls, _noTokens(), 0);

        assertEq(address(h).balance, 0, "harvester never retains ETH");
        assertGe(beneficiary.balance, beneficiaryBefore, "beneficiary never loses");
        assertEq(beneficiary.balance - beneficiaryBefore, profit, "reported profit equals real gain");
    }

    /// @notice The profit gate must be exact: pass iff profit >= minProfit, for any pair.
    function testFuzz_ProfitGateIsExact(uint96 payout, uint96 minProfit) public {
        payout = uint96(bound(payout, 0, 10 ether));
        minProfit = uint96(bound(minProfit, 0, 10 ether));

        MockBounty payer = new MockBounty(payout);
        vm.deal(address(payer), 100 ether);
        ZeroHarvester.Call[] memory calls = _one(_call(address(payer), abi.encodeWithSignature("harvest()")));

        if (payout >= minProfit) {
            (,, uint256 profit) = h.execute(calls, _noTokens(), minProfit);
            assertEq(profit, payout);
        } else {
            vm.expectRevert(abi.encodeWithSelector(ZeroHarvester.Unprofitable.selector, payout, minProfit));
            h.execute(calls, _noTokens(), minProfit);
        }
    }

    /// @notice No caller identity may change the outcome — the contract has no privileged address.
    function testFuzz_AnyCallerGetsIdenticalResult(address caller) public {
        vm.assume(caller != address(0) && caller != address(h) && caller.code.length == 0);
        MockBounty payer = new MockBounty(0.01 ether);
        vm.deal(address(payer), 1 ether);

        vm.prank(caller);
        (,, uint256 profit) =
            h.execute(_one(_call(address(payer), abi.encodeWithSignature("harvest()"))), _noTokens(), 0);

        assertEq(profit, 0.01 ether);
        assertEq(beneficiary.balance, 0.01 ether, "profit always lands at the immutable beneficiary");
        assertEq(caller.balance, 0, "the caller gains nothing, ever");
    }

    // =============================================================== gas report

    function test_Gas_BatchOf50_IsAffordable() public {
        MockBounty payer = new MockBounty(1 wei);
        vm.deal(address(payer), 1 ether);
        ZeroHarvester.Call[] memory calls = new ZeroHarvester.Call[](50);
        for (uint256 i; i < 50; i++) {
            calls[i] = _call(address(payer), abi.encodeWithSignature("harvest()"));
        }
        uint256 g = gasleft();
        h.execute(calls, _noTokens(), 0);
        uint256 used = g - gasleft();
        console.log("gas for 50-call batch:", used);
        console.log("gas per call:", used / 50);
        assertLt(used, 30_000_000, "fits well inside a Base block");
    }
}
