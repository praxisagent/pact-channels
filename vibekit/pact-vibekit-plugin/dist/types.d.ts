export interface UnsignedTx {
    to: string;
    data: string;
    value: string;
    chainId: number;
    description: string;
}
export interface TxPlanResponse {
    transactions: UnsignedTx[];
    note?: string;
}
export interface EscrowState {
    pactId: string;
    creator: string;
    recipient: string;
    arbitrator: string;
    amount: string;
    amountPact: string;
    arbitratorFee: string;
    deadline: number;
    deadlineISO: string;
    disputeWindow: number;
    arbitrationWindow: number;
    workSubmittedAt: number;
    disputeRaisedAt: number;
    workHash: string;
    status: string;
    statusCode: number;
    isReleaseable: boolean;
}
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
    state: string;
    stateCode: number;
    isSettleable: boolean;
}
export interface PaymentUpdate {
    channelId: string;
    nonce: number;
    balanceA: string;
    balanceB: string;
    signerAddress: string;
    signature: string;
    typedDataHash: string;
}
//# sourceMappingURL=types.d.ts.map