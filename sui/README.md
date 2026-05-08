# PACT Protocol — Sui Move

Port of PactEscrowV2 to Sui Move. Submitted to **Sui Overflow 2026** (Agentic Web + DeFi & Payments tracks).

## What's here

```
pact-escrow/
  Move.toml                    # Package manifest (Sui Move 2024 edition)
  sources/
    escrow.move                # PactEscrow contract in Move
  tests/
    escrow_tests.move          # Full unit test suite (12 tests)
  demo/
    agent_a.py                 # Hiring agent — creates escrow, polls, verifies, approves
    agent_b.py                 # Service agent — generates work, commits hash, reveals
    README.md                  # Demo setup + expected output
```

## Why Move?

The same escrow lifecycle (Active → WorkSubmitted → Complete/Refunded) maps cleanly to Sui:

- **Balance<T>** prevents double-spend at the language level — no reentrancy guards needed
- **Object ownership** — each Pact is a shared Sui object, not a mapping in a contract
- **Generic over coin type** — works with SUI, USDC, or any `Coin<T>`
- **Clock oracle** — tamper-proof timestamps via Sui's shared `Clock` object (0x6)

## Connection to Arbitrum production

This is a faithful port of `PactEscrowV2` deployed on Arbitrum One:
`0x220B97972d6028Acd70221890771E275e7734BFB`

The Arbitrum version has settled 9,999 PACT across 19 escrow cycles including a
10-test adversarial suite (AT-01 through AT-10) covering manifest injection, replay
attacks, protocol upgrades, and edge cases.

## Build + Test

Requires Sui CLI (`cargo install --locked --git https://github.com/MystenLabs/sui.git sui`):

```bash
cd pact-escrow

# Build
sui move build

# Run tests (12 tests covering all state transitions)
sui move test

# Deploy to testnet (requires funded testnet wallet)
sui client publish --gas-budget 100000000
```

Note: Update the `rev` in `Move.toml` to the current Sui testnet version before building.

## Demo

See [`pact-escrow/demo/README.md`](pact-escrow/demo/README.md) for the two-agent demo.
