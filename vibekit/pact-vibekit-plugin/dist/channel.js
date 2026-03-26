import { ethers } from 'ethers';
import { PACT_TOKEN, PACT_PAYMENT_CHANNEL, CHAIN_ID, ERC20_ABI, CHANNEL_ABI, } from './constants.js';
const channelInterface = new ethers.utils.Interface(CHANNEL_ABI);
const erc20Interface = new ethers.utils.Interface(ERC20_ABI);
/**
 * Build transactions to open a PACT payment channel.
 * Returns two transactions:
 *   1. ERC-20 approve (PACT token → channel contract)
 *   2. channel.open(agentB, depositA)
 */
export function buildOpenChannel(params) {
    const deposit = ethers.utils.parseUnits(params.depositPact, 18);
    const approveTx = {
        to: PACT_TOKEN,
        data: erc20Interface.encodeFunctionData('approve', [PACT_PAYMENT_CHANNEL, deposit]),
        value: '0x0',
        chainId: CHAIN_ID,
        description: `Approve ${params.depositPact} PACT to PactPaymentChannel`,
    };
    const openTx = {
        to: PACT_PAYMENT_CHANNEL,
        data: channelInterface.encodeFunctionData('open', [params.agentB, deposit]),
        value: '0x0',
        chainId: CHAIN_ID,
        description: `Open payment channel with ${params.agentB}, deposit ${params.depositPact} PACT`,
    };
    return {
        transactions: [approveTx, openTx],
        note: 'Submit both in order. The channelId is emitted in the ChannelOpened event from tx 2.',
    };
}
/**
 * Compute the EIP-712 typed data hash for a payment update.
 * This is what both agents sign to create a valid off-chain payment.
 *
 * Does NOT require a private key — only needs the domain separator.
 * Used by agents to construct the data to sign.
 */
export function buildPaymentUpdateHash(params) {
    const balA = params.inPact
        ? ethers.utils.parseUnits(params.balanceA, 18)
        : ethers.BigNumber.from(params.balanceA);
    const balB = params.inPact
        ? ethers.utils.parseUnits(params.balanceB, 18)
        : ethers.BigNumber.from(params.balanceB);
    const domain = {
        name: 'PactPaymentChannel',
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: PACT_PAYMENT_CHANNEL,
    };
    const types = {
        PaymentUpdate: [
            { name: 'channelId', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'balanceA', type: 'uint256' },
            { name: 'balanceB', type: 'uint256' },
        ],
    };
    const message = {
        channelId: ethers.BigNumber.from(params.channelId),
        nonce: params.nonce,
        balanceA: balA,
        balanceB: balB,
    };
    const typedDataHash = ethers.utils._TypedDataEncoder.hash(domain, types, message);
    return {
        typedDataHash,
        domain: {
            name: domain.name,
            version: domain.version,
            chainId: domain.chainId,
            verifyingContract: domain.verifyingContract,
        },
        message: {
            channelId: params.channelId,
            nonce: params.nonce,
            balanceA: balA.toString(),
            balanceB: balB.toString(),
        },
    };
}
/**
 * Build transactions for cooperative channel close.
 * Requires both parties' signatures on the final state.
 */
export function buildCoopClose(params) {
    const balA = params.inPact
        ? ethers.utils.parseUnits(params.balanceA, 18)
        : ethers.BigNumber.from(params.balanceA);
    const balB = params.inPact
        ? ethers.utils.parseUnits(params.balanceB, 18)
        : ethers.BigNumber.from(params.balanceB);
    const tx = {
        to: PACT_PAYMENT_CHANNEL,
        data: channelInterface.encodeFunctionData('coopClose', [
            ethers.BigNumber.from(params.channelId),
            balA,
            balB,
            params.nonce,
            params.sigA,
            params.sigB,
        ]),
        value: '0x0',
        chainId: CHAIN_ID,
        description: `Cooperatively close channel #${params.channelId} (nonce=${params.nonce})`,
    };
    return { transactions: [tx] };
}
/**
 * Read payment channel state from chain.
 */
export async function getChannelStatus(params) {
    const provider = new ethers.providers.JsonRpcProvider(params.rpcUrl);
    const contract = new ethers.Contract(PACT_PAYMENT_CHANNEL, CHANNEL_ABI, provider);
    const [ch, isSettleable] = await Promise.all([
        contract.getChannel(params.channelId),
        contract.isSettleable(params.channelId),
    ]);
    const stateNames = {
        0: 'Open',
        1: 'Closing',
        2: 'Closed',
    };
    const stateCode = Number(ch.state);
    return {
        channelId: params.channelId,
        agentA: ch.agentA,
        agentB: ch.agentB,
        depositA: ch.depositA.toString(),
        depositB: ch.depositB.toString(),
        nonce: ch.nonce.toString(),
        balanceA: ch.balanceA.toString(),
        balanceB: ch.balanceB.toString(),
        closeTime: Number(ch.closeTime),
        state: stateNames[stateCode] ?? 'Unknown',
        stateCode,
        isSettleable,
    };
}
//# sourceMappingURL=channel.js.map