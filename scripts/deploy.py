#!/usr/bin/env python3
"""Compile and deploy PactPaymentChannel contract to Arbitrum One.

Usage:
    python3 scripts/deploy.py [--dry-run]
"""

import argparse
import json
import os
from web3 import Web3
from eth_account import Account
from dotenv import load_dotenv
import solcx

load_dotenv("/opt/praxis/.env")

try:
    solcx.get_solc_version()
except Exception:
    solcx.install_solc("0.8.20")

solcx.set_solc_version("0.8.20")

PACT_TOKEN = "0x809c2540358E2cF37050cCE41A610cb6CE66Abe1"


def main():
    parser = argparse.ArgumentParser(description="Deploy PactPaymentChannel to Arbitrum One")
    parser.add_argument("--dry-run", action="store_true", help="Compile only, don't deploy")
    args = parser.parse_args()

    RPC_URL = f"https://arbitrum-mainnet.infura.io/v3/{os.environ['INFURA_KEY_ID']}"
    PRIVATE_KEY = os.environ["ETHEREUM_WALLET_PRIVATE_KEY"]

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    account = Account.from_key(PRIVATE_KEY)
    WALLET = account.address
    print(f"Wallet: {WALLET}")
    print(f"ETH balance: {w3.from_wei(w3.eth.get_balance(WALLET), 'ether'):.6f}")

    # Compile
    print("\nCompiling PactPaymentChannel.sol...")
    contract_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "contracts", "PactPaymentChannel.sol")
    with open(contract_path) as f:
        source = f.read()

    compiled = solcx.compile_source(source, output_values=["abi", "bin"], solc_version="0.8.20")
    contract_key = [k for k in compiled.keys() if "PactPaymentChannel" in k][0]
    abi = compiled[contract_key]["abi"]
    bytecode = compiled[contract_key]["bin"]
    print(f"Compiled. Bytecode: {len(bytecode)} chars")

    abi_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "abi", "PactPaymentChannel.json")
    with open(abi_path, "w") as f:
        json.dump(abi, f, indent=2)
    print("ABI saved to abi/PactPaymentChannel.json")

    if args.dry_run:
        print(f"\n[DRY RUN] Would deploy PactPaymentChannel(pactToken={PACT_TOKEN})")
        print("Exiting without deploying.")
        return

    # Deploy
    print(f"\nDeploying PactPaymentChannel(pactToken={PACT_TOKEN})...")
    contract = w3.eth.contract(abi=abi, bytecode=bytecode)
    constructor_tx = contract.constructor(PACT_TOKEN).build_transaction({
        "from": WALLET,
        "nonce": w3.eth.get_transaction_count(WALLET),
        "chainId": 42161,
        "maxFeePerGas": w3.eth.gas_price * 2,
        "maxPriorityFeePerGas": w3.to_wei(0.01, "gwei"),
    })

    signed = account.sign_transaction(constructor_tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"TX: {tx_hash.hex()}")

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    print(f"Status: {'SUCCESS' if receipt.status == 1 else 'FAILED'}")
    print(f"Gas used: {receipt.gasUsed}")
    print(f"Contract: {receipt.contractAddress}")

    if receipt.status == 1:
        print(f"\n{'='*60}")
        print(f"PactPaymentChannel deployed: {receipt.contractAddress}")
        print(f"PACT token: {PACT_TOKEN}")
        print(f"Challenge period: 1 hour")
        print(f"{'='*60}")
        print(f"\nArbiscan: https://arbiscan.io/address/{receipt.contractAddress}")

        eth_bal = w3.eth.get_balance(WALLET)
        print(f"\nWallet ETH remaining: {w3.from_wei(eth_bal, 'ether'):.6f}")


if __name__ == "__main__":
    main()
