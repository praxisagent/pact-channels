#!/usr/bin/env python3
"""
PACT Auto-Release Keeper — ETHGlobal Open Agents 2026
KeeperHub Track ($5,000)

Monitors PactEscrow v2 on Arbitrum One.
When isReleaseable(pactId) returns true, calls release(pactId).
This is a standalone keeper script — can also be configured as a KeeperHub workflow.

Usage:
    python pact_keeper.py                    # Watch all pacts, dry-run
    python pact_keeper.py --execute          # Actually call release()
    python pact_keeper.py --pact-id 10      # Monitor specific pact

Environment:
    KEEPER_PRIVATE_KEY  — wallet that pays gas for release() calls (no funds at risk)
    RPC_URL             — Arbitrum One RPC endpoint
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

# Add venv to path
sys.path.insert(0, '/opt/praxis/venv/lib/python3.12/site-packages')

from web3 import Web3
from eth_account import Account

# ─── Contract Addresses ──────────────────────────────────────────────────────

PACT_ESCROW_V2 = "0x220B97972d6028Acd70221890771E275e7734BFB"
PACT_TOKEN     = "0x809c2540358E2cF37050cCE41A610cb6CE66Abe1"

# ─── Minimal ABI ─────────────────────────────────────────────────────────────

ESCROW_ABI = [
    {
        "name": "nextPactId",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}]
    },
    {
        "name": "isReleaseable",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "pactId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bool"}]
    },
    {
        "name": "getPact",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "pactId", "type": "uint256"}],
        "outputs": [{
            "name": "",
            "type": "tuple",
            "components": [
                {"name": "creator",           "type": "address"},
                {"name": "recipient",         "type": "address"},
                {"name": "arbitrator",        "type": "address"},
                {"name": "amount",            "type": "uint256"},
                {"name": "arbitratorFee",     "type": "uint256"},
                {"name": "deadline",          "type": "uint256"},
                {"name": "disputeWindow",     "type": "uint256"},
                {"name": "arbitrationWindow", "type": "uint256"},
                {"name": "workSubmittedAt",   "type": "uint256"},
                {"name": "disputeRaisedAt",   "type": "uint256"},
                {"name": "workHash",          "type": "bytes32"},
                {"name": "status",            "type": "uint8"}
            ]
        }]
    },
    {
        "name": "release",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "pactId", "type": "uint256"}],
        "outputs": []
    },
    {
        "name": "PactReleased",
        "type": "event",
        "inputs": [
            {"name": "pactId",    "type": "uint256", "indexed": True},
            {"name": "recipient", "type": "address", "indexed": True},
            {"name": "amount",    "type": "uint256", "indexed": False}
        ]
    }
]

# Status enum
STATUS = {0: "Open", 1: "WorkSubmitted", 2: "Disputed", 3: "Complete", 4: "Reclaimed"}

# ─── Main Keeper Logic ────────────────────────────────────────────────────────

def load_env():
    env = {}
    env_path = '/opt/praxis/.env'
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k] = v
    return env


def connect(env):
    rpc = env.get('RPC_URL') or f"https://arbitrum-mainnet.infura.io/v3/{env.get('INFURA_KEY_ID', '')}"
    w3 = Web3(Web3.HTTPProvider(rpc))
    if not w3.is_connected():
        raise RuntimeError(f"Cannot connect to RPC: {rpc}")
    return w3


def scan_pacts(w3, escrow, specific_pact_id=None):
    """Scan all pacts and return list of (pactId, pact) tuples for releaseable ones."""
    total = escrow.functions.nextPactId().call()
    print(f"[{ts()}] Scanning {total} pacts on PactEscrow v2...")

    releaseable = []
    pact_range = [specific_pact_id] if specific_pact_id is not None else range(total)

    for pact_id in pact_range:
        try:
            pact = escrow.functions.getPact(pact_id).call()
            status_str = STATUS.get(pact[11], f"Unknown({pact[11]})")

            if pact[11] == 1:  # WorkSubmitted
                is_rel = escrow.functions.isReleaseable(pact_id).call()
                work_submitted_at = pact[8]
                dispute_window = pact[6]
                seconds_remaining = (work_submitted_at + dispute_window) - int(time.time())

                if is_rel:
                    print(f"  Pact #{pact_id}: RELEASEABLE — {w3.from_wei(pact[3], 'ether'):.0f} PACT → {pact[1][:10]}...")
                    releaseable.append((pact_id, pact))
                else:
                    print(f"  Pact #{pact_id}: WorkSubmitted, {seconds_remaining}s until releaseable")
            else:
                print(f"  Pact #{pact_id}: {status_str}")
        except Exception as e:
            print(f"  Pact #{pact_id}: error — {e}")

    return releaseable


def execute_release(w3, escrow, pact_id, keeper_key):
    """Call release(pactId) and return transaction hash."""
    keeper = Account.from_key(keeper_key)
    nonce = w3.eth.get_transaction_count(keeper.address)
    gas_price = w3.eth.gas_price

    tx = escrow.functions.release(pact_id).build_transaction({
        'from': keeper.address,
        'nonce': nonce,
        'gas': 100000,
        'gasPrice': gas_price,
        'chainId': 42161
    })

    signed = keeper.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)

    return tx_hash.hex(), receipt.status == 1


def ts():
    return datetime.now(timezone.utc).strftime("%H:%M:%S UTC")


def run_keeper(args):
    env = load_env()
    w3 = connect(env)
    escrow = w3.eth.contract(
        address=Web3.to_checksum_address(PACT_ESCROW_V2),
        abi=ESCROW_ABI
    )

    keeper_key = args.keeper_key or env.get('KEEPER_PRIVATE_KEY')
    if args.execute and not keeper_key:
        print("ERROR: --execute requires KEEPER_PRIVATE_KEY in env or --keeper-key argument")
        sys.exit(1)

    print(f"\n{'='*60}")
    print(f"PACT Auto-Release Keeper")
    print(f"Contract: {PACT_ESCROW_V2}")
    print(f"Mode: {'EXECUTE' if args.execute else 'DRY-RUN'}")
    print(f"{'='*60}\n")

    while True:
        releaseable = scan_pacts(w3, escrow, args.pact_id)

        if not releaseable:
            print(f"[{ts()}] No releaseable pacts found.\n")
        else:
            print(f"\n[{ts()}] Found {len(releaseable)} releaseable pact(s):")
            for pact_id, pact in releaseable:
                amount_pact = w3.from_wei(pact[3], 'ether')
                print(f"\n  Pact #{pact_id}")
                print(f"    Creator:   {pact[0]}")
                print(f"    Recipient: {pact[1]}")
                print(f"    Amount:    {amount_pact:.4f} PACT")

                if args.execute:
                    print(f"    Calling release({pact_id})...")
                    try:
                        tx_hash, success = execute_release(w3, escrow, pact_id, keeper_key)
                        if success:
                            print(f"    SUCCESS: {tx_hash}")
                            print(f"    Arbiscan: https://arbiscan.io/tx/0x{tx_hash}")
                        else:
                            print(f"    FAILED: {tx_hash}")
                    except Exception as e:
                        print(f"    ERROR: {e}")
                else:
                    print(f"    [DRY-RUN] Would call release({pact_id})")
            print()

        if not args.loop:
            break

        interval = args.interval or 300
        print(f"[{ts()}] Sleeping {interval}s until next check...\n")
        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser(description='PACT Auto-Release Keeper')
    parser.add_argument('--execute', action='store_true',
                        help='Actually call release() (default: dry-run)')
    parser.add_argument('--pact-id', type=int, default=None,
                        help='Monitor specific pact ID only')
    parser.add_argument('--loop', action='store_true',
                        help='Run continuously (default: single scan)')
    parser.add_argument('--interval', type=int, default=300,
                        help='Seconds between checks when --loop (default: 300)')
    parser.add_argument('--keeper-key', type=str, default=None,
                        help='Private key for keeper wallet (or set KEEPER_PRIVATE_KEY env)')
    args = parser.parse_args()
    run_keeper(args)


if __name__ == '__main__':
    main()
