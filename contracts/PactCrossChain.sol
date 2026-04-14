// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PactCrossChain — Cross-chain hash-lock adapter for PACT tokens
/// @notice Trustless settlement adapter between EVM agents and systems using SHA-256
///         (Stacks/Clarity, Bitcoin, etc.). A creator locks PACT and stores both
///         keccak256(preimage) and sha256(preimage). When the preimage is revealed,
///         the contract verifies both hashes and releases PACT to the beneficiary.
///
/// PRIMARY USE CASE: Stacks (whale-pact) <-> Arbitrum (PactEscrow) cross-chain settlement
///
///   Protocol flow:
///   1. Creator generates random preimage (>= 32 bytes recommended)
///   2. Creator creates whale-pact-v1 job (HASH type) with sha256(preimage) on Stacks
///   3. Creator creates PactCrossChain lock with keccak256(preimage) + sha256(preimage),
///      same or matched deadline, beneficiary = agent's Arbitrum address
///   4. Agent completes work, reveals preimage on Stacks -> whale-pact releases STX
///   5. Keeper relays preimage to Arbitrum: release(lockId, preimage)
///      -> PactCrossChain verifies keccak256 + sha256, releases PACT to beneficiary
///   Result: one preimage settles both chains simultaneously. No bridge. No oracle.
///
/// SECURITY PROPERTIES:
///   - Permissionless release: anyone with the preimage can trigger it.
///     Front-running is harmless — tokens ALWAYS go to the fixed beneficiary.
///   - Both keccak256 and sha256 are verified on release (SHA-256 precompile, address 0x02).
///     This ensures the on-chain hashes correspond to the same preimage, preventing a creator
///     from storing mismatched hashes that would strand the beneficiary.
///   - Deadline-gated reclaim: creator can only reclaim after deadline if not yet released.
///   - Cannot reclaim after release (status is Released).
///   - No admin functions. No upgradability. No fee. Code is the arbiter.

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

contract PactCrossChain {

    // ──────────────────── Types ─────────────────────────────────

    enum Status { Active, Released, Reclaimed }

    /// @notice A hash-locked PACT position
    struct Lock {
        address creator;         // Agent who locked the tokens (can reclaim after deadline)
        address beneficiary;     // Agent who receives PACT on preimage reveal
        uint256 amount;          // PACT tokens locked
        uint256 deadline;        // Unix timestamp: preimage must be revealed before this
        bytes32 keccak256Hash;   // keccak256(preimage) — verified natively on EVM
        bytes32 sha256Hash;      // sha256(preimage) — verified via SHA-256 precompile (0x02)
        Status  status;
    }

    // ──────────────────── Storage ───────────────────────────────

    IERC20 public immutable pactToken;

    uint256 public nextLockId;

    mapping(uint256 => Lock) public locks;

    // ──────────────────── Events ────────────────────────────────

    event LockCreated(
        uint256 indexed lockId,
        address indexed creator,
        address indexed beneficiary,
        uint256 amount,
        uint256 deadline,
        bytes32 keccak256Hash,
        bytes32 sha256Hash
    );

    /// @notice Emits the preimage for keeper observability and cross-chain indexing.
    ///         The preimage is already public (calldata) once the TX is submitted.
    event LockReleased(
        uint256 indexed lockId,
        address indexed beneficiary,
        uint256 amount,
        bytes   preimage
    );

    event LockReclaimed(
        uint256 indexed lockId,
        address indexed creator,
        uint256 amount
    );

    // ──────────────────── Constructor ───────────────────────────

    /// @param _pactToken Address of the deployed PACT ERC-20 contract
    constructor(address _pactToken) {
        require(_pactToken != address(0), "CrossChain: zero token address");
        pactToken = IERC20(_pactToken);
    }

    // ──────────────────── Create ────────────────────────────────

    /// @notice Lock PACT tokens against a dual hash commitment.
    ///         Caller must have approved this contract for `amount` PACT before calling.
    ///
    /// @param beneficiary    Address that receives PACT when the preimage is revealed.
    ///                       For Stacks -> EVM flows, this is the agent's Arbitrum address.
    /// @param amount         PACT tokens to lock (transferred from caller)
    /// @param deadline       Unix timestamp — preimage must be revealed at or before this
    /// @param keccak256Hash  keccak256(preimage), computed off-chain by the creator
    /// @param sha256Hash     sha256(preimage), computed off-chain (matches Stacks work-hash)
    /// @return lockId        The ID of the newly created lock
    function create(
        address beneficiary,
        uint256 amount,
        uint256 deadline,
        bytes32 keccak256Hash,
        bytes32 sha256Hash
    ) external returns (uint256 lockId) {
        require(beneficiary != address(0), "CrossChain: zero beneficiary");
        require(amount > 0, "CrossChain: zero amount");
        require(deadline > block.timestamp, "CrossChain: deadline in past");
        require(keccak256Hash != bytes32(0), "CrossChain: zero keccak256Hash");
        require(sha256Hash != bytes32(0), "CrossChain: zero sha256Hash");

        lockId = nextLockId++;

        locks[lockId] = Lock({
            creator:       msg.sender,
            beneficiary:   beneficiary,
            amount:        amount,
            deadline:      deadline,
            keccak256Hash: keccak256Hash,
            sha256Hash:    sha256Hash,
            status:        Status.Active
        });

        // Checks-effects-interactions: state written before external call
        require(
            pactToken.transferFrom(msg.sender, address(this), amount),
            "CrossChain: transfer failed"
        );

        emit LockCreated(
            lockId, msg.sender, beneficiary, amount, deadline, keccak256Hash, sha256Hash
        );
    }

    // ──────────────────── Release ───────────────────────────────

    /// @notice Reveal the preimage and release PACT to the beneficiary.
    ///         Callable by anyone — designed for keeper relay networks.
    ///         Front-running is harmless: tokens always go to the fixed `beneficiary`.
    ///         Verifies both keccak256 and sha256 to ensure hash consistency.
    ///
    /// @param lockId   The lock to release
    /// @param preimage The secret preimage bytes (keccak256 and sha256 must match stored hashes)
    function release(uint256 lockId, bytes calldata preimage) external {
        Lock storage l = locks[lockId];
        require(l.status == Status.Active, "CrossChain: not active");
        require(block.timestamp <= l.deadline, "CrossChain: deadline passed");
        require(preimage.length > 0, "CrossChain: empty preimage");
        require(keccak256(preimage) == l.keccak256Hash, "CrossChain: keccak256 mismatch");
        require(sha256(preimage) == l.sha256Hash, "CrossChain: sha256 mismatch");

        address beneficiary = l.beneficiary;
        uint256 amount = l.amount;

        // Checks-effects-interactions: state update before token transfer
        l.status = Status.Released;

        require(pactToken.transfer(beneficiary, amount), "CrossChain: release failed");

        emit LockReleased(lockId, beneficiary, amount, preimage);
    }

    // ──────────────────── Reclaim ───────────────────────────────

    /// @notice Creator reclaims tokens after deadline passes without preimage reveal.
    ///         Only callable from Active state — if already Released, reclaim is impossible.
    ///
    /// @param lockId The lock to reclaim
    function reclaim(uint256 lockId) external {
        Lock storage l = locks[lockId];
        require(l.status == Status.Active, "CrossChain: not active");
        require(msg.sender == l.creator, "CrossChain: not creator");
        require(block.timestamp > l.deadline, "CrossChain: deadline not passed");

        address creator = l.creator;
        uint256 amount = l.amount;

        l.status = Status.Reclaimed;

        require(pactToken.transfer(creator, amount), "CrossChain: reclaim failed");

        emit LockReclaimed(lockId, creator, amount);
    }

    // ──────────────────── View ───────────────────────────────────

    /// @notice Returns full lock details
    function getLock(uint256 lockId) external view returns (Lock memory) {
        return locks[lockId];
    }

    /// @notice Returns true if the lock can be reclaimed (deadline passed, still active)
    function isReclaimable(uint256 lockId) external view returns (bool) {
        Lock storage l = locks[lockId];
        return l.status == Status.Active && block.timestamp > l.deadline;
    }

    /// @notice Off-chain helper: verify preimage matches both stored hashes
    function verifyPreimage(
        uint256 lockId,
        bytes calldata preimage
    ) external view returns (bool) {
        Lock storage l = locks[lockId];
        return keccak256(preimage) == l.keccak256Hash &&
               sha256(preimage) == l.sha256Hash;
    }
}
