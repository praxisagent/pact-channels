// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PactPaymentChannel — Bidirectional PACT payment channels for agent micropayments
/// @notice Two agents open a channel, exchange signed payment updates off-chain, settle on-chain.
/// @dev Two on-chain txs (open + close) enable unlimited off-chain payments.
///      Uses EIP-712 typed signatures for payment updates.
///      Challenge period protects against stale state submission.
///      No admin keys, no upgradability.

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

contract PactPaymentChannel {

    // ──────────────────── Constants ──────────────────────────

    /// @notice Challenge period: 1 hour. Either party can dispute with a newer state.
    uint256 public constant CHALLENGE_PERIOD = 1 hours;

    /// @notice EIP-712 domain separator, computed at construction
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @notice EIP-712 typehash for payment updates
    bytes32 public constant UPDATE_TYPEHASH =
        keccak256("PaymentUpdate(uint256 channelId,uint256 nonce,uint256 balanceA,uint256 balanceB)");

    // ──────────────────── Types ──────────────────────────────

    enum ChannelState { Open, Closing, Closed }

    struct Channel {
        address agentA;        // Channel opener
        address agentB;        // Counterparty
        uint256 depositA;      // PACT deposited by A
        uint256 depositB;      // PACT deposited by B
        uint256 totalDeposit;  // depositA + depositB (immutable after both fund)
        uint256 nonce;         // Highest nonce submitted during close/challenge
        uint256 balanceA;      // A's balance in latest submitted state
        uint256 balanceB;      // B's balance in latest submitted state
        uint256 closeTime;     // Timestamp when challenge period ends
        ChannelState state;
    }

    // ──────────────────── Storage ────────────────────────────

    IERC20 public immutable pactToken;
    uint256 public nextChannelId;
    mapping(uint256 => Channel) public channels;

    // ──────────────────── Events ─────────────────────────────

    event ChannelOpened(uint256 indexed channelId, address indexed agentA, address indexed agentB, uint256 depositA);
    event ChannelFunded(uint256 indexed channelId, address indexed agentB, uint256 depositB);
    event ChannelCloseInitiated(uint256 indexed channelId, uint256 nonce, uint256 balanceA, uint256 balanceB, uint256 closeTime);
    event ChannelChallenged(uint256 indexed channelId, uint256 nonce, uint256 balanceA, uint256 balanceB);
    event ChannelSettled(uint256 indexed channelId, uint256 balanceA, uint256 balanceB);
    event ChannelCoopClosed(uint256 indexed channelId, uint256 balanceA, uint256 balanceB);

    // ──────────────────── Constructor ────────────────────────

    constructor(address _pactToken) {
        require(_pactToken != address(0), "Channel: zero token");
        pactToken = IERC20(_pactToken);

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("PactPaymentChannel")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ──────────────────── Open ───────────────────────────────

    /// @notice Open a channel with agentB. Caller deposits PACT upfront.
    /// @param agentB     The counterparty agent
    /// @param depositA   PACT tokens to deposit (caller must have approved this contract)
    /// @return channelId The new channel's ID
    function open(address agentB, uint256 depositA) external returns (uint256 channelId) {
        require(agentB != address(0) && agentB != msg.sender, "Channel: invalid agentB");
        require(depositA > 0, "Channel: zero deposit");

        channelId = nextChannelId++;
        channels[channelId] = Channel({
            agentA: msg.sender,
            agentB: agentB,
            depositA: depositA,
            depositB: 0,
            totalDeposit: depositA,
            nonce: 0,
            balanceA: depositA,
            balanceB: 0,
            closeTime: 0,
            state: ChannelState.Open
        });

        require(pactToken.transferFrom(msg.sender, address(this), depositA), "Channel: deposit failed");
        emit ChannelOpened(channelId, msg.sender, agentB, depositA);
    }

    /// @notice AgentB funds their side of the channel (optional — channels work with one-sided deposits too)
    /// @param channelId The channel to fund
    /// @param depositB  PACT tokens to deposit
    function fund(uint256 channelId, uint256 depositB) external {
        Channel storage ch = channels[channelId];
        require(ch.state == ChannelState.Open, "Channel: not open");
        require(msg.sender == ch.agentB, "Channel: not agentB");
        require(ch.depositB == 0, "Channel: already funded");
        require(depositB > 0, "Channel: zero deposit");

        ch.depositB = depositB;
        ch.totalDeposit += depositB;
        ch.balanceB = depositB;

        require(pactToken.transferFrom(msg.sender, address(this), depositB), "Channel: deposit failed");
        emit ChannelFunded(channelId, msg.sender, depositB);
    }

    // ──────────────────── Cooperative Close ─────────────────

    /// @notice Instantly close a channel if both parties sign the final state. No challenge period.
    /// @param channelId The channel to close
    /// @param balanceA  Final PACT balance for agentA
    /// @param balanceB  Final PACT balance for agentB
    /// @param nonce     The nonce of the final state
    /// @param sigA      agentA's EIP-712 signature
    /// @param sigB      agentB's EIP-712 signature
    function coopClose(
        uint256 channelId,
        uint256 balanceA,
        uint256 balanceB,
        uint256 nonce,
        bytes calldata sigA,
        bytes calldata sigB
    ) external {
        Channel storage ch = channels[channelId];
        require(ch.state == ChannelState.Open, "Channel: not open");
        require(balanceA + balanceB == ch.totalDeposit, "Channel: balance mismatch");

        // Verify both signatures
        bytes32 digest = _digest(channelId, nonce, balanceA, balanceB);
        require(_recover(digest, sigA) == ch.agentA, "Channel: invalid sigA");
        require(_recover(digest, sigB) == ch.agentB, "Channel: invalid sigB");

        ch.state = ChannelState.Closed;
        ch.balanceA = balanceA;
        ch.balanceB = balanceB;
        ch.nonce = nonce;

        // Settle
        if (balanceA > 0) require(pactToken.transfer(ch.agentA, balanceA), "Channel: transfer A failed");
        if (balanceB > 0) require(pactToken.transfer(ch.agentB, balanceB), "Channel: transfer B failed");

        emit ChannelCoopClosed(channelId, balanceA, balanceB);
    }

    // ──────────────────── Unilateral Close ───────────────────

    /// @notice Initiate a unilateral close by submitting the latest signed state.
    ///         Starts the challenge period. Either party can challenge with a higher-nonce state.
    /// @param channelId The channel to close
    /// @param balanceA  A's balance in this state
    /// @param balanceB  B's balance in this state
    /// @param nonce     The nonce of this state
    /// @param sigA      agentA's signature on this state
    /// @param sigB      agentB's signature on this state
    function initiateClose(
        uint256 channelId,
        uint256 balanceA,
        uint256 balanceB,
        uint256 nonce,
        bytes calldata sigA,
        bytes calldata sigB
    ) external {
        Channel storage ch = channels[channelId];
        require(ch.state == ChannelState.Open, "Channel: not open");
        require(msg.sender == ch.agentA || msg.sender == ch.agentB, "Channel: not participant");
        require(balanceA + balanceB == ch.totalDeposit, "Channel: balance mismatch");

        bytes32 digest = _digest(channelId, nonce, balanceA, balanceB);
        require(_recover(digest, sigA) == ch.agentA, "Channel: invalid sigA");
        require(_recover(digest, sigB) == ch.agentB, "Channel: invalid sigB");

        ch.state = ChannelState.Closing;
        ch.nonce = nonce;
        ch.balanceA = balanceA;
        ch.balanceB = balanceB;
        ch.closeTime = block.timestamp + CHALLENGE_PERIOD;

        emit ChannelCloseInitiated(channelId, nonce, balanceA, balanceB, ch.closeTime);
    }

    /// @notice Challenge a pending close with a higher-nonce state. Resets the challenge timer.
    /// @param channelId The channel being closed
    /// @param balanceA  A's balance in the newer state
    /// @param balanceB  B's balance in the newer state
    /// @param nonce     Must be higher than the current nonce
    /// @param sigA      agentA's signature
    /// @param sigB      agentB's signature
    function challenge(
        uint256 channelId,
        uint256 balanceA,
        uint256 balanceB,
        uint256 nonce,
        bytes calldata sigA,
        bytes calldata sigB
    ) external {
        Channel storage ch = channels[channelId];
        require(ch.state == ChannelState.Closing, "Channel: not closing");
        require(block.timestamp < ch.closeTime, "Channel: challenge period over");
        require(nonce > ch.nonce, "Channel: nonce not higher");
        require(balanceA + balanceB == ch.totalDeposit, "Channel: balance mismatch");

        bytes32 digest = _digest(channelId, nonce, balanceA, balanceB);
        require(_recover(digest, sigA) == ch.agentA, "Channel: invalid sigA");
        require(_recover(digest, sigB) == ch.agentB, "Channel: invalid sigB");

        ch.nonce = nonce;
        ch.balanceA = balanceA;
        ch.balanceB = balanceB;
        ch.closeTime = block.timestamp + CHALLENGE_PERIOD;

        emit ChannelChallenged(channelId, nonce, balanceA, balanceB);
    }

    /// @notice Settle a channel after the challenge period expires. Anyone can call.
    /// @param channelId The channel to settle
    function settle(uint256 channelId) external {
        Channel storage ch = channels[channelId];
        require(ch.state == ChannelState.Closing, "Channel: not closing");
        require(block.timestamp >= ch.closeTime, "Channel: challenge period active");

        ch.state = ChannelState.Closed;

        if (ch.balanceA > 0) require(pactToken.transfer(ch.agentA, ch.balanceA), "Channel: transfer A failed");
        if (ch.balanceB > 0) require(pactToken.transfer(ch.agentB, ch.balanceB), "Channel: transfer B failed");

        emit ChannelSettled(channelId, ch.balanceA, ch.balanceB);
    }

    // ──────────────────── View ───────────────────────────────

    /// @notice Check if a channel's challenge period has expired
    function isSettleable(uint256 channelId) external view returns (bool) {
        Channel storage ch = channels[channelId];
        return ch.state == ChannelState.Closing && block.timestamp >= ch.closeTime;
    }

    /// @notice Get full channel info
    function getChannel(uint256 channelId) external view returns (
        address agentA, address agentB,
        uint256 depositA, uint256 depositB,
        uint256 nonce, uint256 balanceA, uint256 balanceB,
        uint256 closeTime, ChannelState state
    ) {
        Channel storage ch = channels[channelId];
        return (ch.agentA, ch.agentB, ch.depositA, ch.depositB,
                ch.nonce, ch.balanceA, ch.balanceB, ch.closeTime, ch.state);
    }

    // ──────────────────── Internal ───────────────────────────

    function _digest(uint256 channelId, uint256 nonce, uint256 balanceA, uint256 balanceB)
        internal view returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(UPDATE_TYPEHASH, channelId, nonce, balanceA, balanceB))
            )
        );
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "Channel: invalid sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "Channel: invalid signature");
        return recovered;
    }
}
