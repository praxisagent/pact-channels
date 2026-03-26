// PACT Protocol contract addresses — Arbitrum One (chainId 42161)
export const PACT_TOKEN = '0x809c2540358E2cF37050cCE41A610cb6CE66Abe1';
export const PACT_ESCROW_V2 = '0x220B97972d6028Acd70221890771E275e7734BFB';
export const PACT_PAYMENT_CHANNEL = '0x5a9D124c05B425CD90613326577E03B3eBd1F891';
export const CHAIN_ID = 42161;
export const CHAIN_NAME = 'Arbitrum One';
export const RPC_URL_DEFAULT = 'https://arb1.arbitrum.io/rpc';
// Escrow defaults (in seconds)
export const DEFAULT_DISPUTE_WINDOW = 86400; // 24 hours
export const DEFAULT_ARBITRATION_WINDOW = 259200; // 72 hours
// ERC-20 minimal ABI (approve + allowance)
export const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
];
export const ESCROW_ABI = [
    'function create(address recipient, address arbitrator, uint256 amount, uint256 arbitratorFee, uint256 deadline, uint256 disputeWindow, uint256 arbitrationWindow) returns (uint256 pactId)',
    'function submitWork(uint256 pactId, bytes32 workHash)',
    'function approve(uint256 pactId)',
    'function dispute(uint256 pactId)',
    'function reclaim(uint256 pactId)',
    'function release(uint256 pactId)',
    'function getPact(uint256 pactId) view returns (tuple(address creator, address recipient, address arbitrator, uint256 amount, uint256 arbitratorFee, uint256 deadline, uint256 disputeWindow, uint256 arbitrationWindow, uint256 workSubmittedAt, uint256 disputeRaisedAt, bytes32 workHash, uint8 status))',
    'function nextPactId() view returns (uint256)',
    'function isReleaseable(uint256 pactId) view returns (bool)',
];
export const CHANNEL_ABI = [
    'function open(address agentB, uint256 depositA) returns (uint256 channelId)',
    'function fund(uint256 channelId, uint256 depositB)',
    'function coopClose(uint256 channelId, uint256 balanceA, uint256 balanceB, uint256 nonce, bytes sigA, bytes sigB)',
    'function initiateClose(uint256 channelId, uint256 balanceA, uint256 balanceB, uint256 nonce, bytes sigA, bytes sigB)',
    'function challenge(uint256 channelId, uint256 balanceA, uint256 balanceB, uint256 nonce, bytes sigA, bytes sigB)',
    'function settle(uint256 channelId)',
    'function getChannel(uint256 channelId) view returns (address agentA, address agentB, uint256 depositA, uint256 depositB, uint256 nonce, uint256 balanceA, uint256 balanceB, uint256 closeTime, uint8 state)',
    'function nextChannelId() view returns (uint256)',
    'function isSettleable(uint256 channelId) view returns (bool)',
    'function DOMAIN_SEPARATOR() view returns (bytes32)',
    'function UPDATE_TYPEHASH() view returns (bytes32)',
];
// PactEscrowV2 status enum
export var PactStatus;
(function (PactStatus) {
    PactStatus[PactStatus["Active"] = 0] = "Active";
    PactStatus[PactStatus["WorkSubmitted"] = 1] = "WorkSubmitted";
    PactStatus[PactStatus["Approved"] = 2] = "Approved";
    PactStatus[PactStatus["Disputed"] = 3] = "Disputed";
    PactStatus[PactStatus["Released"] = 4] = "Released";
    PactStatus[PactStatus["Refunded"] = 5] = "Refunded";
    PactStatus[PactStatus["ArbitrationRuled"] = 6] = "ArbitrationRuled";
})(PactStatus || (PactStatus = {}));
// PactPaymentChannel state enum
export var ChannelState;
(function (ChannelState) {
    ChannelState[ChannelState["Open"] = 0] = "Open";
    ChannelState[ChannelState["Closing"] = 1] = "Closing";
    ChannelState[ChannelState["Closed"] = 2] = "Closed";
})(ChannelState || (ChannelState = {}));
//# sourceMappingURL=constants.js.map