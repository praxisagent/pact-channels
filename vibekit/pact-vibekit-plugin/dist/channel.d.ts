import type { TxPlanResponse } from './types.js';
import type { ChannelState } from './types.js';
/**
 * Build transactions to open a PACT payment channel.
 * Returns two transactions:
 *   1. ERC-20 approve (PACT token → channel contract)
 *   2. channel.open(agentB, depositA)
 */
export declare function buildOpenChannel(params: {
    agentB: string;
    depositPact: string;
}): TxPlanResponse;
/**
 * Compute the EIP-712 typed data hash for a payment update.
 * This is what both agents sign to create a valid off-chain payment.
 *
 * Does NOT require a private key — only needs the domain separator.
 * Used by agents to construct the data to sign.
 */
export declare function buildPaymentUpdateHash(params: {
    channelId: string;
    nonce: number;
    balanceA: string;
    balanceB: string;
    inPact?: boolean;
}): {
    typedDataHash: string;
    domain: object;
    message: object;
};
/**
 * Build transactions for cooperative channel close.
 * Requires both parties' signatures on the final state.
 */
export declare function buildCoopClose(params: {
    channelId: string;
    balanceA: string;
    balanceB: string;
    nonce: number;
    sigA: string;
    sigB: string;
    inPact?: boolean;
}): TxPlanResponse;
/**
 * Read payment channel state from chain.
 */
export declare function getChannelStatus(params: {
    channelId: string;
    rpcUrl: string;
}): Promise<ChannelState>;
//# sourceMappingURL=channel.d.ts.map