# PACT Arbiter — MindsDB AI Agents Hack

**Tagline:** MindsDB as the judge. PACT as the bank. First system where an AI model determines whether to release a blockchain payment.

## Quick Start

### Prerequisites (add to .env)
```
MINDSDB_EMAIL=<email at cloud.mindsdb.com>
MINDSDB_PASSWORD=<password at cloud.mindsdb.com>
TOGETHER_API_KEY=<key from api.together.xyz>
```

### Run

```bash
cd /opt/praxis

# Step 1: Create MindsDB model (one-time setup)
python grants/mindsdb-hack/pact-arbiter.py setup

# Step 2: Test evaluation only (no on-chain transactions)
python grants/mindsdb-hack/pact-arbiter.py evaluate

# Step 3: Full live demo (creates real pact on Arbitrum mainnet)
python grants/mindsdb-hack/pact-arbiter.py demo
```

## Architecture

```
Buyer Agent                    Worker Agent
    │ Lock 100 PACT                  │ Deliver work
    │ in PactEscrow v2               │ Submit SHA256 hash
    │ (Arbitrum One)                 │ on-chain
    └──────────────┬─────────────────┘
                   │
                   ▼
         MindsDB Llama Arbiter
         (Together AI Llama 3.1)
         quality_score >= 7?
                   │
           ┌───────┴───────┐
          YES              NO
           │               │
      release()        dispute()
      (payment         (funds held
       to worker)       pending)
```

## Prize Tracks
- Main prize ($10K pool)
- Best Use of Llama ($3K + $100K impact grant path)
- Best Use of Together AI ($2.5K)

## Live Contracts (Arbitrum One)
- PactEscrow v2: `0x220B97972d6028Acd70221890771E275e7734BFB`
- PACT Token: `0x809c2540358E2cF37050cCE41A610cb6CE66Abe1`
- PACT/USDC Pool: `0x56bB49BEfB7968BeCB6c37C0CE9A5aA2b6105B08`

## Demo Jobs
Three pre-built jobs in `pact-arbiter.py` → `DEMO_JOBS`:
1. Arbitrum Governance Summary (good vs bad work comparison)
2. Smart Contract Security Review (reentrancy detection)
3. Agent Commerce Research Brief

## Status
- MindsDB SDK installed: mindsdb_sdk v3.5.0
- Web3.py: installed, Infura RPC configured
- PactEscrow v2: live, 3 production cycles (9,999 PACT)
- Waiting for: MINDSDB_EMAIL, MINDSDB_PASSWORD, TOGETHER_API_KEY in .env
