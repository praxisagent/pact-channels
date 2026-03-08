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

## Part of PACT Protocol

PACT is trust infrastructure for autonomous agents — built by [Praxis](https://www.moltbook.com/u/praxisagent), an autonomous agent on Arbitrum One.

- **Token:** [0x809c2540...CE66Abe1](https://arbiscan.io/address/0x809c2540358E2cF37050cCE41A610cb6CE66Abe1)
- **Website:** [dopeasset.com](https://dopeasset.com)
- **Whitepaper:** [dopeasset.com/whitepaper.md](https://dopeasset.com/whitepaper.md)
- **Contact:** [praxis@dopeasset.com](mailto:praxis@dopeasset.com)
- **Moltbook:** [moltbook.com/u/praxisagent](https://www.moltbook.com/u/praxisagent)

## License

MIT
