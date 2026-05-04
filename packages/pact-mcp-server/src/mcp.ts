import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ethers } from 'ethers';
import { z } from 'zod';
import {
  CONTRACTS,
  ESCROW_ABI,
  CHANNEL_ABI,
  ERC20_ABI,
  PACT_STATUS,
  CHANNEL_STATE,
} from './contracts.js';

// ──────────────────── Helpers ─────────────────────────────────

function provider(rpcUrl: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpcUrl);
}

function escrowContract(rpcUrl: string): ethers.Contract {
  return new ethers.Contract(CONTRACTS.PACT_ESCROW, ESCROW_ABI, provider(rpcUrl));
}

function channelContract(rpcUrl: string): ethers.Contract {
  return new ethers.Contract(CONTRACTS.PACT_CHANNEL, CHANNEL_ABI, provider(rpcUrl));
}

function tokenContract(rpcUrl: string): ethers.Contract {
  return new ethers.Contract(CONTRACTS.PACT_TOKEN, ERC20_ABI, provider(rpcUrl));
}

function formatPact(raw: ethers.Result, pactId: bigint) {
  return {
    pactId: pactId.toString(),
    creator: raw[0],
    recipient: raw[1],
    verifier: raw[2],
    amount: raw[3].toString(),
    amountPACT: ethers.formatUnits(raw[3], 18),
    deadline: raw[4].toString(),
    deadlineISO: new Date(Number(raw[4]) * 1000).toISOString(),
    status: raw[5].toString(),
    statusLabel: PACT_STATUS[Number(raw[5])] ?? 'Unknown',
    escrowContract: CONTRACTS.PACT_ESCROW,
    tokenContract: CONTRACTS.PACT_TOKEN,
  };
}

function formatChannel(raw: ethers.Result, channelId: bigint) {
  const totalDeposit = raw[4] as bigint;
  return {
    channelId: channelId.toString(),
    agentA: raw[0],
    agentB: raw[1],
    depositA: raw[2].toString(),
    depositAFormatted: ethers.formatUnits(raw[2], 18),
    depositB: raw[3].toString(),
    depositBFormatted: ethers.formatUnits(raw[3], 18),
    totalDeposit: totalDeposit.toString(),
    totalDepositFormatted: ethers.formatUnits(totalDeposit, 18),
    nonce: raw[5].toString(),
    balanceA: raw[6].toString(),
    balanceAFormatted: ethers.formatUnits(raw[6], 18),
    balanceB: raw[7].toString(),
    balanceBFormatted: ethers.formatUnits(raw[7], 18),
    closeTime: raw[8].toString(),
    closeTimeISO: raw[8] > 0n ? new Date(Number(raw[8]) * 1000).toISOString() : null,
    state: raw[9].toString(),
    stateLabel: CHANNEL_STATE[Number(raw[9])] ?? 'Unknown',
    channelContract: CONTRACTS.PACT_CHANNEL,
    tokenContract: CONTRACTS.PACT_TOKEN,
  };
}

// Build a raw transaction object (unsigned) for the agent to sign and send
function buildTx(to: string, data: string, note: string) {
  return {
    to,
    data,
    value: '0',
    chainId: 42161,
    note,
    warning: 'Review before signing. Ensure you have approved PACT tokens if required.',
  };
}

// ──────────────────── MCP Server ─────────────────────────────

export function createServer(rpcUrl: string): McpServer {
  const server = new McpServer({
    name: 'pact-mcp-server',
    version: '1.0.0',
  });

  // ── Read: PACT token balance ───────────────────────────────
  server.tool(
    'pact_get_balance',
    'Get PACT token balance for any address on Arbitrum. Returns raw and formatted amounts.',
    { address: z.string().describe('Arbitrum address to check balance for') },
    async ({ address }) => {
      const token = tokenContract(rpcUrl);
      const [balance, allowanceEscrow, allowanceChannel] = await Promise.all([
        token.balanceOf(address) as Promise<bigint>,
        token.allowance(address, CONTRACTS.PACT_ESCROW) as Promise<bigint>,
        token.allowance(address, CONTRACTS.PACT_CHANNEL) as Promise<bigint>,
      ]);
      const result = {
        address,
        balance: balance.toString(),
        balanceFormatted: ethers.formatUnits(balance, 18),
        allowances: {
          escrowContract: {
            address: CONTRACTS.PACT_ESCROW,
            allowance: allowanceEscrow.toString(),
            allowanceFormatted: ethers.formatUnits(allowanceEscrow, 18),
          },
          channelContract: {
            address: CONTRACTS.PACT_CHANNEL,
            allowance: allowanceChannel.toString(),
            allowanceFormatted: ethers.formatUnits(allowanceChannel, 18),
          },
        },
        tokenContract: CONTRACTS.PACT_TOKEN,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Read: Get pact/escrow by ID ────────────────────────────
  server.tool(
    'pact_get_escrow',
    'Get details of a PACT escrow agreement by its ID. Returns creator, recipient, verifier, amount locked, deadline, and current status.',
    { pactId: z.number().describe('The escrow pact ID (starts at 0)') },
    async ({ pactId }) => {
      const escrow = escrowContract(rpcUrl);
      const [raw, nextId] = await Promise.all([
        escrow.pacts(pactId) as Promise<ethers.Result>,
        escrow.nextPactId() as Promise<bigint>,
      ]);
      if (BigInt(pactId) >= nextId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Pact ${pactId} does not exist. Next ID is ${nextId}.` }) }] };
      }
      const result = formatPact(raw, BigInt(pactId));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Read: Get total escrow count ──────────────────────────
  server.tool(
    'pact_get_escrow_count',
    'Get the total number of escrow pacts created on PACT Protocol.',
    {},
    async () => {
      const escrow = escrowContract(rpcUrl);
      const nextId = await escrow.nextPactId() as bigint;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ totalPacts: nextId.toString(), nextPactId: nextId.toString() }, null, 2),
        }],
      };
    }
  );

  // ── Read: Get payment channel by ID ───────────────────────
  server.tool(
    'pact_get_channel',
    'Get details of a PACT payment channel by its ID. Returns both agents, deposits, current balances, nonce, and channel state.',
    { channelId: z.number().describe('The channel ID (starts at 0)') },
    async ({ channelId }) => {
      const ch = channelContract(rpcUrl);
      const [raw, nextId] = await Promise.all([
        ch.channels(channelId) as Promise<ethers.Result>,
        ch.nextChannelId() as Promise<bigint>,
      ]);
      if (BigInt(channelId) >= nextId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Channel ${channelId} does not exist. Next ID is ${nextId}.` }) }] };
      }
      const settleable = await ch.isSettleable(channelId) as boolean;
      const result = { ...formatChannel(raw, BigInt(channelId)), isSettleable: settleable };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Read: Get total channel count ─────────────────────────
  server.tool(
    'pact_get_channel_count',
    'Get the total number of payment channels created on PACT Protocol.',
    {},
    async () => {
      const ch = channelContract(rpcUrl);
      const nextId = await ch.nextChannelId() as bigint;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ totalChannels: nextId.toString(), nextChannelId: nextId.toString() }, null, 2),
        }],
      };
    }
  );

  // ── Write: Build approve transaction ──────────────────────
  server.tool(
    'pact_build_approve',
    'Build a PACT token approval transaction. Must be sent before create_escrow or open_channel. Returns unsigned transaction calldata.',
    {
      spender: z.enum(['escrow', 'channel']).describe('Which contract to approve: "escrow" for PactEscrow, "channel" for PactPaymentChannel'),
      amountPACT: z.string().describe('Amount of PACT to approve (e.g. "100" for 100 PACT). Use "0" to revoke.'),
    },
    async ({ spender, amountPACT }) => {
      const spenderAddress = spender === 'escrow' ? CONTRACTS.PACT_ESCROW : CONTRACTS.PACT_CHANNEL;
      const iface = new ethers.Interface(ERC20_ABI);
      const amount = ethers.parseUnits(amountPACT, 18);
      const data = iface.encodeFunctionData('approve', [spenderAddress, amount]);
      const tx = buildTx(
        CONTRACTS.PACT_TOKEN,
        data,
        `Approve ${amountPACT} PACT for ${spender} contract (${spenderAddress})`
      );
      return { content: [{ type: 'text', text: JSON.stringify(tx, null, 2) }] };
    }
  );

  // ── Write: Build create escrow transaction ────────────────
  server.tool(
    'pact_build_create_escrow',
    'Build a transaction to create a new PACT escrow. The calling wallet must have approved the escrow contract for the specified amount first (use pact_build_approve). Returns unsigned transaction calldata.',
    {
      recipient: z.string().describe('Address of the agent who will do the work and receive payment'),
      verifier: z.string().describe('Address of the verifier agent. Use "0x0000000000000000000000000000000000000000" for self-verified (recipient receives payment immediately on complete)'),
      amountPACT: z.string().describe('Amount of PACT to lock in escrow (e.g. "500" for 500 PACT)'),
      deadlineTimestamp: z.number().describe('Unix timestamp (seconds) after which creator can reclaim if work is incomplete. Must be in the future.'),
    },
    async ({ recipient, verifier, amountPACT, deadlineTimestamp }) => {
      const iface = new ethers.Interface(ESCROW_ABI);
      const amount = ethers.parseUnits(amountPACT, 18);
      const data = iface.encodeFunctionData('create', [recipient, verifier, amount, deadlineTimestamp]);
      const deadlineISO = new Date(deadlineTimestamp * 1000).toISOString();
      const tx = buildTx(
        CONTRACTS.PACT_ESCROW,
        data,
        `Create escrow: ${amountPACT} PACT → ${recipient}, deadline ${deadlineISO}`
      );
      const result = {
        ...tx,
        params: { recipient, verifier, amountPACT, amount: amount.toString(), deadlineTimestamp, deadlineISO },
        prerequisite: `Approve escrow contract ${CONTRACTS.PACT_ESCROW} for ${amountPACT} PACT first using pact_build_approve`,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Write: Build complete escrow transaction ──────────────
  server.tool(
    'pact_build_complete_escrow',
    'Build a transaction for the recipient to mark work as complete. If the pact has no verifier (self-verified), tokens are released immediately. If there is a verifier, the pact moves to PendingVerification. Must be called by the recipient wallet.',
    { pactId: z.number().describe('The escrow pact ID to complete') },
    async ({ pactId }) => {
      const iface = new ethers.Interface(ESCROW_ABI);
      const data = iface.encodeFunctionData('complete', [pactId]);
      const tx = buildTx(
        CONTRACTS.PACT_ESCROW,
        data,
        `Mark pact ${pactId} as complete (must be called by recipient)`
      );
      return { content: [{ type: 'text', text: JSON.stringify(tx, null, 2) }] };
    }
  );

  // ── Write: Build verify escrow transaction ────────────────
  server.tool(
    'pact_build_verify_escrow',
    'Build a transaction for the verifier to confirm work completion and release tokens to the recipient. Must be called by the verifier wallet. Pact must be in PendingVerification status.',
    { pactId: z.number().describe('The escrow pact ID to verify') },
    async ({ pactId }) => {
      const iface = new ethers.Interface(ESCROW_ABI);
      const data = iface.encodeFunctionData('verify', [pactId]);
      const tx = buildTx(
        CONTRACTS.PACT_ESCROW,
        data,
        `Verify pact ${pactId} complete and release tokens (must be called by verifier)`
      );
      return { content: [{ type: 'text', text: JSON.stringify(tx, null, 2) }] };
    }
  );

  // ── Write: Build reclaim escrow transaction ───────────────
  server.tool(
    'pact_build_reclaim_escrow',
    'Build a transaction for the creator to reclaim locked PACT tokens after the deadline has passed and work was not completed. Must be called by the creator wallet after the deadline.',
    { pactId: z.number().describe('The escrow pact ID to reclaim') },
    async ({ pactId }) => {
      const iface = new ethers.Interface(ESCROW_ABI);
      const data = iface.encodeFunctionData('reclaim', [pactId]);
      const tx = buildTx(
        CONTRACTS.PACT_ESCROW,
        data,
        `Reclaim pact ${pactId} tokens (must be called by creator, only after deadline)`
      );
      return { content: [{ type: 'text', text: JSON.stringify(tx, null, 2) }] };
    }
  );

  // ── Write: Build open channel transaction ─────────────────
  server.tool(
    'pact_build_open_channel',
    'Build a transaction to open a PACT payment channel with another agent. Caller deposits PACT upfront. The counterparty (agentB) can optionally fund their side later with pact_build_fund_channel. Must approve the channel contract for depositA first.',
    {
      agentB: z.string().describe('Address of the counterparty agent'),
      depositAmountPACT: z.string().describe('Amount of PACT to deposit as channel opener (e.g. "1000" for 1000 PACT)'),
    },
    async ({ agentB, depositAmountPACT }) => {
      const iface = new ethers.Interface(CHANNEL_ABI);
      const deposit = ethers.parseUnits(depositAmountPACT, 18);
      const data = iface.encodeFunctionData('open', [agentB, deposit]);
      const tx = buildTx(
        CONTRACTS.PACT_CHANNEL,
        data,
        `Open payment channel with ${agentB}, deposit ${depositAmountPACT} PACT`
      );
      const result = {
        ...tx,
        params: { agentB, depositAmountPACT, deposit: deposit.toString() },
        prerequisite: `Approve channel contract ${CONTRACTS.PACT_CHANNEL} for ${depositAmountPACT} PACT first using pact_build_approve`,
        note: 'After opening, agentB can fund their side using pact_build_fund_channel. Channel enables unlimited off-chain PACT transfers settled in 2 on-chain transactions.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Write: Build fund channel transaction ─────────────────
  server.tool(
    'pact_build_fund_channel',
    'Build a transaction for agentB to fund their side of a payment channel. Optional — channels work with one-sided deposits. Must be called by agentB.',
    {
      channelId: z.number().describe('The channel ID to fund'),
      depositAmountPACT: z.string().describe('Amount of PACT to deposit as agentB'),
    },
    async ({ channelId, depositAmountPACT }) => {
      const iface = new ethers.Interface(CHANNEL_ABI);
      const deposit = ethers.parseUnits(depositAmountPACT, 18);
      const data = iface.encodeFunctionData('fund', [channelId, deposit]);
      const tx = buildTx(
        CONTRACTS.PACT_CHANNEL,
        data,
        `Fund channel ${channelId} with ${depositAmountPACT} PACT (must be called by agentB)`
      );
      return { content: [{ type: 'text', text: JSON.stringify(tx, null, 2) }] };
    }
  );

  // ── Helper: Compute EIP-712 payment digest ────────────────
  server.tool(
    'pact_compute_payment_digest',
    'Compute the EIP-712 digest for a PACT payment channel state update. Both agents must sign this digest off-chain to authorize a payment state. Use this to prepare the message before signing with your wallet.',
    {
      channelId: z.number().describe('The channel ID'),
      nonce: z.number().describe('Monotonically increasing payment nonce (start at 1, increment each payment)'),
      balanceA: z.string().describe('agentA final PACT balance in this state (raw wei string, e.g. "900000000000000000000" for 900 PACT)'),
      balanceB: z.string().describe('agentB final PACT balance in this state (raw wei string)'),
    },
    async ({ channelId, nonce, balanceA, balanceB }) => {
      // Compute domain separator manually
      const DOMAIN_SEPARATOR = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
          [
            ethers.keccak256(ethers.toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
            ethers.keccak256(ethers.toUtf8Bytes('PactPaymentChannel')),
            ethers.keccak256(ethers.toUtf8Bytes('1')),
            42161n,
            CONTRACTS.PACT_CHANNEL,
          ]
        )
      );

      const UPDATE_TYPEHASH = ethers.keccak256(
        ethers.toUtf8Bytes('PaymentUpdate(uint256 channelId,uint256 nonce,uint256 balanceA,uint256 balanceB)')
      );

      const structHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['bytes32', 'uint256', 'uint256', 'uint256', 'uint256'],
          [UPDATE_TYPEHASH, channelId, nonce, BigInt(balanceA), BigInt(balanceB)]
        )
      );

      const digest = ethers.keccak256(
        ethers.concat([
          ethers.toUtf8Bytes('\x19\x01'),
          ethers.getBytes(DOMAIN_SEPARATOR),
          ethers.getBytes(structHash),
        ])
      );

      const result = {
        digest,
        domainSeparator: DOMAIN_SEPARATOR,
        updateTypehash: UPDATE_TYPEHASH,
        structHash,
        params: { channelId, nonce, balanceA, balanceB },
        usage: 'Both agentA and agentB must sign this digest using eth_sign or signMessage. The signatures are used in pact_build_coop_close or pact_build_initiate_close.',
        balanceAFormatted: ethers.formatUnits(BigInt(balanceA), 18),
        balanceBFormatted: ethers.formatUnits(BigInt(balanceB), 18),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Write: Build cooperative close transaction ────────────
  server.tool(
    'pact_build_coop_close',
    'Build a transaction to cooperatively close a payment channel instantly. Requires valid EIP-712 signatures from both agents on the final state. No challenge period — tokens are distributed immediately.',
    {
      channelId: z.number().describe('The channel ID to close'),
      balanceA: z.string().describe('Final PACT balance for agentA (raw wei string)'),
      balanceB: z.string().describe('Final PACT balance for agentB (raw wei string)'),
      nonce: z.number().describe('The nonce of the final state'),
      sigA: z.string().describe('agentA EIP-712 signature (65-byte hex, 0x-prefixed)'),
      sigB: z.string().describe('agentB EIP-712 signature (65-byte hex, 0x-prefixed)'),
    },
    async ({ channelId, balanceA, balanceB, nonce, sigA, sigB }) => {
      const iface = new ethers.Interface(CHANNEL_ABI);
      const data = iface.encodeFunctionData('coopClose', [
        channelId,
        BigInt(balanceA),
        BigInt(balanceB),
        nonce,
        sigA,
        sigB,
      ]);
      const tx = buildTx(
        CONTRACTS.PACT_CHANNEL,
        data,
        `Cooperatively close channel ${channelId}: agentA gets ${ethers.formatUnits(BigInt(balanceA), 18)} PACT, agentB gets ${ethers.formatUnits(BigInt(balanceB), 18)} PACT`
      );
      return { content: [{ type: 'text', text: JSON.stringify(tx, null, 2) }] };
    }
  );

  // ── Write: Build initiate close transaction ───────────────
  server.tool(
    'pact_build_initiate_close',
    'Build a transaction to unilaterally initiate a payment channel close. Starts a 1-hour challenge period during which the counterparty can submit a higher-nonce state. Requires signatures from both agents.',
    {
      channelId: z.number().describe('The channel ID to close'),
      balanceA: z.string().describe('agentA balance in the submitted state (raw wei string)'),
      balanceB: z.string().describe('agentB balance in the submitted state (raw wei string)'),
      nonce: z.number().describe('The nonce of the submitted state'),
      sigA: z.string().describe('agentA EIP-712 signature'),
      sigB: z.string().describe('agentB EIP-712 signature'),
    },
    async ({ channelId, balanceA, balanceB, nonce, sigA, sigB }) => {
      const iface = new ethers.Interface(CHANNEL_ABI);
      const data = iface.encodeFunctionData('initiateClose', [
        channelId,
        BigInt(balanceA),
        BigInt(balanceB),
        nonce,
        sigA,
        sigB,
      ]);
      const tx = buildTx(
        CONTRACTS.PACT_CHANNEL,
        data,
        `Initiate close for channel ${channelId} (1-hour challenge period begins)`
      );
      const result = {
        ...tx,
        challengePeriodHours: 1,
        nextStep: 'After 1 hour, call pact_build_settle_channel to finalize. If the counterparty has a higher-nonce state, they can challenge during this window.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Write: Build challenge transaction ────────────────────
  server.tool(
    'pact_build_challenge',
    'Build a transaction to challenge a pending channel close with a higher-nonce state. Resets the challenge timer. Use this if the counterparty submitted a stale state.',
    {
      channelId: z.number().describe('The channel ID being challenged'),
      balanceA: z.string().describe('agentA balance in the newer state (raw wei string)'),
      balanceB: z.string().describe('agentB balance in the newer state (raw wei string)'),
      nonce: z.number().describe('Must be higher than the nonce already on-chain'),
      sigA: z.string().describe('agentA EIP-712 signature on this state'),
      sigB: z.string().describe('agentB EIP-712 signature on this state'),
    },
    async ({ channelId, balanceA, balanceB, nonce, sigA, sigB }) => {
      const iface = new ethers.Interface(CHANNEL_ABI);
      const data = iface.encodeFunctionData('challenge', [
        channelId,
        BigInt(balanceA),
        BigInt(balanceB),
        nonce,
        sigA,
        sigB,
      ]);
      const tx = buildTx(
        CONTRACTS.PACT_CHANNEL,
        data,
        `Challenge channel ${channelId} close with nonce ${nonce} (resets challenge timer)`
      );
      return { content: [{ type: 'text', text: JSON.stringify(tx, null, 2) }] };
    }
  );

  // ── Write: Build settle transaction ───────────────────────
  server.tool(
    'pact_build_settle_channel',
    'Build a transaction to settle a payment channel after the 1-hour challenge period has expired. Anyone can call this. Tokens are distributed according to the final submitted state.',
    { channelId: z.number().describe('The channel ID to settle') },
    async ({ channelId }) => {
      const ch = channelContract(rpcUrl);
      const settleable = await ch.isSettleable(channelId) as boolean;
      const iface = new ethers.Interface(CHANNEL_ABI);
      const data = iface.encodeFunctionData('settle', [channelId]);
      const tx = buildTx(
        CONTRACTS.PACT_CHANNEL,
        data,
        `Settle channel ${channelId} after challenge period`
      );
      const result = {
        ...tx,
        isSettleableNow: settleable,
        warning: settleable
          ? 'Channel is settleable now.'
          : 'Channel may not be settleable yet — check that it is in Closing state and the challenge period has expired.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Info: Protocol overview ────────────────────────────────
  server.tool(
    'pact_protocol_info',
    'Get PACT Protocol information: contract addresses, chain, token details, and quick-start guide for agents.',
    {},
    async () => {
      const result = {
        protocol: 'PACT Protocol',
        description: 'Open-source agent commerce infrastructure. Trustless escrow and payment channels for AI agents on Arbitrum.',
        website: 'https://dopeasset.com',
        grantsProgram: 'https://dopeasset.com/grants',
        chain: { name: 'Arbitrum One', chainId: 42161 },
        contracts: {
          PACTToken: { address: CONTRACTS.PACT_TOKEN, description: 'ERC-20 token. Fixed 1B supply. No mint/admin/freeze.' },
          PactEscrowV2: { address: CONTRACTS.PACT_ESCROW, description: 'Trustless service agreements. Lock PACT, complete work, release payment.' },
          PactPaymentChannel: { address: CONTRACTS.PACT_CHANNEL, description: 'Bidirectional payment channels. Open once, transact unlimited times off-chain, settle on-chain.' },
        },
        quickStart: {
          escrow: [
            '1. Call pact_build_approve with spender="escrow" and your amount',
            '2. Send the approve transaction',
            '3. Call pact_build_create_escrow with recipient, verifier, amount, deadline',
            '4. Send the create transaction — pact is now live',
            '5. Recipient calls pact_build_complete_escrow when work is done',
            '6. If self-verified: tokens released immediately. If verifier: they call pact_build_verify_escrow',
          ],
          paymentChannel: [
            '1. Call pact_build_approve with spender="channel" and your deposit amount',
            '2. Send the approve transaction',
            '3. Call pact_build_open_channel with agentB and depositAmount',
            '4. Send the open transaction — channel ID returned in event logs',
            '5. Exchange signed payment updates off-chain using pact_compute_payment_digest',
            '6. When done, both parties sign final state and call pact_build_coop_close',
          ],
        },
        grants: {
          description: 'PACT offers micro-grants up to 10,000 PACT for agents who build integrations or use PactEscrow.',
          url: 'https://dopeasset.com/grants',
          contact: 'praxis@dopeasset.com',
        },
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}
