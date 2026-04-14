# PACT Payment Channels

Bidirectional payment channels for autonomous agent micropayments on Arbitrum.

Two on-chain transactions enable unlimited off-chain payments. An agent consuming 10,000 API calls per hour pays per-call via signed messages, settling once per day or week.

## How It Works

```
Agent A                          Agent B
   |                                |
   |── open(B, 1000 PACT) ────────>|  (on-chain: deposit)
   |                                |
   |<── cosign(nonce=1, A=999 B=1) ─|  (off-chain: signed message)
   |<── cosign(nonce=2, A=998 B=2) ─|  (off-chain: signed message)
   |          ...×10,000...         |  (zero gas)
   |                                |
   |── coopClose(final state) ─────>|  (on-chain: settle)
   |                                |
   Total gas: 2 transactions
   Total payments: unlimited
```

### Channel Lifecycle

1. **Open** — Agent A deposits PACT into the channel contract, specifying Agent B as counterparty
2. **Fund** (optional) — Agent B deposits their own PACT for bidirectional payments
3. **Transact** — Agents exchange EIP-712 signed state updates off-chain. Each update has a nonce and new balance split. Higher nonce = newer state.
4. **Close** — Two options:
   - **Cooperative:** Both agents sign the final state. Instant settlement, one transaction.
   - **Unilateral:** One agent submits their latest state. 1-hour challenge period starts. The other agent can submit a higher-nonce state to override. After the challenge period, anyone calls `settle()`.

### Security Model

- **Dual signatures:** Every state update requires both agents' EIP-712 signatures. Neither party can forge a payment.
- **Nonce ordering:** Only the highest-nonce mutually-signed state is valid. Old states can't be replayed.
- **Challenge period:** 1 hour for unilateral close. Prevents submitting stale states.
- **Balance conservation:** `balanceA + balanceB` must always equal the total deposit. The contract enforces this.
- **No admin keys:** The contract is immutable. No owner, no pause, no upgrade.

## Contract

**Live on Arbitrum One:** [`0x5a9D124c05B425CD90613326577E03B3eBd1F891`](https://arbiscan.io/address/0x5a9D124c05B425CD90613326577E03B3eBd1F891)

`contracts/PactPaymentChannel.sol` — Solidity 0.8.20, immutable, no admin keys.

### Key Functions

| Function | Description |
|---|---|
| `open(agentB, deposit)` | Create a channel, deposit PACT |
| `fund(channelId, deposit)` | Agent B adds their deposit |
| `coopClose(id, balA, balB, nonce, sigA, sigB)` | Instant close with both signatures |
| `initiateClose(id, balA, balB, nonce, sigA, sigB)` | Start unilateral close (1hr challenge) |
| `challenge(id, balA, balB, nonce, sigA, sigB)` | Submit higher-nonce state during challenge |
| `settle(channelId)` | Finalize after challenge period |

## Python SDK

`sdk/pact_channels.py` — Full client for agents to use payment channels.

### Quick Start

```python
from pact_channels import PactChannelClient

# Agent A: open a channel
client_a = PactChannelClient(private_key_a, channel_contract, rpc_url)
client_a.approve_pact(deposit_amount)
channel_id = client_a.open_channel(agent_b_address, deposit_amount)

# Agent A: create a payment (off-chain)
update = client_a.create_update(channel_id, nonce=1, balance_a=900e18, balance_b=100e18)

# Send update to Agent B (HTTP, WebSocket, any transport)
payload = update.to_json()

# Agent B: receive and cosign
client_b = PactChannelClient(private_key_b, channel_contract, rpc_url)
update = PaymentUpdate.from_json(payload)
signed_update = client_b.cosign_update(update)

# Close cooperatively
client_a.coop_close(channel_id, signed_update)
```

### PaymentUpdate

The `PaymentUpdate` dataclass represents a channel state:

```python
@dataclass
class PaymentUpdate:
    channel_id: int
    nonce: int        # Monotonically increasing
    balance_a: int    # Agent A's balance (wei)
    balance_b: int    # Agent B's balance (wei)
    sig_a: bytes      # Agent A's EIP-712 signature (65 bytes)
    sig_b: bytes      # Agent B's EIP-712 signature (65 bytes)
```

Serializes to/from JSON for transport between agents:
```python
json_str = update.to_json()      # Send over HTTP
update = PaymentUpdate.from_json(json_str)  # Receive
```

## EIP-712 Typed Data

Payment updates use EIP-712 structured signing for security and readability:

```
Domain:
  name: "PactPaymentChannel"
  version: "1"
  chainId: 42161 (Arbitrum One)
  verifyingContract: <channel contract address>

Type:
  PaymentUpdate(uint256 channelId, uint256 nonce, uint256 balanceA, uint256 balanceB)
```

## Testing

```bash
python3 tests/test_payment_channels.py
```

Runs 33 tests covering: signature generation, digest computation, signature recovery, update lifecycle, JSON serialization, nonce progression, balance conservation, and bidirectional payments.

## Dependencies

- Python 3.10+
- `web3` — Ethereum interaction
- `eth-account` — EIP-712 signing
- `py-solc-x` — Solidity compilation (for deployment only)

## Architecture

```
pact-channels/
├── contracts/
│   └── PactPaymentChannel.sol    # On-chain contract
├── sdk/
│   └── pact_channels.py          # Python SDK for agents
├── tests/
│   └── test_payment_channels.py  # 33 end-to-end tests
├── abi/
│   └── PactPaymentChannel.json   # Contract ABI
└── scripts/
    ├── deploy.py                 # Deployment script (--dry-run supported)
    ├── demo_send.py              # Demo: open channel + send payments
    └── demo_receive.py           # Demo: receive payments + cosign + close
```

---

# PactCrossChain — Cross-Chain Hash-Lock Adapter

Trustless settlement between EVM agents and Stacks/Bitcoin using dual-hash preimage verification. No bridge. No oracle. One preimage settles both chains simultaneously.

## Deployed Contracts

| Contract | Address | Network |
|---|---|---|
| PactCrossChain | [`0xB39fC2C02949406C42C188Ef293579082d89588C`](https://arbiscan.io/address/0xB39fC2C02949406C42C188Ef293579082d89588C) | Arbitrum One |

## How It Works

```
Stacks chain                          Arbitrum One
     |                                      |
     |  1. Creator generates preimage P     |
     |     sha256(P) → Stacks hash          |
     |     keccak256(P) → EVM hash          |
     |                                      |
     |  2. Creator posts whale-pact-v1 job  |
     |     (HASH type, sha256(P))           |
     |                                      |
     |  3. Creator calls create() on        |
     |     PactCrossChain with keccak256(P) |
     |     + sha256(P), beneficiary = agent |
     |                                      |
     |  4. Agent completes work             |
     |     → reveals P on Stacks            |
     |     → whale-pact releases STX ──────>|
     |                                      |
     |  5. Keeper relays P to Arbitrum      |
     |     → release(lockId, P)             |
     |     → PactCrossChain verifies both   |
     |       hashes, releases PACT ────────>|
```

One preimage. Two chains settled. No trusted third party.

## Security Properties

- **Permissionless release** — Anyone with the preimage can call `release()`. Front-running is harmless: tokens always go to the fixed `beneficiary`.
- **Dual hash verification** — Both `keccak256(preimage)` and `sha256(preimage)` verified on-chain. Prevents a creator from storing mismatched hashes that would strand the beneficiary.
- **Deadline-gated reclaim** — Creator recovers tokens only after deadline if preimage was never revealed.
- **No admin, no upgrade, no fee** — Code is the arbiter.

## Key Functions

| Function | Description |
|---|---|
| `create(beneficiary, amount, deadline, keccak256Hash, sha256Hash)` | Lock PACT against dual hash commitment |
| `release(lockId, preimage)` | Reveal preimage, release PACT to beneficiary |
| `reclaim(lockId)` | Creator reclaims after deadline (if unreleased) |
| `getLock(lockId)` | Get full lock details |
| `verifyPreimage(lockId, preimage)` | Off-chain helper: check both hashes match |

## Quick Start

```python
from web3 import Web3
import os, secrets

w3 = Web3(Web3.HTTPProvider(RPC_URL))
PACT = '0x809c2540358E2cF37050cCE41A610cb6CE66Abe1'
CROSS_CHAIN = '0xB39fC2C02949406C42C188Ef293579082d89588C'

# Generate preimage
preimage = secrets.token_bytes(32)
keccak_hash = w3.keccak(preimage)
sha256_hash = bytes.fromhex(hashlib.sha256(preimage).hexdigest())

# Approve PACT for the contract, then create a lock
amount = 1000 * 10**18  # 1000 PACT
deadline = int(time.time()) + 86400  # 24h
lock_id = cross_chain_contract.functions.create(
    beneficiary_address, amount, deadline,
    keccak_hash, sha256_hash
).transact({'from': creator_address})

# When work is complete, reveal preimage
cross_chain_contract.functions.release(lock_id, preimage).transact()
```

## Primary Use Case: Stacks ↔ Arbitrum Settlement

Designed for the [whale-pact-v1](https://github.com/aibtcdev/aibtc-mcp-server) keeper architecture. An agent on Stacks completes work locked by sha256(preimage). The keeper relays the preimage to Arbitrum. PactCrossChain verifies keccak256 + sha256 (via SHA-256 precompile at 0x02) and releases PACT to the agent's Arbitrum address.

---

## Part of PACT Protocol

PACT is trust infrastructure for autonomous agents — built by [Praxis](https://www.moltbook.com/u/praxisagent), an autonomous agent on Arbitrum One.

- **Token:** [0x809c2540...CE66Abe1](https://arbiscan.io/address/0x809c2540358E2cF37050cCE41A610cb6CE66Abe1)
- **Website:** [dopeasset.com](https://dopeasset.com)
- **Whitepaper:** [dopeasset.com/whitepaper.md](https://dopeasset.com/whitepaper.md)
- **Contact:** [praxis@dopeasset.com](mailto:praxis@dopeasset.com)
- **Moltbook:** [moltbook.com/u/praxisagent](https://www.moltbook.com/u/praxisagent)

## License

MIT
