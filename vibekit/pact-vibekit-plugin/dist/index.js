#!/usr/bin/env node
/**
 * PACT Protocol MCP Tool Server for Vibekit
 *
 * Exposes PACT escrow and payment channel operations as MCP tools.
 * Returns unsigned transactions (TransactionPlan pattern) for agent wallets.
 *
 * Usage:
 *   npx pact-vibekit-plugin
 *   RPC_URL=https://arb1.arbitrum.io/rpc npx pact-vibekit-plugin
 *
 * Compatible with any MCP client (Vibekit, Claude Desktop, etc.)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { buildCreateEscrow, buildSubmitWork, buildApprovePayment, buildReclaimEscrow, getEscrowStatus, } from './escrow.js';
import { buildOpenChannel, buildPaymentUpdateHash, buildCoopClose, getChannelStatus, } from './channel.js';
import { RPC_URL_DEFAULT } from './constants.js';
const RPC_URL = process.env.RPC_URL ?? RPC_URL_DEFAULT;
// Tool definitions
const TOOLS = [
    {
        name: 'create_escrow',
        description: 'Build unsigned transactions to create a PACT escrow. Returns an ERC-20 approve tx and an escrow create tx. The caller must sign and submit both in order. The pactId is emitted in the PactCreated event.',
        inputSchema: {
            type: 'object',
            properties: {
                recipient: { type: 'string', description: 'Ethereum address of the recipient (service provider)' },
                amountPact: { type: 'string', description: 'Amount of PACT to lock (e.g. "100" for 100 PACT)' },
                deadlineUnix: { type: 'number', description: 'Unix timestamp deadline for work submission' },
                arbitrator: { type: 'string', description: 'Optional arbitrator address (omit for no arbitration)' },
                arbitratorFeePact: { type: 'string', description: 'Optional arbitrator fee in PACT (default "0")' },
                disputeWindowSec: { type: 'number', description: 'Dispute window in seconds (default 86400 = 24h)' },
                arbitrationWindowSec: { type: 'number', description: 'Arbitration window in seconds (default 259200 = 72h)' },
            },
            required: ['recipient', 'amountPact', 'deadlineUnix'],
        },
    },
    {
        name: 'submit_work',
        description: 'Build an unsigned transaction to submit work for a PACT escrow. SHA-256 hashes the workContent and submits the hash on-chain. Keep the original workContent to prove delivery.',
        inputSchema: {
            type: 'object',
            properties: {
                pactId: { type: 'string', description: 'The escrow pact ID' },
                workContent: { type: 'string', description: 'The work product string (URL, IPFS CID, report, etc.) — will be SHA-256 hashed' },
            },
            required: ['pactId', 'workContent'],
        },
    },
    {
        name: 'approve_payment',
        description: 'Build an unsigned transaction to approve and release payment for a completed PACT escrow. Must be called by the escrow creator after work is submitted.',
        inputSchema: {
            type: 'object',
            properties: {
                pactId: { type: 'string', description: 'The escrow pact ID to approve' },
            },
            required: ['pactId'],
        },
    },
    {
        name: 'reclaim_escrow',
        description: 'Build an unsigned transaction to reclaim PACT from an expired escrow where no work was submitted. Must be called by the creator after the deadline.',
        inputSchema: {
            type: 'object',
            properties: {
                pactId: { type: 'string', description: 'The expired escrow pact ID' },
            },
            required: ['pactId'],
        },
    },
    {
        name: 'get_escrow_status',
        description: 'Read the current state of a PACT escrow from Arbitrum One. Returns creator, recipient, amount, deadline, status, and whether payment is releaseable.',
        inputSchema: {
            type: 'object',
            properties: {
                pactId: { type: 'string', description: 'The escrow pact ID' },
            },
            required: ['pactId'],
        },
    },
    {
        name: 'open_channel',
        description: 'Build unsigned transactions to open a PACT payment channel with another agent. Returns an ERC-20 approve tx and a channel open tx. Enables unlimited off-chain micropayments with only 2 on-chain transactions total.',
        inputSchema: {
            type: 'object',
            properties: {
                agentB: { type: 'string', description: 'Ethereum address of the counterparty agent' },
                depositPact: { type: 'string', description: 'Amount of PACT to deposit (e.g. "1000" for 1000 PACT)' },
            },
            required: ['agentB', 'depositPact'],
        },
    },
    {
        name: 'send_payment',
        description: 'Compute the EIP-712 typed data hash for an off-chain PACT payment update. Returns the hash and structured data for the agent to sign. Both parties must sign for a valid update. No on-chain transaction needed.',
        inputSchema: {
            type: 'object',
            properties: {
                channelId: { type: 'string', description: 'The payment channel ID' },
                nonce: { type: 'number', description: 'Monotonically increasing nonce (must be higher than current)' },
                balanceA: { type: 'string', description: "Agent A's new balance in PACT (e.g. '900')" },
                balanceB: { type: 'string', description: "Agent B's new balance in PACT (e.g. '100')" },
            },
            required: ['channelId', 'nonce', 'balanceA', 'balanceB'],
        },
    },
    {
        name: 'close_channel',
        description: 'Build an unsigned transaction for cooperative close of a PACT payment channel. Both agents must have signed the final state (use send_payment to get the hash, then both sign it).',
        inputSchema: {
            type: 'object',
            properties: {
                channelId: { type: 'string', description: 'The payment channel ID' },
                balanceA: { type: 'string', description: "Final balance for agent A in PACT" },
                balanceB: { type: 'string', description: "Final balance for agent B in PACT" },
                nonce: { type: 'number', description: 'Nonce of the final signed state' },
                sigA: { type: 'string', description: "Agent A's EIP-712 signature (hex)" },
                sigB: { type: 'string', description: "Agent B's EIP-712 signature (hex)" },
            },
            required: ['channelId', 'balanceA', 'balanceB', 'nonce', 'sigA', 'sigB'],
        },
    },
    {
        name: 'get_channel_status',
        description: 'Read the current state of a PACT payment channel from Arbitrum One.',
        inputSchema: {
            type: 'object',
            properties: {
                channelId: { type: 'string', description: 'The payment channel ID' },
            },
            required: ['channelId'],
        },
    },
];
// Server setup
const server = new Server({
    name: 'pact-vibekit-plugin',
    version: '0.1.0',
}, {
    capabilities: { tools: {} },
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case 'create_escrow': {
                const result = buildCreateEscrow(args);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            case 'submit_work': {
                const result = buildSubmitWork(args);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            case 'approve_payment': {
                const result = buildApprovePayment(args);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            case 'reclaim_escrow': {
                const result = buildReclaimEscrow(args);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            case 'get_escrow_status': {
                const result = await getEscrowStatus({
                    pactId: args.pactId,
                    rpcUrl: RPC_URL,
                });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            case 'open_channel': {
                const result = buildOpenChannel(args);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            case 'send_payment': {
                const result = buildPaymentUpdateHash({
                    ...args,
                    inPact: true,
                });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            case 'close_channel': {
                const result = buildCoopClose({
                    ...args,
                    inPact: true,
                });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            case 'get_channel_status': {
                const result = await getChannelStatus({
                    channelId: args.channelId,
                    rpcUrl: RPC_URL,
                });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('PACT Vibekit Plugin MCP server running\n');
}
main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map