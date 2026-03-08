#!/usr/bin/env python3
"""Demo: Send PACT payments through a payment channel.

This is the sender (Agent A) side. Opens a channel, deposits PACT,
generates signed payment updates for the receiver to cosign.

Usage:
    export PRIVATE_KEY="0x..."
    export RPC_URL="https://..."

    # Step 1: Approve PACT spending and open a channel
    python3 scripts/demo_send.py --open --agent-b 0x... --deposit 1000

    # Step 2: Generate payment updates (receiver cosigns these)
    python3 scripts/demo_send.py --channel-id 0 --pay 100 --nonce 1

    # Step 3: After receiver cosigns, close cooperatively
    python3 scripts/demo_send.py --channel-id 0 --close --update update_cosigned.json
"""

import argparse
import json
import os
import sys

from eth_account import Account
from web3 import Web3

CHANNEL_CONTRACT = "0x5a9D124c05B425CD90613326577E03B3eBd1F891"
PACT_TOKEN = "0x809c2540358E2cF37050cCE41A610cb6CE66Abe1"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sdk"))
from pact_channels import PactChannelClient, PaymentUpdate


def main():
    parser = argparse.ArgumentParser(description="Send PACT through a payment channel")
    parser.add_argument("--rpc-url", default=os.environ.get("RPC_URL", ""))
    parser.add_argument("--private-key", default=os.environ.get("PRIVATE_KEY", ""))

    # Open channel
    parser.add_argument("--open", action="store_true", help="Open a new channel")
    parser.add_argument("--agent-b", type=str, help="Receiver address")
    parser.add_argument("--deposit", type=float, help="PACT to deposit (in tokens, not wei)")

    # Pay
    parser.add_argument("--channel-id", type=int, help="Channel ID")
    parser.add_argument("--pay", type=float, help="Total PACT paid to B so far")
    parser.add_argument("--nonce", type=int, help="Payment nonce (increment each time)")

    # Close
    parser.add_argument("--close", action="store_true", help="Cooperative close")
    parser.add_argument("--update", type=str, help="Cosigned update JSON file")

    args = parser.parse_args()

    if not args.rpc_url or not args.private_key:
        print("Error: Set RPC_URL and PRIVATE_KEY env vars")
        sys.exit(1)

    w3 = Web3(Web3.HTTPProvider(args.rpc_url))
    client = PactChannelClient(args.private_key, CHANNEL_CONTRACT, args.rpc_url)
    print(f"Sender: {client.address}")

    if args.open:
        if not args.agent_b or not args.deposit:
            print("Error: --open requires --agent-b and --deposit")
            sys.exit(1)

        deposit_wei = int(args.deposit * 10**18)
        print(f"\nApproving {args.deposit:.0f} PACT for channel contract...")
        client.approve_pact(deposit_wei)
        print("Approved.")

        print(f"Opening channel with {args.agent_b}, deposit {args.deposit:.0f} PACT...")
        channel_id = client.open_channel(args.agent_b, deposit_wei)
        print(f"Channel opened! ID: {channel_id}")
        print(f"\nTell the receiver to run:")
        print(f"  python3 scripts/demo_receive.py --channel-id {channel_id}")

    elif args.pay is not None:
        if args.channel_id is None or args.nonce is None:
            print("Error: --pay requires --channel-id and --nonce")
            sys.exit(1)

        ch = client.get_channel(args.channel_id)
        total = ch['deposit_a'] + ch['deposit_b']
        balance_b = int(args.pay * 10**18)
        balance_a = total - balance_b

        print(f"\nCreating payment update:")
        print(f"  Nonce: {args.nonce}")
        print(f"  Agent A keeps: {w3.from_wei(balance_a, 'ether'):.2f} PACT")
        print(f"  Agent B receives: {w3.from_wei(balance_b, 'ether'):.2f} PACT")

        update = client.create_update(args.channel_id, args.nonce, balance_a, balance_b)

        out_file = f"update_n{args.nonce}.json"
        with open(out_file, 'w') as f:
            f.write(update.to_json())
        print(f"  Saved to: {out_file}")
        print(f"\nSend {out_file} to the receiver for cosigning:")
        print(f"  python3 scripts/demo_receive.py --channel-id {args.channel_id} --update {out_file}")

    elif args.close:
        if args.channel_id is None or not args.update:
            print("Error: --close requires --channel-id and --update")
            sys.exit(1)

        with open(args.update) as f:
            final = PaymentUpdate.from_json(f.read())

        if not final.is_fully_signed():
            print("Error: Update must be fully signed (both parties)")
            sys.exit(1)

        print(f"\nCooperative close:")
        print(f"  Agent A receives: {w3.from_wei(final.balance_a, 'ether'):.2f} PACT")
        print(f"  Agent B receives: {w3.from_wei(final.balance_b, 'ether'):.2f} PACT")
        receipt = client.coop_close(args.channel_id, final)
        print(f"  TX: {receipt.transactionHash.hex()}")
        print(f"  Status: {'SUCCESS' if receipt.status == 1 else 'FAILED'}")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
