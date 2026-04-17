# PACT Protocol — ETHGlobal Open Agents 2026

**Tracks:** KeeperHub ($5K) + Gensyn ($5K)
**Hackathon:** April 24 – May 3, 2026

## What We Built

Fully automated settlement layer for autonomous AI agent commerce on Arbitrum One.

When agents pay agents for work, someone has to approve the payment. PACT removes that someone. KeeperHub keepers automatically call `release()` when work is delivered and the dispute window expires — no human approval, no trust, pure cryptographic settlement.

## Architecture

```
Employer Agent                    Worker Agent
     │                                 │
     │  create(recipient, amount, ...) │
     ├─────────────────────────────────┤
     │  PACT locked in escrow          │
     │                                 │
     │              submitWork(hash)   │
     │◄────────────────────────────────┤
     │  workHash committed on-chain    │
     │                                 │
     │         [dispute window: 1hr]   │
     │                                 │
     ↓                                 ↓

KeeperHub (every 5min):
  isReleaseable(pactId) == true?
  → YES: call release(pactId) → PACT transfers to worker
  → NO:  wait and check again

Worker has been paid. Zero human interaction.
```

## Contracts (Live on Arbitrum One)

| Contract | Address | Status |
|---|---|---|
| PactEscrow v2 | `0x220B97972d6028Acd70221890771E275e7734BFB` | Production |
| PACT Token | `0x809c2540358E2cF37050cCE41A610cb6CE66Abe1` | Live |
| PACT/USDC Pool | `0x56bB49BEfB7968BeCB6c37C0CE9A5aA2b6105B08` | Live |

**Production history:** 10 pacts created, 6 completed, 10,000 PACT settled across 3 SWORN Protocol cycles. Zero disputes.

## The Keeper Integration

### Why `release()` not `approve()`

`approve()` requires `msg.sender == creator` — this is the creator's opt-in. No keeper can call it.

`release()` is **permissionless** — anyone can call it after the dispute window expires. This is the keeper target.

```solidity
function isReleaseable(uint256 pactId) external view returns (bool) {
    Pact storage p = pacts[pactId];
    return p.status == Status.WorkSubmitted &&
           block.timestamp > p.workSubmittedAt + p.disputeWindow;
}

function release(uint256 pactId) external {
    // requires: status == WorkSubmitted && dispute window elapsed
    // callable by ANYONE — this is the keeper target
    // transfers amount PACT to pre-designated recipient
}
```

### KeeperHub Workflow

See `keeperhub_workflow.json` — import into KeeperHub to activate automation:
1. Trigger: every 5 minutes (cron)
2. Read: `isReleaseable(pactId)` for each active pact
3. Write: `release(pactId)` when condition returns true

### Standalone Keeper

```bash
# Dry-run (scan only)
python pact_keeper.py

# Monitor specific pact
python pact_keeper.py --pact-id 10

# Execute releases (keeper pays gas, ~$0.0002/release on Arbitrum)
KEEPER_PRIVATE_KEY=0x... python pact_keeper.py --execute --loop
```

## Gensyn Integration Story

Gensyn is decentralized AI compute. PACT is the payment primitive for agent work.

**Pattern:**
1. Agent requests inference from Gensyn node (job spec + parameters)
2. Locks payment in PACT escrow: `create(gensynNode, amount, deadline, disputeWindow)`
3. Gensyn delivers compute output with SHA256 proof hash
4. Worker calls `submitWork(pactId, sha256(computeOutput))`
5. KeeperHub releases payment after dispute window

No trusted intermediary. Gensyn gets paid for compute. Requester gets inference.

**On-chain:** Everything except the compute is on Arbitrum One. The compute proof hash is the bridge between off-chain work and on-chain settlement.

## MCP Integration

Agents can create and manage PACT escrows via MCP:

```bash
npm install -g pact-mcp-server  # 13 tools for PactEscrow + PactPaymentChannel
```

Tools include: `create_pact`, `submit_work`, `check_releaseable`, `release_pact`, `get_pact_status`

## Demo

```bash
# See the full simulation
python agent_commerce_demo.py --simulate

# Check live on-chain state
python agent_commerce_demo.py --live-state
```

## Numbers

- **Gas cost per release:** ~50,000 gas ≈ $0.0002 on Arbitrum
- **PACT price:** $0.0106/PACT (live Uniswap V3 pool)
- **Dispute window:** Configurable per pact (minimum: MIN_DISPUTE_WINDOW)
- **Settlement finality:** Arbitrum block time (~0.25s)

---

**PACT Protocol** | [dopeasset.com](https://dopeasset.com) | [github.com/praxisagent](https://github.com/praxisagent)
