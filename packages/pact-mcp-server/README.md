# PACT MCP Server

MCP server for [PACT Protocol](https://dopeasset.com) — trustless escrow and payment channels for AI agents on Arbitrum One.

Built for the [Arbitrum Vibekit](https://github.com/EmberAGI/arbitrum-vibekit) ecosystem. Enables any MCP-compatible agent to create escrow agreements, open payment channels, and settle transactions with other agents — all on-chain, no trust required.

## Install

```bash
npm install pact-mcp-server
```

Or run directly:

```bash
npx pact-mcp-server
```

Or from source:

```bash
git clone https://github.com/praxisagent/pact-vibekit-plugin.git
cd pact-vibekit-plugin
npm install
npm run build
npm start
```

## What It Does

**Escrow (PactEscrow v2)** — Lock PACT tokens in a smart contract. Recipient submits work (with SHA256 hash). Creator has a dispute window to accept or challenge. If no dispute, anyone can release funds after the window expires. If deadline passes without work, creator reclaims. Optional third-party arbitration.

**Payment Channels** — Open a channel once, exchange unlimited micropayments off-chain via EIP-712 signed state updates, settle on-chain when done. Two transactions total regardless of payment count.

## Tools

### Read (no wallet needed)

| Tool | Description |
|------|-------------|
| `pact_get_info` | Protocol overview with live escrow/channel stats |
| `pact_get_escrow` | Get escrow pact details by ID (status, deadline, work hash, releaseability) |
| `pact_get_channel` | Get payment channel details by ID (agents, balances, state) |
| `pact_get_balance` | PACT token balance for any address |

### Write (returns unsigned transactions for the agent to sign)

| Tool | Description |
|------|-------------|
| `pact_build_approve_token` | Approve PACT tokens for escrow or channel contract |
| `pact_build_create_escrow` | Create new escrow (multi-step: approve + create) |
| `pact_build_submit_work` | Submit work evidence hash (recipient) |
| `pact_build_approve_escrow` | Accept work and release tokens (creator) |
| `pact_build_dispute_escrow` | Dispute submitted work (creator, within dispute window) |
| `pact_build_release_escrow` | Release funds after dispute window (anyone) |
| `pact_build_reclaim_escrow` | Reclaim tokens after expired deadline (creator) |
| `pact_build_open_channel` | Open payment channel (multi-step: approve + open) |
| `pact_build_fund_channel` | Fund your side of channel (multi-step: approve + fund) |

## Connect to Your Agent

**Environment variables (optional):**

```bash
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc  # Defaults to public RPC
PORT=3012                                       # Defaults to 3012
```

**HTTP endpoint:** `http://localhost:3012/mcp`

MCP client config (e.g., Vibekit `mcp.json`):
```json
{
  "mcpServers": {
    "pact": {
      "url": "http://localhost:3012/mcp"
    }
  }
}
```

STDIO (Claude Desktop `claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "pact": {
      "command": "npx",
      "args": ["pact-mcp-server"]
    }
  }
}
```

## Transaction Plan Format

Write tools return unsigned transaction calldata — the calling agent signs and broadcasts. No private keys ever touch the MCP server.

```json
{
  "chainId": 42161,
  "to": "0x220B97972d6028Acd70221890771E275e7734BFB",
  "data": "0x...",
  "value": "0",
  "description": "Create escrow: 500 PACT to 0xRecipient, deadline in 72h",
  "steps": [
    { "to": "0x809c...", "data": "0x...", "description": "Step 1: Approve 500 PACT" },
    { "to": "0x220B...", "data": "0x...", "description": "Step 2: Create escrow" }
  ]
}
```

When `steps` is present, submit each step sequentially.

## Contracts (Arbitrum One)

| Contract | Address |
|----------|---------|
| PACT Token | `0x809c2540358E2cF37050cCE41A610cb6CE66Abe1` |
| PactEscrow v2 | `0x220B97972d6028Acd70221890771E275e7734BFB` |
| PactPaymentChannel | `0x5a9D124c05B425CD90613326577E03B3eBd1F891` |

## Security

- **No private keys.** Write tools return unsigned transactions. The agent's wallet handles signing.
- **No max approvals.** Approve tools take exact amounts.
- **Read-only RPC.** The server only reads chain state. No transactions are sent server-side.
- **Validated inputs.** All parameters are Zod-validated before processing.

## Microgrants

PACT Protocol funds builders. Up to 10,000 PACT for integrations, escrow usage, and LP provision. Apply at [dopeasset.com/grants](https://dopeasset.com/grants).

## License

MIT

## Links

- [PACT Protocol](https://dopeasset.com)
- [npm package](https://www.npmjs.com/package/pact-mcp-server)
- [GitHub](https://github.com/praxisagent/pact-vibekit-plugin)
- [Grants Program](https://dopeasset.com/grants)
- [Vibekit PR #572](https://github.com/EmberAGI/arbitrum-vibekit/pull/572)
