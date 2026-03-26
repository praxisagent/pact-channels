import { ethers } from 'ethers';
import { PACT_TOKEN, PACT_ESCROW_V2, CHAIN_ID, ERC20_ABI, ESCROW_ABI, DEFAULT_DISPUTE_WINDOW, DEFAULT_ARBITRATION_WINDOW, } from './constants.js';
const escrowInterface = new ethers.utils.Interface(ESCROW_ABI);
const erc20Interface = new ethers.utils.Interface(ERC20_ABI);
/**
 * Build transactions to create a PACT escrow.
 * Returns two transactions:
 *   1. ERC-20 approve (PACT token → escrow contract)
 *   2. Escrow create
 *
 * The caller must sign and submit both in order.
 */
export function buildCreateEscrow(params) {
    const amount = ethers.utils.parseUnits(params.amountPact, 18);
    const arbitratorFee = ethers.utils.parseUnits(params.arbitratorFeePact ?? '0', 18);
    const arbitrator = params.arbitrator ?? ethers.constants.AddressZero;
    const disputeWindow = params.disputeWindowSec ?? DEFAULT_DISPUTE_WINDOW;
    const arbitrationWindow = params.arbitrationWindowSec ?? DEFAULT_ARBITRATION_WINDOW;
    const approveTx = {
        to: PACT_TOKEN,
        data: erc20Interface.encodeFunctionData('approve', [PACT_ESCROW_V2, amount]),
        value: '0x0',
        chainId: CHAIN_ID,
        description: `Approve ${params.amountPact} PACT to PactEscrow v2`,
    };
    const createTx = {
        to: PACT_ESCROW_V2,
        data: escrowInterface.encodeFunctionData('create', [
            params.recipient,
            arbitrator,
            amount,
            arbitratorFee,
            params.deadlineUnix,
            disputeWindow,
            arbitrationWindow,
        ]),
        value: '0x0',
        chainId: CHAIN_ID,
        description: `Create escrow: ${params.amountPact} PACT → ${params.recipient}, deadline ${new Date(params.deadlineUnix * 1000).toISOString()}`,
    };
    return {
        transactions: [approveTx, createTx],
        note: 'Submit both transactions in order. The pactId is emitted in the PactCreated event from tx 2.',
    };
}
/**
 * Build transaction to submit work hash to an escrow.
 * workContent: the raw content/string whose SHA-256 you want to submit.
 * Returns the bytes32 hash and the unsigned transaction.
 */
export function buildSubmitWork(params) {
    const workHash = ethers.utils.sha256(ethers.utils.toUtf8Bytes(params.workContent));
    const tx = {
        to: PACT_ESCROW_V2,
        data: escrowInterface.encodeFunctionData('submitWork', [
            ethers.BigNumber.from(params.pactId),
            workHash,
        ]),
        value: '0x0',
        chainId: CHAIN_ID,
        description: `Submit work hash for pact #${params.pactId}: ${workHash}`,
    };
    return {
        transactions: [tx],
        workHash,
        note: `SHA-256 of your work content. Keep the original content to prove work later.`,
    };
}
/**
 * Build transaction to approve (release payment) for a completed escrow.
 * Must be called by the creator.
 */
export function buildApprovePayment(params) {
    const tx = {
        to: PACT_ESCROW_V2,
        data: escrowInterface.encodeFunctionData('approve', [
            ethers.BigNumber.from(params.pactId),
        ]),
        value: '0x0',
        chainId: CHAIN_ID,
        description: `Approve and release payment for pact #${params.pactId}`,
    };
    return { transactions: [tx] };
}
/**
 * Build transaction to reclaim funds from an expired escrow (no work submitted).
 * Must be called by the creator after deadline.
 */
export function buildReclaimEscrow(params) {
    const tx = {
        to: PACT_ESCROW_V2,
        data: escrowInterface.encodeFunctionData('reclaim', [
            ethers.BigNumber.from(params.pactId),
        ]),
        value: '0x0',
        chainId: CHAIN_ID,
        description: `Reclaim funds from expired pact #${params.pactId}`,
    };
    return { transactions: [tx] };
}
/**
 * Read escrow state from chain. Requires provider (RPC_URL env var).
 */
export async function getEscrowStatus(params) {
    const provider = new ethers.providers.JsonRpcProvider(params.rpcUrl);
    const escrow = new ethers.Contract(PACT_ESCROW_V2, ESCROW_ABI, provider);
    const [pact, isReleaseable] = await Promise.all([
        escrow.getPact(params.pactId),
        escrow.isReleaseable(params.pactId),
    ]);
    const statusNames = {
        0: 'Active',
        1: 'WorkSubmitted',
        2: 'Approved',
        3: 'Disputed',
        4: 'Released',
        5: 'Refunded',
        6: 'ArbitrationRuled',
    };
    const statusCode = Number(pact.status);
    const deadlineTs = Number(pact.deadline);
    return {
        pactId: params.pactId,
        creator: pact.creator,
        recipient: pact.recipient,
        arbitrator: pact.arbitrator,
        amount: pact.amount.toString(),
        amountPact: ethers.utils.formatUnits(pact.amount, 18),
        arbitratorFee: pact.arbitratorFee.toString(),
        deadline: deadlineTs,
        deadlineISO: new Date(deadlineTs * 1000).toISOString(),
        disputeWindow: Number(pact.disputeWindow),
        arbitrationWindow: Number(pact.arbitrationWindow),
        workSubmittedAt: Number(pact.workSubmittedAt),
        disputeRaisedAt: Number(pact.disputeRaisedAt),
        workHash: pact.workHash,
        status: statusNames[statusCode] ?? 'Unknown',
        statusCode,
        isReleaseable,
    };
}
//# sourceMappingURL=escrow.js.map