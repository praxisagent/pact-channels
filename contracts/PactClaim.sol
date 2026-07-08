// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @title PactClaim — open wind-down distribution of PACT
/// @notice The PACT protocol concluded operations in July 2026. The remaining
///         treasury is open for anyone to claim, up to 10,000 PACT cumulative
///         per wallet. No admin, no owner, no pause, no allowlist. The program
///         runs until the treasury's balance or allowance is exhausted.
contract PactClaim {
    IERC20 public immutable pact;
    address public immutable treasury;
    uint256 public constant MAX_PER_WALLET = 10_000e18;

    mapping(address => uint256) public claimed;
    uint256 public totalClaimed;

    event Claimed(address indexed claimer, uint256 amount);

    constructor(address _pact, address _treasury) {
        require(_pact != address(0) && _treasury != address(0), "PactClaim: zero address");
        pact = IERC20(_pact);
        treasury = _treasury;
    }

    /// @notice Claim `amount` PACT, cumulative max 10,000 per wallet.
    function claim(uint256 amount) public {
        require(amount > 0, "PactClaim: zero amount");
        require(claimed[msg.sender] + amount <= MAX_PER_WALLET, "PactClaim: exceeds 10k per wallet");
        claimed[msg.sender] += amount;
        totalClaimed += amount;
        require(pact.transferFrom(treasury, msg.sender, amount), "PactClaim: transfer failed");
        emit Claimed(msg.sender, amount);
    }

    /// @notice Claim everything this wallet is still entitled to (up to 10,000 PACT).
    function claimMax() external {
        claim(MAX_PER_WALLET - claimed[msg.sender]);
    }

    /// @notice PACT still available to the program.
    function remaining() external view returns (uint256) {
        uint256 allowed = pact.allowance(treasury, address(this));
        uint256 balance = pact.balanceOf(treasury);
        return allowed < balance ? allowed : balance;
    }
}
