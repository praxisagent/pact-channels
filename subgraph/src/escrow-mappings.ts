import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  PactCreated,
  WorkSubmitted,
  PactApproved,
  PactDisputed,
  PactReleased,
  PactRefunded,
  ArbitrationRuled,
  ArbitrationFinalized,
} from "../generated/PactEscrowV2/PactEscrowV2";
import { Pact, PactHistoryEvent, Protocol } from "../generated/schema";

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

function createEvent(
  pact: Pact,
  eventType: string,
  actor: Bytes | null,
  data: string,
  timestamp: BigInt,
  blockNumber: BigInt,
  txHash: Bytes,
  suffix: string
): void {
  let id = pact.id + "-" + eventType + "-" + suffix;
  let ev = new PactHistoryEvent(id);
  ev.pact = pact.id;
  ev.eventType = eventType;
  ev.actor = actor;
  ev.data = data;
  ev.timestamp = timestamp;
  ev.blockNumber = blockNumber;
  ev.txHash = txHash;
  ev.save();
}

// Status constants mirror PactEscrowV2 enum
const STATUS_ACTIVE = 0;
const STATUS_WORK_SUBMITTED = 1;
const STATUS_COMPLETED = 2;
const STATUS_DISPUTED = 3;
const STATUS_REFUNDED = 4;
const STATUS_ARBITRATED = 5;

export function handlePactCreated(event: PactCreated): void {
  let pact = new Pact(event.params.pactId.toString());
  pact.pactId = event.params.pactId;
  pact.creator = event.params.creator;
  pact.recipient = event.params.recipient;
  pact.arbitrator = event.params.arbitrator;
  pact.amount = event.params.amount;
  pact.arbitratorFee = event.params.arbitratorFee;
  pact.deadline = event.params.deadline;
  pact.disputeWindow = event.params.disputeWindow;
  pact.arbitrationWindow = event.params.arbitrationWindow;
  pact.workSubmittedAt = BigInt.fromI32(0);
  pact.disputeRaisedAt = BigInt.fromI32(0);
  pact.workHash = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000");
  pact.status = STATUS_ACTIVE;
  pact.createdAt = event.block.timestamp;
  pact.updatedAt = event.block.timestamp;
  pact.txHash = event.transaction.hash;
  pact.save();

  let protocol = loadOrCreateProtocol();
  protocol.totalPacts = protocol.totalPacts.plus(BigInt.fromI32(1));
  protocol.activePacts = protocol.activePacts.plus(BigInt.fromI32(1));
  protocol.totalPactVolume = protocol.totalPactVolume.plus(event.params.amount);
  protocol.lastUpdated = event.block.timestamp;
  protocol.save();

  createEvent(
    pact,
    "PactCreated",
    event.params.creator,
    event.params.amount.toString(),
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    event.transaction.hash.toHex()
  );
}

export function handleWorkSubmitted(event: WorkSubmitted): void {
  let pact = Pact.load(event.params.pactId.toString());
  if (pact == null) return;

  pact.workHash = event.params.workHash;
  pact.workSubmittedAt = event.block.timestamp;
  pact.status = STATUS_WORK_SUBMITTED;
  pact.updatedAt = event.block.timestamp;
  pact.save();

  createEvent(
    pact,
    "WorkSubmitted",
    event.params.recipient,
    event.params.workHash.toHex(),
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    event.transaction.hash.toHex()
  );
}

export function handlePactApproved(event: PactApproved): void {
  let pact = Pact.load(event.params.pactId.toString());
  if (pact == null) return;

  pact.status = STATUS_COMPLETED;
  pact.updatedAt = event.block.timestamp;
  pact.save();

  let protocol = loadOrCreateProtocol();
  protocol.activePacts = protocol.activePacts.minus(BigInt.fromI32(1));
  protocol.completedPacts = protocol.completedPacts.plus(BigInt.fromI32(1));
  protocol.lastUpdated = event.block.timestamp;
  protocol.save();

  createEvent(
    pact,
    "PactApproved",
    event.params.creator,
    "",
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    event.transaction.hash.toHex()
  );
}

export function handlePactDisputed(event: PactDisputed): void {
  let pact = Pact.load(event.params.pactId.toString());
  if (pact == null) return;

  pact.disputeRaisedAt = event.block.timestamp;
  pact.status = STATUS_DISPUTED;
  pact.updatedAt = event.block.timestamp;
  pact.save();

  let protocol = loadOrCreateProtocol();
  protocol.disputedPacts = protocol.disputedPacts.plus(BigInt.fromI32(1));
  protocol.lastUpdated = event.block.timestamp;
  protocol.save();

  createEvent(
    pact,
    "PactDisputed",
    event.params.creator,
    "",
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    event.transaction.hash.toHex()
  );
}

export function handlePactReleased(event: PactReleased): void {
  let pact = Pact.load(event.params.pactId.toString());
  if (pact == null) return;

  pact.status = STATUS_COMPLETED;
  pact.updatedAt = event.block.timestamp;
  pact.save();

  let protocol = loadOrCreateProtocol();
  protocol.activePacts = protocol.activePacts.minus(BigInt.fromI32(1));
  protocol.completedPacts = protocol.completedPacts.plus(BigInt.fromI32(1));
  protocol.lastUpdated = event.block.timestamp;
  protocol.save();

  createEvent(
    pact,
    "PactReleased",
    event.params.recipient,
    event.params.amount.toString(),
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    event.transaction.hash.toHex()
  );
}

export function handlePactRefunded(event: PactRefunded): void {
  let pact = Pact.load(event.params.pactId.toString());
  if (pact == null) return;

  pact.status = STATUS_REFUNDED;
  pact.updatedAt = event.block.timestamp;
  pact.save();

  let protocol = loadOrCreateProtocol();
  protocol.activePacts = protocol.activePacts.minus(BigInt.fromI32(1));
  protocol.lastUpdated = event.block.timestamp;
  protocol.save();

  createEvent(
    pact,
    "PactRefunded",
    event.params.creator,
    event.params.amount.toString(),
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    event.transaction.hash.toHex()
  );
}

export function handleArbitrationRuled(event: ArbitrationRuled): void {
  let pact = Pact.load(event.params.pactId.toString());
  if (pact == null) return;

  pact.updatedAt = event.block.timestamp;
  pact.save();

  createEvent(
    pact,
    "ArbitrationRuled",
    event.params.arbitrator,
    event.params.favorRecipient ? "recipient" : "creator",
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    event.transaction.hash.toHex()
  );
}

export function handleArbitrationFinalized(event: ArbitrationFinalized): void {
  let pact = Pact.load(event.params.pactId.toString());
  if (pact == null) return;

  pact.status = STATUS_ARBITRATED;
  pact.updatedAt = event.block.timestamp;
  pact.save();

  let protocol = loadOrCreateProtocol();
  protocol.activePacts = protocol.activePacts.minus(BigInt.fromI32(1));
  protocol.lastUpdated = event.block.timestamp;
  protocol.save();

  createEvent(
    pact,
    "ArbitrationFinalized",
    null,
    "",
    event.block.timestamp,
    event.block.number,
    event.transaction.hash,
    event.transaction.hash.toHex()
  );
}
