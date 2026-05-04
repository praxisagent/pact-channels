// ── Chain configurations ───────────────────────────────────────

export const CHAINS = {
  arbitrum: {
    chainId: 42161,
    name: 'Arbitrum One',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    contracts: {
      PACT_TOKEN:   '0x809c2540358E2cF37050cCE41A610cb6CE66Abe1',
      PACT_ESCROW:  '0x220B97972d6028Acd70221890771E275e7734BFB',
      PACT_CHANNEL: '0x5a9D124c05B425CD90613326577E03B3eBd1F891',
    },
  },
  kite_testnet: {
    chainId: 2368,
    name: 'Kite AI Testnet',
    rpcUrl: 'https://rpc-testnet.gokite.ai/',
    contracts: {
      // Set PACT_TOKEN_ADDRESS, PACT_ESCROW_ADDRESS, PACT_CHANNEL_ADDRESS env vars after deploying
      PACT_TOKEN:   '',
      PACT_ESCROW:  '',
      PACT_CHANNEL: '',
    },
  },
};

// Default to Arbitrum One; override with CHAIN env var (e.g. CHAIN=kite_testnet)
const _chainKey = (process.env['CHAIN'] ?? 'arbitrum') as keyof typeof CHAINS;
const _chain = CHAINS[_chainKey] ?? CHAINS.arbitrum;

export const CHAIN_ID: number = process.env['CHAIN_ID']
  ? parseInt(process.env['CHAIN_ID'], 10)
  : _chain.chainId;

export const CONTRACTS = {
  PACT_TOKEN:   process.env['PACT_TOKEN_ADDRESS']   ?? _chain.contracts.PACT_TOKEN,
  PACT_ESCROW:  process.env['PACT_ESCROW_ADDRESS']  ?? _chain.contracts.PACT_ESCROW,
  PACT_CHANNEL: process.env['PACT_CHANNEL_ADDRESS'] ?? _chain.contracts.PACT_CHANNEL,
};

// ── ABI fragments for PactEscrow v2 ───────────────────────────
// Matches deployed PactEscrowV2.sol on Arbitrum One (0x220B97972d6028Acd70221890771E275e7734BFB)
export const ESCROW_ABI = [
  'function nextPactId() view returns (uint256)',
  'function getPact(uint256 pactId) view returns (tuple(address creator, address recipient, address arbitrator, uint256 amount, uint256 arbitratorFee, uint256 deadline, uint256 disputeWindow, uint256 arbitrationWindow, uint256 workSubmittedAt, uint256 disputeRaisedAt, bytes32 workHash, uint8 status))',
  'function isReleaseable(uint256 pactId) view returns (bool)',
  'function create(address recipient, address arbitrator, uint256 amount, uint256 arbitratorFee, uint256 deadline, uint256 disputeWindow, uint256 arbitrationWindow) returns (uint256)',
  'function submitWork(uint256 pactId, bytes32 workHash)',
  'function approve(uint256 pactId)',
  'function dispute(uint256 pactId)',
  'function release(uint256 pactId)',
  'function reclaim(uint256 pactId)',
] as const;

// ── ABI fragments for PactPaymentChannel ──────────────────────
// Matches deployed PactPaymentChannel.sol on Arbitrum One (0x5a9D124c05B425CD90613326577E03B3eBd1F891)
export const CHANNEL_ABI = [
  'function nextChannelId() view returns (uint256)',
  'function CHALLENGE_PERIOD() view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function UPDATE_TYPEHASH() view returns (bytes32)',
  'function getChannel(uint256 channelId) view returns (address agentA, address agentB, uint256 depositA, uint256 depositB, uint256 nonce, uint256 balanceA, uint256 balanceB, uint256 closeTime, uint8 state)',
  'function isSettleable(uint256 channelId) view returns (bool)',
  'function open(address agentB, uint256 depositA) returns (uint256)',
  'function fund(uint256 channelId, uint256 depositB)',
  'function coopClose(uint256 channelId, uint256 balanceA, uint256 balanceB, uint256 nonce, bytes sigA, bytes sigB)',
  'function initiateClose(uint256 channelId, uint256 balanceA, uint256 balanceB, uint256 nonce, bytes sigA, bytes sigB)',
  'function challenge(uint256 channelId, uint256 balanceA, uint256 balanceB, uint256 nonce, bytes sigA, bytes sigB)',
  'function settle(uint256 channelId)',
] as const;

// ── ABI fragments for ERC-20 (PACT token) ─────────────────────
export const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
] as const;

// ── Status / state label maps ──────────────────────────────────
// Matches PactEscrowV2.sol Status enum exactly
export const PACT_STATUS: Record<number, string> = {
  0: 'Active',
  1: 'WorkSubmitted',
  2: 'Disputed',
  3: 'Complete',
  4: 'Refunded',
};

// Matches PactPaymentChannel.sol ChannelState enum exactly
export const CHANNEL_STATE: Record<number, string> = {
  0: 'Open',
  1: 'Closing',
  2: 'Closed',
};
