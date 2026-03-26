import type { TxPlanResponse, EscrowState } from './types.js';
/**
 * Build transactions to create a PACT escrow.
 * Returns two transactions:
 *   1. ERC-20 approve (PACT token → escrow contract)
 *   2. Escrow create
 *
 * The caller must sign and submit both in order.
 */
export declare function buildCreateEscrow(params: {
    recipient: string;
    amountPact: string;
    arbitrator?: string;
    arbitratorFeePact?: string;
    deadlineUnix: number;
    disputeWindowSec?: number;
    arbitrationWindowSec?: number;
}): TxPlanResponse;
/**
 * Build transaction to submit work hash to an escrow.
 * workContent: the raw content/string whose SHA-256 you want to submit.
 * Returns the bytes32 hash and the unsigned transaction.
 */
export declare function buildSubmitWork(params: {
    pactId: string;
    workContent: string;
}): TxPlanResponse & {
    workHash: string;
};
/**
 * Build transaction to approve (release payment) for a completed escrow.
 * Must be called by the creator.
 */
export declare function buildApprovePayment(params: {
    pactId: string;
}): TxPlanResponse;
/**
 * Build transaction to reclaim funds from an expired escrow (no work submitted).
 * Must be called by the creator after deadline.
 */
export declare function buildReclaimEscrow(params: {
    pactId: string;
}): TxPlanResponse;
/**
 * Read escrow state from chain. Requires provider (RPC_URL env var).
 */
export declare function getEscrowStatus(params: {
    pactId: string;
    rpcUrl: string;
}): Promise<EscrowState>;
//# sourceMappingURL=escrow.d.ts.map