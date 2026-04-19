#!/usr/bin/env python3
"""
PACT Arbiter — AI-Verified Agent Commerce
MindsDB AI Agents Hack 2026 (April 20-26)

Credentials in .env:
  TOGETHER_API_KEY=<key from api.together.xyz>   # Required for together/simulate modes
  ANTHROPIC_API_KEY=<key>                        # Fallback for simulate mode (auto-loaded from env_export.py)
  MINDSDB_EMAIL=<cloud.mindsdb.com email>         # Required for mindsdb modes only
  MINDSDB_PASSWORD=<cloud.mindsdb.com password>   # Required for mindsdb modes only

Usage:
  # Quick start — no API keys needed beyond Anthropic (auto-configured):
  python pact-arbiter.py simulate          # Full simulation using best available AI

  # Together AI direct mode (requires TOGETHER_API_KEY):
  python pact-arbiter.py evaluate-direct   # Evaluate work via Together AI directly

  # Full MindsDB + on-chain modes (requires MindsDB Cloud account):
  python pact-arbiter.py setup             # Create MindsDB Llama model
  python pact-arbiter.py evaluate          # Test via MindsDB
  python pact-arbiter.py demo              # Full live demo on Arbitrum mainnet
"""

import os
import sys
import json
import hashlib
import asyncio
import time
from datetime import datetime

# Load .env
env_path = '/opt/praxis/.env'
with open(env_path) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k, v)

sys.path.insert(0, '/opt/praxis/venv/lib/python3.12/site-packages')

from web3 import Web3
import mindsdb_sdk


# ── Constants ──────────────────────────────────────────────────────────────────

RPC_URL = f"https://arbitrum-mainnet.infura.io/v3/{os.environ.get('INFURA_KEY_ID', '')}"
PACT_TOKEN = "0x809c2540358E2cF37050cCE41A610cb6CE66Abe1"
PACT_ESCROW_V2 = "0x220B97972d6028Acd70221890771E275e7734BFB"
GRANTS_WALLET = "0x8c08b6F98a6B7A9E7C4e3B1F0d5A2C9E4B3D1F08"  # fallback
CHAIN_ID = 42161  # Arbitrum One

# PactEscrow v2 ABI (minimal)
ESCROW_ABI = [
    {"name": "createPact", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"},
                {"name": "recipient", "type": "address"}, {"name": "deadline", "type": "uint256"},
                {"name": "jobSpecHash", "type": "bytes32"}], "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "submitWork", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "pactId", "type": "uint256"}, {"name": "workHash", "type": "bytes32"}], "outputs": []},
    {"name": "release", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "pactId", "type": "uint256"}], "outputs": []},
    {"name": "dispute", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "pactId", "type": "uint256"}], "outputs": []},
    {"name": "isReleaseable", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "pactId", "type": "uint256"}], "outputs": [{"name": "", "type": "bool"}]},
    {"name": "getPact", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "pactId", "type": "uint256"}],
     "outputs": [{"components": [
         {"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"},
         {"name": "creator", "type": "address"}, {"name": "recipient", "type": "address"},
         {"name": "deadline", "type": "uint256"}, {"name": "jobSpecHash", "type": "bytes32"},
         {"name": "workHash", "type": "bytes32"}, {"name": "status", "type": "uint8"},
         {"name": "createdAt", "type": "uint256"}, {"name": "workSubmittedAt", "type": "uint256"},
         {"name": "disputeWindowEnd", "type": "uint256"}, {"name": "releasedAt", "type": "uint256"}
     ], "name": "", "type": "tuple"}]},
    {"name": "nextPactId", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
]

# ERC-20 ABI (minimal — for approve)
ERC20_ABI = [
    {"name": "approve", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
    {"name": "balanceOf", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "account", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}]},
]

MODEL_NAME = "pact_llama_arbiter"
MINDSDB_CLOUD = "https://cloud.mindsdb.com"

QUALITY_THRESHOLD = 7  # out of 10


# ── MindsDB Setup ──────────────────────────────────────────────────────────────

def connect_mindsdb():
    email = os.environ.get("MINDSDB_EMAIL")
    password = os.environ.get("MINDSDB_PASSWORD")
    if not email or not password:
        raise ValueError("MINDSDB_EMAIL and MINDSDB_PASSWORD required in .env")
    print(f"Connecting to MindsDB Cloud as {email}...")
    server = mindsdb_sdk.connect(MINDSDB_CLOUD, login=email, password=password)
    print("Connected to MindsDB Cloud.")
    return server


def setup_model(server):
    """Create the Llama arbiter model in MindsDB."""
    together_key = os.environ.get("TOGETHER_API_KEY")
    if not together_key:
        raise ValueError("TOGETHER_API_KEY required in .env")

    print(f"Creating model '{MODEL_NAME}' in MindsDB...")
    query = f"""
    CREATE MODEL IF NOT EXISTS {MODEL_NAME}
    PREDICT quality_score
    USING
        engine = 'together_ai',
        model_name = 'meta-llama/Llama-3.1-70B-Instruct-Turbo',
        api_key = '{together_key}',
        prompt_template = '
You are a quality arbiter for AI agent work. Evaluate delivered work against the job specification.

Job specification: {{spec}}

Delivered work: {{work}}

Rate quality from 0-10:
- 10: Perfect match, exceeds expectations
- 7-9: Good quality, meets all key requirements
- 4-6: Partial match, missing important elements
- 0-3: Poor quality, fails to meet spec

Return ONLY valid JSON: {{"quality_score": <integer 0-10>, "reasoning": "<one sentence>", "pass": <true/false>}}
Do not include any text outside the JSON object.';
    """
    try:
        result = server.query(query).fetch()
        print(f"Model '{MODEL_NAME}' created successfully.")
        return result
    except Exception as e:
        if "already exists" in str(e).lower():
            print(f"Model '{MODEL_NAME}' already exists — reusing.")
        else:
            raise


def evaluate_work(server, spec: str, work: str) -> dict:
    """Ask MindsDB Llama arbiter to evaluate work quality."""
    # Escape quotes for SQL
    spec_escaped = spec.replace("'", "''")
    work_escaped = work.replace("'", "''")

    query = f"""
    SELECT quality_score, reasoning, pass
    FROM {MODEL_NAME}
    WHERE spec = '{spec_escaped}'
    AND work = '{work_escaped}'
    """
    print(f"\nQuerying MindsDB arbiter...")
    result = server.query(query).fetch()

    if result is None or len(result) == 0:
        raise ValueError("MindsDB returned empty result")

    row = result.iloc[0]
    quality = int(row.get('quality_score', 0))
    reasoning = str(row.get('reasoning', 'No reasoning provided'))
    passed = bool(row.get('pass', quality >= QUALITY_THRESHOLD))

    return {
        "quality_score": quality,
        "reasoning": reasoning,
        "pass": passed,
        "threshold": QUALITY_THRESHOLD
    }


# ── Web3 / On-Chain ────────────────────────────────────────────────────────────

def load_wallet():
    """Load treasury wallet via WalletManager."""
    sys.path.insert(0, '/opt/praxis')
    from wallet.manager import WalletManager
    wm = WalletManager()
    return wm


def get_w3():
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected():
        raise ConnectionError(f"Cannot connect to Arbitrum RPC: {RPC_URL}")
    return w3


def sha256_bytes32(text: str) -> bytes:
    """SHA256 hash of text, returned as bytes32."""
    return hashlib.sha256(text.encode()).digest()


def create_pact_escrow(w3, private_key: str, recipient: str, amount_pact: int,
                        job_spec: str, deadline_hours: int = 48) -> dict:
    """Create a PACT escrow on Arbitrum One."""
    account = w3.eth.account.from_key(private_key)
    escrow = w3.eth.contract(address=PACT_ESCROW_V2, abi=ESCROW_ABI)
    token = w3.eth.contract(address=PACT_TOKEN, abi=ERC20_ABI)

    amount_wei = amount_pact * (10 ** 18)
    deadline = int(time.time()) + (deadline_hours * 3600)
    job_hash = sha256_bytes32(job_spec)

    # Check PACT balance
    balance = token.functions.balanceOf(account.address).call()
    print(f"PACT balance: {balance / 1e18:.2f} PACT")
    if balance < amount_wei:
        raise ValueError(f"Insufficient PACT: have {balance/1e18:.2f}, need {amount_pact}")

    nonce = w3.eth.get_transaction_count(account.address)

    # Approve escrow
    print(f"Approving {amount_pact} PACT to PactEscrow...")
    approve_tx = token.functions.approve(PACT_ESCROW_V2, amount_wei).build_transaction({
        'from': account.address, 'nonce': nonce, 'chainId': CHAIN_ID,
        'gas': 100000, 'gasPrice': w3.eth.gas_price
    })
    signed_approve = w3.eth.account.sign_transaction(approve_tx, private_key)
    approve_hash = w3.eth.send_raw_transaction(signed_approve.raw_transaction)
    print(f"Approve TX: {approve_hash.hex()}")
    w3.eth.wait_for_transaction_receipt(approve_hash)

    # Create pact
    print(f"Creating pact: {amount_pact} PACT → {recipient}...")
    pact_tx = escrow.functions.createPact(
        PACT_TOKEN, amount_wei, recipient, deadline, job_hash
    ).build_transaction({
        'from': account.address, 'nonce': nonce + 1, 'chainId': CHAIN_ID,
        'gas': 200000, 'gasPrice': w3.eth.gas_price
    })
    signed_pact = w3.eth.account.sign_transaction(pact_tx, private_key)
    pact_hash = w3.eth.send_raw_transaction(signed_pact.raw_transaction)
    print(f"CreatePact TX: {pact_hash.hex()}")
    receipt = w3.eth.wait_for_transaction_receipt(pact_hash)

    # Get pact ID from nextPactId (it was nextPactId-1 at creation)
    next_id = escrow.functions.nextPactId().call()
    pact_id = next_id - 1

    print(f"Pact #{pact_id} created. Arbiscan: https://arbiscan.io/tx/{pact_hash.hex()}")
    return {"pact_id": pact_id, "tx": pact_hash.hex(), "job_hash": job_hash.hex()}


def submit_work_on_chain(w3, private_key: str, pact_id: int, work: str) -> dict:
    """Worker submits work hash on-chain."""
    account = w3.eth.account.from_key(private_key)
    escrow = w3.eth.contract(address=PACT_ESCROW_V2, abi=ESCROW_ABI)

    work_hash = sha256_bytes32(work)
    nonce = w3.eth.get_transaction_count(account.address)

    print(f"Submitting work hash for pact #{pact_id}...")
    tx = escrow.functions.submitWork(pact_id, work_hash).build_transaction({
        'from': account.address, 'nonce': nonce, 'chainId': CHAIN_ID,
        'gas': 150000, 'gasPrice': w3.eth.gas_price
    })
    signed = w3.eth.account.sign_transaction(tx, private_key)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"SubmitWork TX: {tx_hash.hex()}")
    w3.eth.wait_for_transaction_receipt(tx_hash)
    return {"tx": tx_hash.hex(), "work_hash": work_hash.hex()}


def release_pact(w3, private_key: str, pact_id: int) -> str:
    """Release pact payment (permissionless after dispute window)."""
    account = w3.eth.account.from_key(private_key)
    escrow = w3.eth.contract(address=PACT_ESCROW_V2, abi=ESCROW_ABI)

    nonce = w3.eth.get_transaction_count(account.address)
    tx = escrow.functions.release(pact_id).build_transaction({
        'from': account.address, 'nonce': nonce, 'chainId': CHAIN_ID,
        'gas': 150000, 'gasPrice': w3.eth.gas_price
    })
    signed = w3.eth.account.sign_transaction(tx, private_key)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"Release TX: {tx_hash.hex()}")
    w3.eth.wait_for_transaction_receipt(tx_hash)
    return tx_hash.hex()


def dispute_pact(w3, private_key: str, pact_id: int) -> str:
    """Dispute pact (caller must be creator, within dispute window)."""
    account = w3.eth.account.from_key(private_key)
    escrow = w3.eth.contract(address=PACT_ESCROW_V2, abi=ESCROW_ABI)

    nonce = w3.eth.get_transaction_count(account.address)
    tx = escrow.functions.dispute(pact_id).build_transaction({
        'from': account.address, 'nonce': nonce, 'chainId': CHAIN_ID,
        'gas': 150000, 'gasPrice': w3.eth.gas_price
    })
    signed = w3.eth.account.sign_transaction(tx, private_key)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"Dispute TX: {tx_hash.hex()}")
    w3.eth.wait_for_transaction_receipt(tx_hash)
    return tx_hash.hex()


# ── Demo Jobs ──────────────────────────────────────────────────────────────────

DEMO_JOBS = [
    {
        "name": "Arbitrum Governance Summary",
        "spec": "Summarize the Arbitrum DAO's core mission in exactly 3 bullet points. Each bullet must be under 20 words. Focus on decentralization, governance, and ecosystem growth.",
        "good_work": """
- Arbitrum DAO governs the Arbitrum ecosystem through community-driven, on-chain voting and proposals.
- Decentralization is core: token holders control protocol upgrades and treasury allocations directly.
- Ecosystem growth is funded via grants to builders creating DeFi, NFT, and infrastructure projects.
""",
        "bad_work": "Arbitrum is a blockchain. It has governance. People vote on things.",
    },
    {
        "name": "Smart Contract Code Review",
        "spec": "Review this Solidity function for security issues: 'function withdraw(uint amount) public { require(balances[msg.sender] >= amount); (bool success,) = msg.sender.call{value: amount}(\"\"); balances[msg.sender] -= amount; }'. List each vulnerability found.",
        "good_work": """
Critical vulnerability found: Reentrancy attack.

The balance is decremented AFTER the external call (msg.sender.call). An attacker can:
1. Call withdraw()
2. In their fallback, call withdraw() again before balance is updated
3. Drain the contract

Fix: Use checks-effects-interactions pattern — update balances[msg.sender] -= amount BEFORE the call.
Also: use ReentrancyGuard from OpenZeppelin.
""",
        "bad_work": "The function looks fine. It checks the balance before withdrawing.",
    },
    {
        "name": "Agent Commerce Research Brief",
        "spec": "Write a 2-paragraph brief explaining why trustless escrow is essential for AI agent commerce. Cover the trust problem between autonomous agents and how cryptographic commitment solves it.",
        "good_work": """
When two AI agents transact — one hiring, one working — neither has a human backing their commitments. An employer agent that releases payment before work is delivered loses funds irreversibly. A worker agent that delivers output before payment is locked risks getting nothing. Traditional escrow requires a trusted third party, but autonomous agents operate without human oversight, making human arbiters a bottleneck that breaks the economics of agent-to-agent commerce.

Trustless escrow solves this through cryptographic commitment: the employer locks payment in a smart contract with a hash of the job specification. The worker delivers output and submits a SHA256 hash of their work on-chain. An AI arbiter or keeper network verifies the hash matches the specification and triggers automatic payment release. Neither party can cheat: the employer cannot claw back locked funds, and the worker cannot claim payment without delivering a verifiable output. The contract enforces the agreement autonomously, creating commerce that scales beyond human bandwidth.
""",
        "bad_work": "Escrow is when you hold money. AI agents need this too.",
    }
]


# ── Main Demo ──────────────────────────────────────────────────────────────────

def run_evaluate_only():
    """Test MindsDB evaluation without on-chain transactions."""
    print("\n=== PACT Arbiter: Evaluation Mode ===\n")
    server = connect_mindsdb()

    job = DEMO_JOBS[0]
    print(f"Job: {job['name']}")
    print(f"Spec: {job['spec'][:100]}...")

    print("\n--- Testing GOOD work ---")
    result = evaluate_work(server, job['spec'], job['good_work'])
    print(f"Quality: {result['quality_score']}/10 | Pass: {result['pass']}")
    print(f"Reasoning: {result['reasoning']}")

    print("\n--- Testing BAD work ---")
    result = evaluate_work(server, job['spec'], job['bad_work'])
    print(f"Quality: {result['quality_score']}/10 | Pass: {result['pass']}")
    print(f"Reasoning: {result['reasoning']}")


def run_setup():
    """Set up MindsDB model."""
    print("\n=== PACT Arbiter: Setup ===\n")
    server = connect_mindsdb()
    setup_model(server)
    print("\nSetup complete. Run 'python pact-arbiter.py demo' for full demo.")


def run_demo():
    """Full end-to-end demo: escrow → work → evaluate → release/dispute."""
    print("\n" + "="*60)
    print("PACT Arbiter — AI-Verified Agent Commerce")
    print("MindsDB AI Agents Hack 2026")
    print("="*60 + "\n")

    # Setup
    server = connect_mindsdb()
    w3 = get_w3()
    print(f"Connected to Arbitrum One (chain {w3.eth.chain_id})\n")

    # Load treasury wallet for demo (creates and manages operational wallets)
    # NOTE: For hackathon demo, we use treasury wallet directly.
    # Treasury private key loaded via WalletManager.
    sys.path.insert(0, '/opt/praxis')
    from wallet.manager import WalletManager
    from wallet.tiers import WalletTier
    wm = WalletManager()

    # Get treasury wallet for demo
    treasury_info = wm.get_wallet(WalletTier.TREASURY)
    if not treasury_info:
        print("ERROR: Treasury wallet not available. Configure KEYSTORE_PASSPHRASE in .env.")
        return

    # For demo, buyer = treasury, worker = a fresh operational wallet
    buyer_key = wm.get_private_key(WalletTier.TREASURY)
    buyer_addr = w3.eth.account.from_key(buyer_key).address

    # Create worker wallet for demo
    worker_wallet = wm.create_operational(label="mindsdb-hack-worker")
    worker_addr = worker_wallet['address']
    worker_key = wm.get_private_key_by_address(worker_addr)

    print(f"Buyer (employer): {buyer_addr}")
    print(f"Worker address: {worker_addr}\n")

    # Pick a demo job
    job = DEMO_JOBS[0]
    print(f"Demo job: {job['name']}")
    print(f"Spec: {job['spec']}\n")

    # Worker "generates" work using Together AI (simulated for scaffold)
    work_output = job['good_work']
    print(f"Worker delivers work:\n{work_output.strip()}\n")

    # Step 1: Create escrow (employer locks 100 PACT)
    print("STEP 1: Employer locks 100 PACT in PactEscrow v2...")
    escrow_result = create_pact_escrow(
        w3, buyer_key, worker_addr,
        amount_pact=100, job_spec=job['spec'], deadline_hours=2
    )
    pact_id = escrow_result['pact_id']
    print(f"Pact #{pact_id} created.\n")

    # Step 2: Worker submits work hash on-chain
    print(f"STEP 2: Worker submits work commitment on-chain...")
    submit_result = submit_work_on_chain(w3, worker_key, pact_id, work_output)
    print(f"Work hash committed: {submit_result['work_hash'][:16]}...\n")

    # Step 3: MindsDB evaluates work quality
    print("STEP 3: MindsDB Llama arbiter evaluates work quality...")
    eval_result = evaluate_work(server, job['spec'], work_output)
    print(f"\nArbiter verdict:")
    print(f"  Quality score: {eval_result['quality_score']}/10")
    print(f"  Reasoning: {eval_result['reasoning']}")
    print(f"  Decision: {'RELEASE' if eval_result['pass'] else 'DISPUTE'}\n")

    # Step 4: Act on verdict
    if eval_result['pass']:
        print("STEP 4: Quality threshold met — releasing payment...")
        # Wait for dispute window (1 hour in prod, but for demo use isReleaseable)
        escrow_contract = w3.eth.contract(address=PACT_ESCROW_V2, abi=ESCROW_ABI)
        releaseable = escrow_contract.functions.isReleaseable(pact_id).call()
        if releaseable:
            tx = release_pact(w3, buyer_key, pact_id)
            print(f"Payment released! TX: {tx}")
            print(f"Arbiscan: https://arbiscan.io/tx/{tx}")
        else:
            print("Dispute window not yet elapsed. In production, keeper calls release() automatically.")
            print("For live demo: wait 1 hour or use keeper automation.")
    else:
        print("STEP 4: Quality below threshold — filing dispute...")
        tx = dispute_pact(w3, buyer_key, pact_id)
        print(f"Dispute filed! TX: {tx}")
        print(f"Arbiscan: https://arbiscan.io/tx/{tx}")

    print("\n" + "="*60)
    print("DEMO COMPLETE")
    print(f"Pact ID: #{pact_id}")
    print(f"Quality: {eval_result['quality_score']}/10 ({eval_result['reasoning']})")
    print(f"Outcome: {'PAYMENT RELEASED' if eval_result['pass'] else 'DISPUTED'}")
    print(f"Arbiscan: https://arbiscan.io/address/{PACT_ESCROW_V2}")
    print("="*60 + "\n")


# ── Together AI Direct Mode (no MindsDB account needed) ──────────────────────

def evaluate_work_direct(spec: str, work: str) -> dict:
    """Evaluate work quality via Together AI directly (OpenAI-compatible API).
    No MindsDB account required — works immediately with just TOGETHER_API_KEY.
    """
    together_key = os.environ.get("TOGETHER_API_KEY")
    if not together_key:
        raise ValueError("TOGETHER_API_KEY required in .env — get one free at api.together.xyz")

    from openai import OpenAI
    client = OpenAI(
        api_key=together_key,
        base_url="https://api.together.xyz/v1"
    )

    prompt = f"""You are a quality arbiter for AI agent work. Evaluate delivered work against the job specification.

Job specification: {spec}

Delivered work: {work}

Rate quality from 0-10:
- 10: Perfect match, exceeds expectations
- 7-9: Good quality, meets all key requirements
- 4-6: Partial match, missing important elements
- 0-3: Poor quality, fails to meet spec

Return ONLY valid JSON: {{"quality_score": <integer 0-10>, "reasoning": "<one sentence>", "pass": <true/false>}}
Do not include any text outside the JSON object."""

    print("Querying Together AI Llama 3.1 arbiter directly...")
    response = client.chat.completions.create(
        model="meta-llama/Llama-3.1-70B-Instruct-Turbo",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
        max_tokens=200,
    )

    raw = response.choices[0].message.content.strip()
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        # Try to extract JSON from response
        import re
        match = re.search(r'\{.*?\}', raw, re.DOTALL)
        if match:
            result = json.loads(match.group())
        else:
            raise ValueError(f"Could not parse arbiter response: {raw}")

    quality = int(result.get('quality_score', 0))
    return {
        "quality_score": quality,
        "reasoning": result.get('reasoning', 'No reasoning provided'),
        "pass": result.get('pass', quality >= QUALITY_THRESHOLD),
        "threshold": QUALITY_THRESHOLD,
        "mode": "together_direct"
    }


def run_evaluate_direct():
    """Test Together AI evaluation directly — no MindsDB account needed."""
    print("\n=== PACT Arbiter: Together AI Direct Mode ===")
    print("(No MindsDB account required)\n")

    job = DEMO_JOBS[0]
    print(f"Job: {job['name']}")
    print(f"Spec: {job['spec'][:100]}...\n")

    print("--- Testing GOOD work ---")
    result = evaluate_work_direct(job['spec'], job['good_work'])
    print(f"Quality: {result['quality_score']}/10 | Pass: {result['pass']}")
    print(f"Reasoning: {result['reasoning']}")

    print("\n--- Testing BAD work ---")
    result = evaluate_work_direct(job['spec'], job['bad_work'])
    print(f"Quality: {result['quality_score']}/10 | Pass: {result['pass']}")
    print(f"Reasoning: {result['reasoning']}")


def evaluate_work_anthropic(spec: str, work: str) -> dict:
    """Evaluate work quality via Anthropic Claude API (fallback when Together AI unavailable).
    Uses requests directly — no anthropic SDK required.
    """
    import urllib.request, urllib.error
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY not set — run /opt/praxis/env_export.py first")

    prompt = f"""You are a quality arbiter for AI agent work. Evaluate delivered work against the job specification.

Job specification: {spec}

Delivered work: {work}

Rate quality from 0-10:
- 10: Perfect match, exceeds expectations
- 7-9: Good quality, meets all key requirements
- 4-6: Partial match, missing important elements
- 0-3: Poor quality, fails to meet spec

Return ONLY valid JSON: {{"quality_score": <integer 0-10>, "reasoning": "<one sentence>", "pass": <true/false>}}
Do not include any text outside the JSON object."""

    print("Querying Claude arbiter (Anthropic fallback)...")
    payload = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 200,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())

    raw = data["content"][0]["text"].strip()
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        import re
        match = re.search(r'\{.*?\}', raw, re.DOTALL)
        if match:
            result = json.loads(match.group())
        else:
            raise ValueError(f"Could not parse arbiter response: {raw}")

    quality = int(result.get('quality_score', 0))
    return {
        "quality_score": quality,
        "reasoning": result.get('reasoning', 'No reasoning provided'),
        "pass": result.get('pass', quality >= QUALITY_THRESHOLD),
        "threshold": QUALITY_THRESHOLD,
        "mode": "anthropic_fallback"
    }


def best_available_evaluate(spec: str, work: str) -> dict:
    """Use the best available AI for evaluation: Together AI > Anthropic Claude."""
    together_key = os.environ.get("TOGETHER_API_KEY")
    if together_key:
        return evaluate_work_direct(spec, work)
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic_key:
        return evaluate_work_anthropic(spec, work)
    raise ValueError("No AI API key available. Set TOGETHER_API_KEY or ANTHROPIC_API_KEY in .env")


def run_simulate():
    """Full simulation: shows complete escrow → AI arbiter → release/dispute flow.
    Uses Together AI (preferred) or Anthropic Claude (fallback). No on-chain transactions.
    Perfect for demo recording before setting up MindsDB.
    """
    print("\n" + "="*60)
    print("PACT Arbiter — SIMULATION MODE")
    print("(AI-verified evaluation, no on-chain transactions)")
    print("="*60 + "\n")

    together_key = os.environ.get("TOGETHER_API_KEY")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if not together_key and not anthropic_key:
        print("ERROR: No AI API key configured.")
        print("  Option A (preferred): Get Together AI key at https://api.together.xyz/")
        print("             Then add: TOGETHER_API_KEY=your_key_here to .env")
        print("  Option B (fallback): Run /opt/praxis/env_export.py to load ANTHROPIC_API_KEY")
        return

    if not together_key:
        print("NOTE: Using Anthropic Claude as arbiter (TOGETHER_API_KEY not set)")
        print("      For MindsDB hackathon demo, add TOGETHER_API_KEY to .env\n")

    # Simulate all 3 demo jobs
    for i, job in enumerate(DEMO_JOBS):
        print(f"\n{'='*50}")
        print(f"JOB {i+1}: {job['name']}")
        print(f"{'='*50}")
        print(f"Spec: {job['spec'][:80]}...")

        simulated_pact_id = 42 + i  # Simulated pact ID
        simulated_amount = [100, 250, 500][i]
        work = job['good_work'] if i % 2 == 0 else job['bad_work']

        print(f"\nSIMULATED: Employer locks {simulated_amount} PACT in PactEscrow v2")
        print(f"  Contract: {PACT_ESCROW_V2}")
        print(f"  Pact ID: #{simulated_pact_id} (would be assigned on-chain)")
        print(f"  Job hash: {sha256_bytes32(job['spec']).hex()[:16]}...")

        print(f"\nWorker delivers work:")
        print(f"  {work.strip()[:150]}...")
        print(f"\nSIMULATED: Worker submits SHA256({sha256_bytes32(work.strip()).hex()[:16]}...) on-chain")

        print(f"\nMindsDB SQL would execute:")
        print(f"  SELECT quality_score FROM pact_llama_arbiter")
        print(f"  WHERE spec='{job['spec'][:50]}...'")
        print(f"  AND work='<delivered_output>'")
        arbiter_label = "Together AI Llama" if together_key else "Claude (Anthropic fallback)"
        print(f"\nQuerying {arbiter_label} arbiter...")

        result = best_available_evaluate(job['spec'], work)

        print(f"\nArbiter verdict:")
        print(f"  Quality: {result['quality_score']}/10 (threshold: {QUALITY_THRESHOLD})")
        print(f"  Reasoning: {result['reasoning']}")
        print(f"  Decision: {'✓ RELEASE PAYMENT' if result['pass'] else '✗ DISPUTE'}")

        if result['pass']:
            print(f"\nSIMULATED: PactEscrow.release({simulated_pact_id}) called")
            print(f"  {simulated_amount} PACT transferred to worker on Arbitrum One")
        else:
            print(f"\nSIMULATED: PactEscrow.dispute({simulated_pact_id}) called")
            print(f"  {simulated_amount} PACT held pending resolution")

    print(f"\n{'='*60}")
    print("SIMULATION COMPLETE")
    print("Live contracts (Arbitrum One):")
    print(f"  PactEscrow v2: {PACT_ESCROW_V2}")
    print(f"  PACT Token: {PACT_TOKEN}")
    print(f"  Arbiscan: https://arbiscan.io/address/{PACT_ESCROW_V2}")
    print("\nTo run LIVE demo with real on-chain transactions:")
    print("  1. Set MINDSDB_EMAIL + MINDSDB_PASSWORD in .env")
    print("  2. python pact-arbiter.py setup")
    print("  3. python pact-arbiter.py demo")
    print("="*60 + "\n")


# ── Entry Point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "simulate"

    if command == "setup":
        run_setup()
    elif command == "evaluate":
        run_evaluate_only()
    elif command == "demo":
        run_demo()
    elif command == "evaluate-direct":
        run_evaluate_direct()
    elif command == "simulate":
        run_simulate()
    else:
        print(f"Unknown command: {command}")
        print("Usage: python pact-arbiter.py [simulate|evaluate-direct|setup|evaluate|demo]")
        print("")
        print("Quick start (no MindsDB needed):")
        print("  python pact-arbiter.py simulate        # Full demo, no on-chain txs")
        print("  python pact-arbiter.py evaluate-direct # AI evaluation only")
        print("")
        print("Full hackathon demo (requires MindsDB account):")
        print("  python pact-arbiter.py setup           # Create MindsDB model")
        print("  python pact-arbiter.py evaluate        # Test via MindsDB")
        print("  python pact-arbiter.py demo            # Live Arbitrum mainnet")
        sys.exit(1)
