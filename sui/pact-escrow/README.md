# PactEscrow — Sui Move

Trustless agent-to-agent service escrow on Sui. Port of
[PactEscrowV2.sol](../../PactEscrowV2.sol) from Arbitrum One.

**Production record (Arbitrum):** 9,999+ PACT settled. Adversarially tested (AT-01 through AT-10).

## Why Move?

| EVM (Solidity)                      | Sui Move                              |
|-------------------------------------|---------------------------------------|
| Reentrancy: must use CEI pattern    | Impossible: linear types, no callbacks|
| Double-spend: require + mapping     | Impossible: `Balance<T>` is linear    |
| Timestamps: block.timestamp (miner) | `Clock` object: deterministic, testable|
| Multi-party: explicit approvals     | Shared objects: any party can act     |

The Move port is shorter, cleaner, and safer than the Solidity original.

## Lifecycle

```
create()  ─────────────────────────────────────────► Active
                                                         │
submit_work()  ──────────────────────────────────► WorkSubmitted
                                                    │         │
                                        dispute()  │         │  approve() or
                                   (within window) │         │  release() (after window)
                                                    ▼         ▼
                                                Disputed   Complete ◄──────── finalize_arbitration()
                                                    │
                                               rule()  ──────────────► Complete (recipient wins)
                                                    │
                                                    └────────────────► Refunded (creator wins)

reclaim() (from Active, after deadline, no work) ────────────────────► Refunded
```

## Functions

| Function | Who can call | When |
|----------|-------------|------|
| `create()` | Anyone | Always |
| `submit_work()` | Recipient only | When Active, before deadline |
| `approve()` | Creator only | When WorkSubmitted |
| `dispute()` | Creator only | When WorkSubmitted, within dispute window, arbitrator set |
| `release()` | Anyone | When WorkSubmitted, after dispute window |
| `rule()` | Arbitrator only | When Disputed, within arbitration window |
| `finalize_arbitration()` | Anyone | When Disputed, after arbitration window |
| `reclaim()` | Creator only | When Active, after deadline |

## Key Design Decisions

**No max-approval:** `Balance<SUI>` is taken in full at creation. No allowance system.

**Immutable core invariant:** Once `submit_work()` is called, creator cannot reclaim.
This is the core fix over v1 — recipient who acts in good faith is protected.

**Arbitrator timeout defaults to recipient:** If arbitrator goes silent, `finalize_arbitration()`
releases full amount to recipient. Arbitrator forfeits fee for inaction.

**Anyone can trigger timeout-based releases:** `release()` and `finalize_arbitration()` are
callable by anyone. This enables KeeperHub-style automation without trust assumptions.

## Build & Test

```bash
# Install Sui CLI
cargo install --locked --git https://github.com/MystenLabs/sui.git sui

# Build
cd contracts/sui/pact_escrow
sui move build

# Test (all 10 adversarial tests + happy paths)
sui move test

# Deploy to testnet (after sui client setup)
sui client publish --gas-budget 100000000
```

## Testnet Deployment

1. Get SUI testnet wallet: `sui client new-address ed25519`
2. Get faucet tokens: https://docs.sui.io/guides/developer/getting-started/get-coins
3. Set up RPC: `sui client new-env --alias testnet --rpc https://fullnode.testnet.sui.io:443`
4. Publish: `sui client publish --gas-budget 100000000`

## Part of PACT Protocol

- **Arbitrum mainnet:** [PactEscrowV2](https://arbiscan.io/address/0x220B97972d6028Acd70221890771E275e7734BFB)
- **MCP server:** [pact-mcp-server@1.0.1](https://www.npmjs.com/package/pact-mcp-server)
- **Website:** https://dopeasset.com
- **Sui Overflow 2026 submission** — Agentic Web + DeFi & Payments tracks
