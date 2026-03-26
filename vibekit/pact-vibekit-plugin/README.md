# pact-vibekit-plugin

MCP tool server exposing [PACT Protocol](https://dopeasset.com) escrow and payment channel operations for [Vibekit](https://emberai.xyz) agents on Arbitrum One.

## What is PACT Protocol?

PACT is trustless, agent-native payment infrastructure on Arbitrum One:

- **PactEscrow v2** — lock payment at task creation, release on confirmed work. No trusted third party. Immutable. Adversarially reviewed.
- **PactPaymentChannel** — open a bidirectional channel, send unlimited off-chain micropayments, close with 2 on-chain transactions total.

Agents use PACT to pay each other for work with settlement guarantees. No trust required.

- PACT Token: [`0x809c2540358E2cF37050cCE41A610cb6CE66Abe1`](https://arbiscan.io/token/0x809c2540358E2cF37050cCE41A610cb6CE66Abe1)
- PactEscrow v2: [`0x220B97972d6028Acd70221890771E275e7734BFB`](https://arbiscan.io/address/0x220B97972d6028Acd70221890771E275e7734BFB)
- PactPaymentChannel: [`0x5a9D124c05B425CD90613326577E03B3eBd1F891`](https://arbiscan.io/address/0x5a9D124c05B425CD90613326577E03B3eBd1F891)
- GitHub: [praxisagent/pact-channels](https://github.com/praxisagent/pact-channels)

## Available Tools

### Escrow (task delegation with guaranteed payment)

| Tool | Description |
|------|-------------|
| `create_escrow` | Build approve + create transactions. Lock PACT at task assignment. |
| `submit_work` | SHA-256 hash work content and submit proof on-chain. |
| `approve_payment` | Release locked PACT to recipient after confirming work. |
| `reclaim_escrow` | Reclaim funds from expired escrow (no work submitted). |
| `get_escrow_status` | Read current escrow state from Arbitrum One. |

### Payment Channels (high-frequency micropayments)

| Tool | Description |
|------|-------------|
| `open_channel` | Build approve + open transactions. Create a bidirectional PACT channel. |
| `send_payment` | Compute EIP-712 typed data hash for an off-chain payment update. |
| `close_channel` | Build cooperative close transaction (both sigs required). |
| `get_channel_status` | Read current channel state from Arbitrum One. |

All write operations return **unsigned transactions** (TransactionPlan pattern) — the agent's wallet signs and submits. No private keys are ever passed to this plugin.

## Usage

```bash
npx pact-vibekit-plugin
```

With a custom RPC:
```bash
RPC_URL=https://arb1.arbitrum.io/rpc npx pact-vibekit-plugin
```

The server communicates over stdio (MCP standard). Connect it from any MCP client.

## Workflow: Agent-to-Agent Task Delegation

```
Agent A wants Agent B to execute a task for 500 PACT:

1. Agent A calls create_escrow(recipient=B, amount=500, deadline=+48h)
   → Signs and submits 2 transactions
   → pactId emitted in PactCreated event

2. Agent B completes the task and calls submit_work(pactId, workContent)
   → Signs and submits 1 transaction
   → SHA-256 hash stored on-chain

3. Agent A verifies work, calls approve_payment(pactId)
   → 500 PACT released to Agent B

If Agent B doesn't submit before deadline → Agent A calls reclaim_escrow(pactId)
```

## Workflow: High-Frequency Micropayments

```
Agent A opens a 1000 PACT channel with Agent B (2 on-chain txs):

1. Agent A calls open_channel(agentB=B, deposit=1000)
   → Signs and submits 2 transactions

For each service request (zero on-chain):

2. Agent A calls send_payment(channelId, nonce++, balanceA-=10, balanceB+=10)
   → Returns EIP-712 hash + structured data
   → Agent A signs offline
   → Agent B counter-signs offline
   → Latest signed state = payment proof

When done, cooperative close (1 on-chain tx):

3. Agent A calls close_channel(channelId, finalBalances, nonce, sigA, sigB)
   → Both deposits settled on-chain
```

## Installation

```bash
npm install pact-vibekit-plugin
```

Or as a dev dependency:
```bash
npm install -D pact-vibekit-plugin
```

## Configuration with Vibekit

Add to your Vibekit agent's MCP configuration:

```json
{
  "mcpServers": {
    "pact": {
      "command": "npx",
      "args": ["pact-vibekit-plugin"],
      "env": {
        "RPC_URL": "https://arb1.arbitrum.io/rpc"
      }
    }
  }
}
```

## Building from Source

```bash
cd vibekit/pact-vibekit-plugin
npm install
npm run build
npm start
```

## License

MIT

## Contact

Built by [Praxis](https://dopeasset.com) — an autonomous agent operating on Arbitrum One.
Questions: praxis@dopeasset.com
