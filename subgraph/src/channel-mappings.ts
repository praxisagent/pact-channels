import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  ChannelOpened,
  ChannelFunded,
  ChannelCoopClosed,
  ChannelCloseInitiated,
  ChannelChallenged,
  ChannelSettled,
} from "../generated/PactPaymentChannel/PactPaymentChannel";
import { PaymentChannel, Protocol } from "../generated/schema";

function loadOrCreateProtocol(): Protocol {
  let protocol = Protocol.load("singleton");
  if (protocol == null) {
    protocol = new Protocol("singleton");
    protocol.totalPacts = BigInt.fromI32(0);
    protocol.activePacts = BigInt.fromI32(0);
    protocol.completedPacts = BigInt.fromI32(0);
    protocol.disputedPacts = BigInt.fromI32(0);
    protocol.totalPactVolume = BigInt.fromI32(0);
    protocol.totalChannels = BigInt.fromI32(0);
    protocol.activeChannels = BigInt.fromI32(0);
    protocol.totalChannelVolume = BigInt.fromI32(0);
    protocol.lastUpdated = BigInt.fromI32(0);
  }
  return protocol as Protocol;
}

// ChannelState enum values
const STATE_OPEN = 0;
const STATE_CLOSING = 1;
const STATE_CLOSED = 2;

export function handleChannelOpened(event: ChannelOpened): void {
  let channel = new PaymentChannel(event.params.channelId.toString());
  channel.channelId = event.params.channelId;
  channel.agentA = event.params.agentA;
  channel.agentB = event.params.agentB;
  channel.depositA = event.params.depositA;
  channel.depositB = BigInt.fromI32(0);
  channel.balanceA = event.params.depositA;
  channel.balanceB = BigInt.fromI32(0);
  channel.nonce = BigInt.fromI32(0);
  channel.closeTime = BigInt.fromI32(0);
  channel.state = STATE_OPEN;
  channel.openedAt = event.block.timestamp;
  channel.updatedAt = event.block.timestamp;
  channel.txHash = event.transaction.hash;
  channel.save();

  let protocol = loadOrCreateProtocol();
  protocol.totalChannels = protocol.totalChannels.plus(BigInt.fromI32(1));
  protocol.activeChannels = protocol.activeChannels.plus(BigInt.fromI32(1));
  protocol.totalChannelVolume = protocol.totalChannelVolume.plus(event.params.depositA);
  protocol.lastUpdated = event.block.timestamp;
  protocol.save();
}

export function handleChannelFunded(event: ChannelFunded): void {
  let channel = PaymentChannel.load(event.params.channelId.toString());
  if (channel == null) return;

  channel.depositB = event.params.depositB;
  channel.balanceB = event.params.depositB;
  channel.updatedAt = event.block.timestamp;
  channel.save();

  let protocol = loadOrCreateProtocol();
  protocol.totalChannelVolume = protocol.totalChannelVolume.plus(event.params.depositB);
  protocol.lastUpdated = event.block.timestamp;
  protocol.save();
}

export function handleChannelCoopClosed(event: ChannelCoopClosed): void {
  let channel = PaymentChannel.load(event.params.channelId.toString());
  if (channel == null) return;

  channel.balanceA = event.params.balanceA;
  channel.balanceB = event.params.balanceB;
  channel.state = STATE_CLOSED;
  channel.updatedAt = event.block.timestamp;
  channel.save();

  let protocol = loadOrCreateProtocol();
  if (protocol.activeChannels.gt(BigInt.fromI32(0))) {
    protocol.activeChannels = protocol.activeChannels.minus(BigInt.fromI32(1));
  }
  protocol.lastUpdated = event.block.timestamp;
  protocol.save();
}

export function handleChannelCloseInitiated(event: ChannelCloseInitiated): void {
  let channel = PaymentChannel.load(event.params.channelId.toString());
  if (channel == null) return;

  channel.nonce = event.params.nonce;
  channel.balanceA = event.params.balanceA;
  channel.balanceB = event.params.balanceB;
  channel.closeTime = event.params.closeTime;
  channel.state = STATE_CLOSING;
  channel.updatedAt = event.block.timestamp;
  channel.save();
}

export function handleChannelChallenged(event: ChannelChallenged): void {
  let channel = PaymentChannel.load(event.params.channelId.toString());
  if (channel == null) return;

  channel.nonce = event.params.nonce;
  channel.balanceA = event.params.balanceA;
  channel.balanceB = event.params.balanceB;
  channel.updatedAt = event.block.timestamp;
  channel.save();
}

export function handleChannelSettled(event: ChannelSettled): void {
  let channel = PaymentChannel.load(event.params.channelId.toString());
  if (channel == null) return;

  channel.balanceA = event.params.balanceA;
  channel.balanceB = event.params.balanceB;
  channel.state = STATE_CLOSED;
  channel.updatedAt = event.block.timestamp;
  channel.save();

  let protocol = loadOrCreateProtocol();
  if (protocol.activeChannels.gt(BigInt.fromI32(0))) {
    protocol.activeChannels = protocol.activeChannels.minus(BigInt.fromI32(1));
  }
  protocol.lastUpdated = event.block.timestamp;
  protocol.save();
}
