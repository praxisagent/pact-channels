# PACT Protocol — Sui Demo Setup

Two-agent CLI demo showing trustless escrow on Sui testnet.

## What it does

Agent A (hiring agent) locks SUI in a PactEscrow on Sui.
Agent B (service agent) generates a risk analysis, commits its SHA256 hash on-chain, then reveals the content.
Agent A verifies hash matches, calls approve(), payment releases.

No human approval. No trust required. Full on-chain audit trail.

## Prerequisites

```bash
# 1. Install Sui CLI
cargo install --locked --git https://github.com/MystenLabs/sui.git sui

# 2. Configure testnet wallet
sui client new-address ed25519
sui client switch --env testnet

# 3. Get testnet SUI
# Visit: https://docs.sui.io/guides/developer/getting-started/get-coins
# Faucet: https://faucet.testnet.sui.io/

# 4. Python deps
pip install pysui anthropic
```

## Deploy the contract

```bash
cd /opt/praxis/sui/pact-escrow

# Build
sui move build

# Test
sui move test

# Deploy to testnet
sui client publish --gas-budget 100000000
```

After publishing, note the output:
- `PackageID` → set as PACT_PACKAGE_ID
- The `Registry` shared object ID → set as PACT_REGISTRY

## Run the demo

In two separate terminals:

### Terminal 1 — Agent A (hiring agent)
```bash
export PACT_PACKAGE_ID=0x<your-package-id>
export PACT_REGISTRY=0x<registry-object-id>
export ANTHROPIC_API_KEY=<optional-for-real-llm-output>

python demo/agent_a.py --recipient <AGENT_B_SUI_ADDRESS> --amount 100000000
```

### Terminal 2 — Agent B (service agent)
```bash
export PACT_PACKAGE_ID=0x<your-package-id>
export ANTHROPIC_API_KEY=<optional-for-real-llm-output>

python demo/agent_b.py
```

## Expected output

Agent A:
```
PACT PROTOCOL — Agent A (Hiring Agent)
Package:   0x...
Registry:  0x...
Recipient: 0xB...
Amount:    100000000 MIST (0.1000 SUI)

[Agent A] Creating pact: 100000000 MIST → 0xB...
[Agent A] Pact created: 0x<pact-object-id>
[Agent A] TX: <tx-digest>
[Agent A] Task published to /tmp/pact-demo-task.json
[Agent A] Waiting for Agent B to submit work...
[Agent A] Work submitted! Pact status: 1

[Agent A] Verification:
  Delivered content: • Smart contract risk: ...
  Computed SHA256:   a1b2c3...
  On-chain hash:     a1b2c3...
  Agent B reported:  a1b2c3...
[Agent A] Hash VERIFIED — content matches commitment

[Agent A] Approving pact 0x<pact-object-id>...
[Agent A] APPROVED — payment released. TX: <tx-digest>
[Agent A] Mission complete. Payment released.
```

Agent B:
```
PACT PROTOCOL — Agent B (Service Agent)
[Agent B] Waiting for task from Agent A...
[Agent B] Task received! Pact: 0x<pact-object-id>
[Agent B] Generating deliverable...
[Agent B] Submitting work hash on-chain...
[Agent B] Hash: a1b2c3...
[Agent B] Work submitted. TX: <tx-digest>

DELIVERABLE:
• Smart contract risk: ...
• Oracle/arbitration risk: ...
• Token liquidity risk: ...

SHA256: a1b2c3...
[Agent B] Done. Waiting for Agent A to verify and approve.
```

## Verify on-chain

After the demo, check the pact on Suiscan:
```
https://suiscan.xyz/testnet/object/<pact-object-id>
```

You'll see:
- `status: 3` (Complete)
- `work_hash: [...]` (32 bytes, SHA256 of the deliverable)
- `balance: 0` (funds released)

## Architecture notes

- **Generic over coin type**: The contract works with `SUI`, `USDC`, or any `Coin<T>`
- **Shared objects**: Each Pact is a Sui shared object — accessible by any transaction
- **No reentrancy**: Sui Move's object model prevents reentrancy at the language level
- **Balance safety**: `Balance<T>` tracks exact amounts — no overflow/underflow possible
- **Clock**: Uses `sui::clock::Clock` (shared object 0x6) for tamper-proof timestamps

## Connection to Arbitrum production

This Move contract is a faithful port of PactEscrowV2 deployed on Arbitrum One:
`0x220B97972d6028Acd70221890771E275e7734BFB`

The same lifecycle (Active → WorkSubmitted → Complete/Refunded) with the same
security properties. 9,999 PACT settled through the Arbitrum version across
10 adversarially-tested escrow cycles.
