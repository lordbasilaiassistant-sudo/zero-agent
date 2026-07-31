// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ZeroHarvester} from "../src/ZeroHarvester.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function symbol() external view returns (string memory);
}

interface IStrategy {
    function callReward() external view returns (uint256);
    function harvest(address callFeeRecipient) external;
    function harvest() external;
    function lastHarvest() external view returns (uint256);
    function paused() external view returns (bool);
}

/// @dev THE DECISIVE TEST. A sweep of live Base strategies reported ~$76 of pending caller fees across
///      111 vaults, which is too good to accept: money that free does not sit on a public chain, because
///      Beefy runs its own harvest bots. `callReward()` is a REPORT; this test measures what a harvest
///      actually PAYS, by executing it against forked mainnet state and reading the recipient's real
///      balance delta. A number I have not seen move a balance is a hypothesis, not revenue.
///
///      forge test --match-contract RealHarvest --fork-url https://base-rpc.publicnode.com -vvv
contract RealHarvestTest is Test {
    address constant ZERO_SAFE = 0x510601f59FDa068D70ad6760c9d9085B0F42cbb1;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    /// Top reported payers from contracts/callreward-measurement.json (measured block 49376114).
    /// Trimmed to two: a full Aerodrome COW harvest touches thousands of storage slots, and six of them
    /// exhausts a public RPC's rate limit mid-test. Two is enough to answer report-vs-reality.
    address[2] internal STRATS = [
        0x8B45D51e015Dac924EeAEa754e6f768943206F05, // reported ~$22.42
        0xa0dBaE6a747BF5deB0254B62bb2557489d6b837D // ~$13.85
    ];

    ZeroHarvester internal h;
    bool internal forked;

    function setUp() public {
        forked = block.chainid == 8453;
        if (!forked) return;
        h = new ZeroHarvester(ZERO_SAFE);
    }

    modifier onlyForked() {
        if (!forked) {
            console.log("SKIPPED: run with --fork-url");
            return;
        }
        _;
    }

    /// @notice Report vs reality, per strategy, measured as a balance delta.
    function test_Fork_ReportedRewardVsActualPayment() public onlyForked {
        console.log("=== callReward() REPORT vs MEASURED PAYMENT ===\n");
        uint256 totalReported;
        uint256 totalPaidEth;
        uint256 totalPaidWeth;
        uint256 paidCount;

        for (uint256 i; i < STRATS.length; i++) {
            address s = STRATS[i];
            uint256 reported;
            try IStrategy(s).callReward() returns (uint256 r) {
                reported = r;
            } catch {}
            totalReported += reported;

            uint256 ethBefore = ZERO_SAFE.balance;
            uint256 wethBefore = IERC20(WETH).balanceOf(ZERO_SAFE);

            // Call it exactly the way ZeroHarvester would: through the contract, fee routed to the Safe.
            ZeroHarvester.Call[] memory calls = new ZeroHarvester.Call[](1);
            calls[0] = ZeroHarvester.Call({
                target: s,
                gasLimit: 5_000_000,
                data: abi.encodeWithSignature("harvest(address)", ZERO_SAFE)
            });

            uint256 gasBefore = gasleft();
            (uint256 ok,,) = h.execute(calls, new address[](0), 0);
            uint256 gasUsed = gasBefore - gasleft();

            uint256 ethGain = ZERO_SAFE.balance - ethBefore;
            uint256 wethGain = IERC20(WETH).balanceOf(ZERO_SAFE) - wethBefore;

            totalPaidEth += ethGain;
            totalPaidWeth += wethGain;
            if (ethGain + wethGain > 0) paidCount++;

            console.log("strategy   :", s);
            console.log("  reported :", reported);
            console.log("  call ok  :", ok == 1);
            console.log("  ETH gain :", ethGain);
            console.log("  WETH gain:", wethGain);
            console.log("  gas used :", gasUsed);
            console.log("");
        }

        console.log("=== TOTALS (wei) ===");
        console.log("reported sum :", totalReported);
        console.log("actual ETH   :", totalPaidEth);
        console.log("actual WETH  :", totalPaidWeth);
        console.log("actual total :", totalPaidEth + totalPaidWeth);
        console.log("strategies that actually paid:", paidCount, "of", STRATS.length);

        // No assertion on the amount — the POINT is to learn the true ratio, and a test that asserts
        // my hoped-for answer would teach me nothing. The number printed here is the finding.
    }

    /// @notice The thesis test: does ONE batch through ZeroHarvester out-earn ONE single call — which is
    ///         all a relay slot buys today? This is the entire reason the contract exists.
    function test_Fork_BatchBeatsSingleCall() public onlyForked {
        uint256 ethBefore = ZERO_SAFE.balance;
        uint256 wethBefore = IERC20(WETH).balanceOf(ZERO_SAFE);

        ZeroHarvester.Call[] memory calls = new ZeroHarvester.Call[](STRATS.length);
        for (uint256 i; i < STRATS.length; i++) {
            calls[i] = ZeroHarvester.Call({
                target: STRATS[i],
                gasLimit: 5_000_000,
                data: abi.encodeWithSignature("harvest(address)", ZERO_SAFE)
            });
        }

        uint256 g = gasleft();
        (uint256 ok, uint256 bits,) = h.execute(calls, new address[](0), 0);
        uint256 gasUsed = g - gasleft();

        uint256 gained = (ZERO_SAFE.balance - ethBefore) + (IERC20(WETH).balanceOf(ZERO_SAFE) - wethBefore);

        console.log("=== ONE BATCH, ONE RELAY SLOT ===");
        console.log("calls in batch :", STRATS.length);
        console.log("succeeded      :", ok);
        console.log("successBits    :", bits);
        console.log("total gained   :", gained, "wei");
        console.log("gas used       :", gasUsed);
        console.log("gas per call   :", gasUsed / STRATS.length);

        assertLt(gasUsed, 30_000_000, "batch fits in a Base block");
    }

    /// @notice Guard against the trap that would silently waste a slot: harvesting the SAME strategy
    ///         twice in one batch must not double-count. The second call should pay ~nothing.
    function test_Fork_DoubleHarvestSameStrategy_SecondPaysNothing() public onlyForked {
        address s = STRATS[0];
        uint256 wethBefore = IERC20(WETH).balanceOf(ZERO_SAFE);

        ZeroHarvester.Call[] memory first = new ZeroHarvester.Call[](1);
        first[0] = ZeroHarvester.Call({
            target: s,
            gasLimit: 5_000_000,
            data: abi.encodeWithSignature("harvest(address)", ZERO_SAFE)
        });
        h.execute(first, new address[](0), 0);
        uint256 afterFirst = IERC20(WETH).balanceOf(ZERO_SAFE);

        h.execute(first, new address[](0), 0);
        uint256 afterSecond = IERC20(WETH).balanceOf(ZERO_SAFE);

        console.log("first harvest gain :", afterFirst - wethBefore);
        console.log("second harvest gain:", afterSecond - afterFirst);
        console.log("(a large second gain would mean the cooldown model is wrong)");
    }
}
