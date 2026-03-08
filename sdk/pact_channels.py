"""PACT Payment Channel SDK — Off-chain signing and verification for agent micropayments.

Usage:
    from pact_channels import PactChannelClient

    # Agent A opens a channel
    client_a = PactChannelClient(private_key_a, channel_contract_address, rpc_url)
    channel_id = client_a.open_channel(agent_b_address, deposit_amount)

    # Agent A creates a payment update (pays 100 PACT to B)
    update = client_a.create_update(channel_id, nonce=1, balance_a=900, balance_b=100)
    # Send update to Agent B over any transport (HTTP, WebSocket, etc.)

    # Agent B co-signs the update
    client_b = PactChannelClient(private_key_b, channel_contract_address, rpc_url)
    signed_update = client_b.cosign_update(update)
    # Both parties now have a mutually signed state they can submit on-chain if needed

    # Cooperative close (instant)
    client_a.coop_close(channel_id, signed_update)
"""

import json
import os
from dataclasses import dataclass
from typing import Optional

from eth_account import Account
from eth_account.messages import encode_typed_data
from web3 import Web3


@dataclass
class PaymentUpdate:
    """A signed payment channel state update."""
    channel_id: int
    nonce: int
    balance_a: int  # in wei
    balance_b: int  # in wei
    sig_a: Optional[bytes] = None
    sig_b: Optional[bytes] = None

    def to_dict(self) -> dict:
        return {
            "channel_id": self.channel_id,
            "nonce": self.nonce,
            "balance_a": str(self.balance_a),
            "balance_b": str(self.balance_b),
            "sig_a": self.sig_a.hex() if self.sig_a else None,
            "sig_b": self.sig_b.hex() if self.sig_b else None,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "PaymentUpdate":
        return cls(
            channel_id=d["channel_id"],
            nonce=d["nonce"],
            balance_a=int(d["balance_a"]),
            balance_b=int(d["balance_b"]),
            sig_a=bytes.fromhex(d["sig_a"]) if d.get("sig_a") else None,
            sig_b=bytes.fromhex(d["sig_b"]) if d.get("sig_b") else None,
        )

    def is_fully_signed(self) -> bool:
        return self.sig_a is not None and self.sig_b is not None

    def to_json(self) -> str:
        return json.dumps(self.to_dict())

    @classmethod
    def from_json(cls, s: str) -> "PaymentUpdate":
        return cls.from_dict(json.loads(s))


class PactChannelClient:
    """Client for interacting with PACT payment channels."""

    def __init__(self, private_key: str, channel_address: str, rpc_url: str):
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.account = Account.from_key(private_key)
        self.address = self.account.address
        self.channel_address = Web3.to_checksum_address(channel_address)

        with open(os.path.join(os.path.dirname(__file__), "..", "abi", "PactPaymentChannel.json")) as f:
            abi = json.load(f)
        self.contract = self.w3.eth.contract(address=self.channel_address, abi=abi)

        # EIP-712 domain — must match the contract's DOMAIN_SEPARATOR
        self.domain = {
            "name": "PactPaymentChannel",
            "version": "1",
            "chainId": self.w3.eth.chain_id,
            "verifyingContract": self.channel_address,
        }

    # ──────────────────── On-chain operations ────────────────

    def _send_tx(self, tx_func):
        """Build, sign, send a transaction and wait for receipt."""
        tx = tx_func.build_transaction({
            "from": self.address,
            "nonce": self.w3.eth.get_transaction_count(self.address),
            "chainId": self.w3.eth.chain_id,
            "maxFeePerGas": self.w3.eth.gas_price * 2,
            "maxPriorityFeePerGas": self.w3.to_wei(0.01, "gwei"),
        })
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        return self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

    def approve_pact(self, amount_wei: int):
        """Approve the channel contract to spend PACT tokens."""
        pact_address = self.contract.functions.pactToken().call()
        pact_abi = [
            {"inputs": [{"name": "spender", "type": "address"}, {"name": "value", "type": "uint256"}],
             "name": "approve", "outputs": [{"type": "bool"}], "stateMutability": "nonpayable", "type": "function"},
        ]
        pact = self.w3.eth.contract(address=pact_address, abi=pact_abi)
        return self._send_tx(pact.functions.approve(self.channel_address, amount_wei))

    def open_channel(self, agent_b: str, deposit_wei: int) -> int:
        """Open a new payment channel with agent_b. Returns channel_id."""
        receipt = self._send_tx(
            self.contract.functions.open(Web3.to_checksum_address(agent_b), deposit_wei)
        )
        # Parse ChannelOpened event for the channel ID
        logs = self.contract.events.ChannelOpened().process_receipt(receipt)
        if logs:
            return logs[0]["args"]["channelId"]
        raise RuntimeError("Channel open failed — no event emitted")

    def fund_channel(self, channel_id: int, deposit_wei: int):
        """Fund your side of an existing channel (agentB only)."""
        return self._send_tx(self.contract.functions.fund(channel_id, deposit_wei))

    def coop_close(self, channel_id: int, update: PaymentUpdate):
        """Cooperatively close a channel using a fully-signed update."""
        if not update.is_fully_signed():
            raise ValueError("Update must be signed by both parties")
        return self._send_tx(
            self.contract.functions.coopClose(
                channel_id, update.balance_a, update.balance_b, update.nonce,
                update.sig_a, update.sig_b,
            )
        )

    def initiate_close(self, channel_id: int, update: PaymentUpdate):
        """Initiate unilateral close with a signed update. Starts challenge period."""
        if not update.is_fully_signed():
            raise ValueError("Update must be signed by both parties")
        return self._send_tx(
            self.contract.functions.initiateClose(
                channel_id, update.balance_a, update.balance_b, update.nonce,
                update.sig_a, update.sig_b,
            )
        )

    def challenge(self, channel_id: int, update: PaymentUpdate):
        """Challenge a pending close with a higher-nonce update."""
        if not update.is_fully_signed():
            raise ValueError("Update must be signed by both parties")
        return self._send_tx(
            self.contract.functions.challenge(
                channel_id, update.balance_a, update.balance_b, update.nonce,
                update.sig_a, update.sig_b,
            )
        )

    def settle(self, channel_id: int):
        """Settle a channel after challenge period expires."""
        return self._send_tx(self.contract.functions.settle(channel_id))

    # ──────────────────── Off-chain signing ──────────────────

    def _sign_update_raw(self, channel_id: int, nonce: int, balance_a: int, balance_b: int) -> bytes:
        """Sign a payment update using EIP-712 typed data."""
        typed_data = {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"},
                ],
                "PaymentUpdate": [
                    {"name": "channelId", "type": "uint256"},
                    {"name": "nonce", "type": "uint256"},
                    {"name": "balanceA", "type": "uint256"},
                    {"name": "balanceB", "type": "uint256"},
                ],
            },
            "primaryType": "PaymentUpdate",
            "domain": self.domain,
            "message": {
                "channelId": channel_id,
                "nonce": nonce,
                "balanceA": balance_a,
                "balanceB": balance_b,
            },
        }
        signed = self.account.sign_typed_data(
            domain_data=self.domain,
            message_types={"PaymentUpdate": typed_data["types"]["PaymentUpdate"]},
            message_data=typed_data["message"],
        )
        return signed.signature

    def create_update(self, channel_id: int, nonce: int, balance_a: int, balance_b: int) -> PaymentUpdate:
        """Create a new payment update and sign it. The counterparty must cosign before it's valid."""
        sig = self._sign_update_raw(channel_id, nonce, balance_a, balance_b)

        # Determine if we're agent A or B
        ch = self.contract.functions.getChannel(channel_id).call()
        agent_a = ch[0]

        update = PaymentUpdate(
            channel_id=channel_id,
            nonce=nonce,
            balance_a=balance_a,
            balance_b=balance_b,
        )

        if self.address.lower() == agent_a.lower():
            update.sig_a = sig
        else:
            update.sig_b = sig

        return update

    def cosign_update(self, update: PaymentUpdate) -> PaymentUpdate:
        """Cosign an update received from the counterparty. Returns the fully-signed update."""
        sig = self._sign_update_raw(update.channel_id, update.nonce, update.balance_a, update.balance_b)

        ch = self.contract.functions.getChannel(update.channel_id).call()
        agent_a = ch[0]

        if self.address.lower() == agent_a.lower():
            update.sig_a = sig
        else:
            update.sig_b = sig

        return update

    # ──────────────────── View helpers ────────────────────────

    def get_channel(self, channel_id: int) -> dict:
        """Get channel state from the contract."""
        ch = self.contract.functions.getChannel(channel_id).call()
        return {
            "agent_a": ch[0],
            "agent_b": ch[1],
            "deposit_a": ch[2],
            "deposit_b": ch[3],
            "nonce": ch[4],
            "balance_a": ch[5],
            "balance_b": ch[6],
            "close_time": ch[7],
            "state": ["Open", "Closing", "Closed"][ch[8]],
        }

    def is_settleable(self, channel_id: int) -> bool:
        """Check if a channel can be settled."""
        return self.contract.functions.isSettleable(channel_id).call()
