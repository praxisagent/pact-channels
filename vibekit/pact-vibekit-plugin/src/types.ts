// Unsigned transaction ready for agent wallet to sign and submit
export interface UnsignedTx {
  to: string;
  data: string;
  value: string; // hex wei, usually "0x0"
  chainId: number;
  description: string; // human-readable label
}

// Response wrapping one or more unsigned transactions
export interface TxPlanResponse {
  transactions: UnsignedTx[];
  note?: string;
}

// Escrow state returned by get_escrow_status
export interface EscrowState {
  pactId: string;
  creator: string;
  recipient: string;
  arbitrator: string;
  amount: string;         // PACT wei string
  amountPact: string;     // human-readable (18 decimals)
  arbitratorFee: string;
  deadline: number;       // unix timestamp
  deadlineISO: string;
  disputeWindow: number;
  arbitrationWindow: number;
  workSubmittedAt: number;
  disputeRaisedAt: number;
  workHash: string;       // bytes32 hex
  status: string;         // enum name
  statusCode: number;
  isReleaseable: boolean;
}

// Payment channel state
export interface ChannelState {
  channelId: string;
  agentA: string;
  agentB: string;
  depositA: string;
  depositB: string;
  nonce: string;
  balanceA: string;
  balanceB: string;
  closeTime: number;
  state: string;          // enum name
  stateCode: number;
  isSettleable: boolean;
}

// Off-chain payment update (signed, no on-chain tx needed)
export interface PaymentUpdate {
  channelId: string;
  nonce: number;
  balanceA: string;  // wei
  balanceB: string;  // wei
  signerAddress: string;
  signature: string; // EIP-712 signature hex
  typedDataHash: string;
}
