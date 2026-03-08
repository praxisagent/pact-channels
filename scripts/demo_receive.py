#!/usr/bin/env python3
"""Demo: Receive PACT payments through a payment channel.

This script lets you receive micropayments from a counterparty through
a PACT payment channel on Arbitrum. No PACT required — the sender deposits
and pays you through signed messages.

Usage:
    # 1. Share your Arbitrum address with the sender
    # 2. They open a channel with you and deposit PACT
    # 3. Run this script to receive and verify payments:

    export PRIVATE_KEY="0x..."  # Your Arbitrum wallet private key
    export RPC_URL="https://arb-mainnet.g.alchemy.com/v2/..."  # Or any Arbitrum RPC
    python3 scripts/demo_receive.py --channel-id 0

    # 4. The script will:
    #    - Show the channel state
    #    - Wait for payment updates from the sender
    #    - Cosign each one (verifying balances and signatures)
    #    - Cooperatively close when done, receiving your PACT on-chain
"""

import argparse
import json
import os
import sys
import time

from eth_account import Account
from web3 import Web3

# Channel contract on Arbitrum One
CHANNEL_CONTRACT = "0x5a9D124c05B425CD90613326577E03B3eBd1F891"
PACT_TOKEN = "0x809c2540358E2cF37050cCE41A610cb6CE66Abe1"

# Add SDK to path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sdk"))
from pact_channels import PactChannelClient, PaymentUpdate


def main():
    parser = argparse.ArgumentParser(description="Receive PACT payments through a channel")
    parser.add_argument("--channel-id", type=int, required=True, help="Channel ID to receive from")
    parser.add_argument("--rpc-url", default=os.environ.get("RPC_URL", ""), help="Arbitrum RPC URL")
    parser.add_argument("--private-key", default=os.environ.get("PRIVATE_KEY", ""), help="Your private key")
    parser.add_argument("--update", type=str, help="JSON file with payment update to cosign")
    parser.add_argument("--close", action="store_true", help="Cooperatively close the channel")
    args = parser.parse_args()

    if not args.rpc_url:
        print("Error: Set RPC_URL env var or pass --rpc-url")
        sys.exit(1)
    if not args.private_key:
        print("Error: Set PRIVATE_KEY env var or pass --private-key")
        sys.exit(1)

    w3 = Web3(Web3.HTTPProvider(args.rpc_url))
    account = Account.from_key(args.private_key)
    print(f"Your address: {account.address}")
    print(f"Channel contract: {CHANNEL_CONTRACT}")
    print(f"Channel ID: {args.channel_id}")

    client = PactChannelClient(args.private_key, CHANNEL_CONTRACT, args.rpc_url)

    # Show channel state
    ch = client.get_channel(args.channel_id)
    print(f"\n{'='*50}")
    print(f"Channel State:")
    print(f"  Agent A: {ch['agent_a']}")
    print(f"  Agent B: {ch['agent_b']}")
    print(f"  Deposit A: {w3.from_wei(ch['deposit_a'], 'ether'):.2f} PACT")
    print(f"  Deposit B: {w3.from_wei(ch['deposit_b'], 'ether'):.2f} PACT")
    print(f"  Nonce: {ch['nonce']}")
    print(f"  State: {ch['state']}")
    print(f"{'='*50}")

    if ch['state'] != 'Open':
        print(f"\nChannel is {ch['state']}, not Open.")
        sys.exit(1)

    # Verify we're agent B (the receiver)
    if account.address.lower() == ch['agent_a'].lower():
        role = "Agent A (sender)"
    elif account.address.lower() == ch['agent_b'].lower():
        role = "Agent B (receiver)"
    else:
        print(f"\nError: Your address {account.address} is not part of this channel")
        sys.exit(1)
    print(f"Your role: {role}")

    # Cosign an update
    if args.update:
        print(f"\nLoading update from {args.update}...")
        with open(args.update) as f:
            update = PaymentUpdate.from_json(f.read())

        print(f"  Channel: {update.channel_id}")
        print(f"  Nonce: {update.nonce}")
        print(f"  Balance A: {w3.from_wei(update.balance_a, 'ether'):.2f} PACT")
        print(f"  Balance B: {w3.from_wei(update.balance_b, 'ether'):.2f} PACT")
        print(f"  Has sig_a: {update.sig_a is not None}")
        print(f"  Has sig_b: {update.sig_b is not None}")

        # Verify balance conservation
        total = ch['deposit_a'] + ch['deposit_b']
        if update.balance_a + update.balance_b != total:
            print(f"\n  ERROR: Balances don't sum to total deposit ({total})")
            sys.exit(1)
        print(f"  Balance conservation: OK")

        # Cosign
        signed = client.cosign_update(update)
        print(f"  Cosigned! Fully signed: {signed.is_fully_signed()}")

        # Save the cosigned update
        out_path = args.update.replace('.json', '_cosigned.json')
        with open(out_path, 'w') as f:
            f.write(signed.to_json())
        print(f"  Saved to: {out_path}")

        print(f"\n  You will receive: {w3.from_wei(update.balance_b, 'ether'):.2f} PACT when channel closes")

    # Cooperative close
    if args.close:
        if not args.update:
            print("\nError: Need --update with the final cosigned state to close")
            sys.exit(1)

        out_path = args.update.replace('.json', '_cosigned.json')
        with open(out_path) as f:
            final = PaymentUpdate.from_json(f.read())

        if not final.is_fully_signed():
            print("\nError: Update must be fully signed to close")
            sys.exit(1)

        print(f"\nClosing channel cooperatively...")
        print(f"  You receive: {w3.from_wei(final.balance_b, 'ether'):.2f} PACT")
        receipt = client.coop_close(args.channel_id, final)
        print(f"  TX: {receipt.transactionHash.hex()}")
        print(f"  Status: {'SUCCESS' if receipt.status == 1 else 'FAILED'}")
        print(f"  Gas used: {receipt.gasUsed}")

        if receipt.status == 1:
            # Check PACT balance
            pact_abi = [{"inputs": [{"name": "account", "type": "address"}], "name": "balanceOf",
                         "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"}]
            pact = w3.eth.contract(address=PACT_TOKEN, abi=pact_abi)
            bal = pact.functions.balanceOf(account.address).call()
            print(f"\n  Your PACT balance: {w3.from_wei(bal, 'ether'):.2f}")
            print(f"\n  Payment channel complete. Welcome to PACT.")


if __name__ == "__main__":
    main()
