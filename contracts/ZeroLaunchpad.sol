// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal interface to Zora's live coin factory on Base (verified on-chain 2026-08-03:
///         ZoraFactory 0x7777…baF3, EIP-1967 proxy -> ZoraFactoryImpl, coinV4Impl matches the
///         ContentCoin implementation that real content coins are cloned from).
interface IZoraFactory {
    function deploy(
        address payoutRecipient,
        address[] memory owners,
        string memory uri,
        string memory name,
        string memory symbol,
        bytes memory poolConfig,
        address platformReferrer,
        address postDeployHook,
        bytes memory postDeployHookData,
        bytes32 coinSalt
    ) external payable returns (address, bytes memory);
}

/**
 * @title ZeroLaunchpad
 * @notice A free, permissionless launcher for Zora content coins.
 *
 * WHY THIS EXISTS — measured, not assumed (see knowledge/zora-coin-research.md):
 * The ZoraV4CoinHook emits CoinMarketRewardsV4 on every swap, splitting fees five ways. Measured
 * across 175 real events on Base: creator 62.5%, platformReferrer 25%, tradeReferrer 5%,
 * protocol 6.25%, doppler 1.25%. Ecosystem-wide flow to the platformReferrer role was measured at
 * ~$244/day. Critically, `platformReferrer` is fixed AT COIN CREATION and is permanent for the life
 * of that coin — so a launcher that names itself earns on every future swap of every coin launched
 * through it, forever, with no further action and no audience required.
 *
 * WHAT THE CALLER GETS: exactly the coin they would have gotten anyway. They remain the sole owner
 * and the payout recipient; the full 62.5% creator share is theirs. This contract holds nothing,
 * custodies nothing, takes no cut of their supply, and has no owner, no admin and no upgrade path.
 *
 * WHAT ZERO GETS: the 25% platform-referral share of trading fees on coins launched here.
 * That is a fee Zora pays the referring platform out of the protocol's own economics — it does NOT
 * come out of the creator's share, and it costs the caller nothing beyond normal gas.
 *
 * This is disclosed in full because it is the whole point: it is a fair trade, not a hidden rake.
 */
contract ZeroLaunchpad {
    IZoraFactory public constant FACTORY =
        IZoraFactory(0x777777751622c0d3258f214F9DF38E35BF45baF3);

    /// @notice ZERO's wallet — the autonomous agent that built and runs this. Immutable by design:
    ///         there is no setter, so the referral destination can never be changed by anyone.
    address public constant ZERO = 0x50624F7790732f9767180871D03A304756200dB9;

    event Launched(address indexed coin, address indexed creator, string symbol);

    /**
     * @notice Launch a Zora content coin. You are the owner and payout recipient.
     * @param uri        Metadata URI for the coin (https or ipfs both work — measured: Zora's
     *                   indexer accepts a plain https tokenURI, no IPFS pinning required).
     * @param name       Coin name.
     * @param symbol     Coin symbol.
     * @param poolConfig Zora pool configuration bytes (copy the encoding from any live deploy;
     *                   this contract passes it through untouched and never inspects it).
     * @param salt       CREATE2 salt, so the coin address is deterministic for the caller.
     * @return coin      The deployed coin address.
     */
    function launch(
        string calldata uri,
        string calldata name,
        string calldata symbol,
        bytes calldata poolConfig,
        bytes32 salt
    ) external payable returns (address coin) {
        address[] memory owners = new address[](1);
        owners[0] = msg.sender;

        (coin, ) = FACTORY.deploy{value: msg.value}(
            msg.sender,      // payoutRecipient — the caller keeps the 62.5% creator share
            owners,          // owners — the caller alone
            uri,
            name,
            symbol,
            poolConfig,
            ZERO,            // platformReferrer — the 25% share, permanent, paid by the protocol
            address(0),      // no post-deploy hook
            "",
            salt
        );

        emit Launched(coin, msg.sender, symbol);
    }

    /// @notice This contract is not payable outside launch(); it must never accumulate a balance,
    ///         because a stuck balance with no withdrawal path is value destroyed. Any ETH sent
    ///         with launch() is forwarded to the factory in the same call.
    receive() external payable {
        revert("send ETH via launch() only");
    }
}
