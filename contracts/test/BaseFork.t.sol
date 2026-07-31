// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ZeroHarvester} from "../src/ZeroHarvester.sol";

/// @dev Reality check against live Base state. Unit tests prove the contract does what I wrote; only a
///      fork proves the WORLD behaves the way the design assumes. The design-critical question is the
///      first test here: if these bounty targets refuse contract callers (`onlyEOA`, or
///      `require(msg.sender == tx.origin)`), then batching is impossible for this route and the whole
///      approach needs rethinking. Better to learn that from a fork than from a spent relay slot.
///
///      Run: forge test --match-contract BaseFork --fork-url https://base-rpc.publicnode.com -vv
contract BaseForkTest is Test {
    /// ZERO's own Safe — the beneficiary and the address it already passes as callFeeRecipient.
    address constant ZERO_SAFE = 0x510601f59FDa068D70ad6760c9d9085B0F42cbb1;

    /// From ZERO's journal: "PAYS_CALLERS verdict with real settled payouts".
    address constant PROVEN_PAYER = 0x11dD6940AeA57aAC6aC4D204E13161BB6E5Bf0A8;

    ZeroHarvester internal h;
    bool internal forked;

    function setUp() public {
        // Skip gracefully when run without --fork-url so the default suite stays green offline.
        forked = block.chainid == 8453;
        if (!forked) return;
        h = new ZeroHarvester(ZERO_SAFE);
    }

    modifier onlyForked() {
        if (!forked) {
            console.log("SKIPPED: not on a Base fork (run with --fork-url)");
            return;
        }
        _;
    }

    /// @notice THE DESIGN-CRITICAL TEST. Does the proven payer accept a CONTRACT as caller?
    ///         A revert whose reason mentions EOA/tx.origin would kill the batching design for this
    ///         route; any other outcome (success, or a cooldown/"nothing to harvest" revert) means a
    ///         contract caller is structurally acceptable and only timing decides payment.
    function test_Fork_ProvenPayer_AcceptsContractCaller() public onlyForked {
        assertGt(PROVEN_PAYER.code.length, 0, "target has code on Base");
        console.log("target code size:", PROVEN_PAYER.code.length);

        ZeroHarvester.Call[] memory calls = new ZeroHarvester.Call[](1);
        calls[0] = ZeroHarvester.Call({
            target: PROVEN_PAYER,
            gasLimit: 3_000_000,
            data: abi.encodeWithSignature("harvest(address)", ZERO_SAFE)
        });

        uint256 before = ZERO_SAFE.balance;
        (uint256 ok, uint256 bits, uint256 profit) = h.execute(calls, new address[](0), 0);

        console.log("succeeded:", ok);
        console.log("successBits:", bits);
        console.log("profit wei:", profit);
        console.log("safe balance delta:", ZERO_SAFE.balance - before);

        // The batch itself must never revert regardless of what the target does — that is the whole
        // point of failure isolation. What we learn here is whether `ok` is 1 or 0.
        if (ok == 1) {
            console.log("RESULT: contract caller ACCEPTED by the proven payer");
        } else {
            console.log("RESULT: call reverted (cooldown / nothing pending / caller policy) - see raw probe");
        }
    }

    /// @notice Probe the target directly to read WHY it reverts, if it does. `execute` deliberately
    ///         discards return data (bomb defense), so the diagnosis has to happen out here.
    function test_Fork_DiagnoseRevertReason() public onlyForked {
        string[4] memory sigs =
            ["harvest(address)", "harvest()", "managerHarvest()", "callReward()"];

        for (uint256 i; i < sigs.length; i++) {
            bytes memory data = keccak256(bytes(sigs[i])) == keccak256(bytes("harvest(address)"))
                ? abi.encodeWithSignature("harvest(address)", ZERO_SAFE)
                : abi.encodeWithSignature(sigs[i]);

            (bool ok, bytes memory ret) = PROVEN_PAYER.call{gas: 3_000_000}(data);
            console.log("---", sigs[i]);
            console.log("  ok:", ok);
            if (!ok && ret.length >= 68) {
                // Standard Error(string) revert: skip selector + offset + length.
                bytes memory reason = new bytes(ret.length - 68);
                for (uint256 j; j < reason.length; j++) {
                    reason[j] = ret[j + 68];
                }
                console.log("  reason:", string(reason));
            } else if (!ok) {
                console.log("  reverted with no/short reason, len:", ret.length);
            }
        }
    }

    /// @notice A contract caller must not be structurally excluded. If a target gates on
    ///         `msg.sender == tx.origin`, calling it from ANY contract is impossible; this asserts we
    ///         at least know which world we are in, loudly, in the log.
    function test_Fork_ReportEOAGating() public onlyForked {
        (bool okFromContract,) = PROVEN_PAYER.call{gas: 3_000_000}(abi.encodeWithSignature("harvest(address)", ZERO_SAFE));

        vm.prank(ZERO_SAFE, ZERO_SAFE); // msg.sender == tx.origin, i.e. a genuine EOA-shaped call
        (bool okAsEOA,) = PROVEN_PAYER.call{gas: 3_000_000}(abi.encodeWithSignature("harvest(address)", ZERO_SAFE));

        console.log("as contract:", okFromContract);
        console.log("as EOA     :", okAsEOA);
        if (!okFromContract && okAsEOA) {
            console.log("!!! EOA-GATED: batching is IMPOSSIBLE for this target. Design must change.");
        } else {
            console.log("not EOA-gated: identical outcome either way, batching is viable");
        }
        assertTrue(okFromContract == okAsEOA, "EOA gating detected - see log, this is design-critical");
    }

    /// @notice Sanity: the beneficiary really is ZERO's Safe and it really exists on Base.
    function test_Fork_BeneficiaryIsZerosSafe() public onlyForked {
        assertEq(h.BENEFICIARY(), ZERO_SAFE);
        console.log("ZERO Safe code size:", ZERO_SAFE.code.length);
        console.log("ZERO Safe balance wei:", ZERO_SAFE.balance);
    }
}
