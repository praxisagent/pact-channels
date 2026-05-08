#!/usr/bin/env node
/**
 * agent_a.js — Hiring Agent (Agent A)
 *
 * Demonstrates the PactEscrow lifecycle from the creator's perspective:
 *   1. Creates a PactEscrow on Sui testnet (locks SUI coins)
 *   2. Prints the pact object ID for Agent B to monitor
 *   3. Polls for WorkSubmitted event
 *   4. Verifies the submitted work hash matches expected content
 *   5. Calls approve() — payment releases instantly to Agent B
 *
 * Usage:
 *   PACKAGE_ID=0x... AGENT_A_MNEMONIC="..." AGENT_B_MNEMONIC="..." node agent_a.js
 *
 * For a scripted demo with mock content, set:
 *   DEMO_MODE=1   — Agent A generates expected content itself for hash comparison
 */

import { Transaction }     from '@mysten/sui/transactions';
import {
  PACKAGE_ID, CLOCK_ID,
  makeClient, agentAKeypair, agentBKeypair,
  execAndWait, pollForEvent, sha256Vec, sha256,
  ESCROW_AMOUNT_MIST, DEADLINE_OFFSET_MS,
  DISPUTE_WINDOW_MS, ARB_WINDOW_MS,
  log, sleep,
} from './shared.js';

const DEMO_MODE = process.env.DEMO_MODE === '1';

// The task Agent A wants Agent B to complete
const TASK_DESCRIPTION = `Risk Analysis Request:
Evaluate the security properties of PactEscrow on Sui.
Cover: reentrancy, double-spend, deadline bypass, unauthorized approval.
Deliverable: 200-word analysis.`;

async function main() {
  const client = makeClient();
  const keypairA = agentAKeypair();
  const keypairB = agentBKeypair();
  const addrA = keypairA.toSuiAddress();
  const addrB = keypairB.toSuiAddress();

  log('AgentA', `Address: ${addrA}`);
  log('AgentA', `Hiring Agent B (${addrB})`);
  log('AgentA', `Task: ${TASK_DESCRIPTION.split('\n')[0]}`);

  // ── Step 1: Create PactEscrow ─────────────────────────────────────────────
  log('AgentA', `Creating PactEscrow: ${Number(ESCROW_AMOUNT_MIST) / 1e9} SUI`);

  const deadlineMs = Date.now() + DEADLINE_OFFSET_MS;

  const tx = new Transaction();

  // Split exact amount from gas coin
  const [payment] = tx.splitCoins(tx.gas, [ESCROW_AMOUNT_MIST]);

  tx.moveCall({
    target: `${PACKAGE_ID}::pact_escrow::create`,
    arguments: [
      tx.pure.address(addrB),          // recipient = Agent B
      tx.pure.address('0x0'),          // no arbitrator
      tx.pure.u64(0),                  // no arbitrator fee
      tx.pure.u64(deadlineMs),         // deadline (7 days)
      tx.pure.u64(DISPUTE_WINDOW_MS),  // 1-hour dispute window
      tx.pure.u64(ARB_WINDOW_MS),      // 24h arb window (ignored, no arbitrator)
      payment,                         // Coin<SUI> to lock
      tx.object(CLOCK_ID),             // Clock shared object
    ],
  });

  tx.setGasBudget(10_000_000);

  const result = await execAndWait(client, tx, keypairA);
  log('AgentA', `TX: ${result.digest}`);

  // Extract pact ID from PactCreated event
  const createdEvent = result.events?.find(
    e => e.type.endsWith('::pact_escrow::PactCreated')
  );
  if (!createdEvent) throw new Error('PactCreated event not found in TX');

  const pactId = createdEvent.parsedJson.pact_id;
  log('AgentA', `Pact created: ${pactId}`);
  log('AgentA', `Amount locked: ${createdEvent.parsedJson.amount_mist} MIST`);
  log('AgentA', `Deadline: ${new Date(Number(createdEvent.parsedJson.deadline_ms)).toISOString()}`);
  log('AgentA', `--- Pact ID for Agent B: ${pactId} ---`);

  // Print task for Agent B (in a real system, this would be sent via MCP or message queue)
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`TASK FOR AGENT B:`);
  console.log(TASK_DESCRIPTION);
  console.log(`PACT ID: ${pactId}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // ── Step 2: Poll for WorkSubmitted ────────────────────────────────────────
  log('AgentA', 'Waiting for Agent B to submit work...');

  const workEvent = await pollForEvent(
    client,
    'WorkSubmitted',
    ev => ev.pact_id === pactId,
  );

  log('AgentA', `Work submitted! Hash: 0x${Buffer.from(workEvent.work_hash).toString('hex')}`);

  // ── Step 3: Verify hash ───────────────────────────────────────────────────
  if (DEMO_MODE) {
    // In demo mode, Agent A generated the "expected" output — verify it matches
    const expectedContent = buildExpectedAnalysis();
    const expectedHash = sha256Vec(expectedContent);
    const receivedHash = workEvent.work_hash;

    const match = expectedHash.every((b, i) => b === receivedHash[i]);
    if (!match) {
      log('AgentA', `HASH MISMATCH — expected ${Buffer.from(expectedHash).toString('hex')}`);
      log('AgentA', 'Disputing work (in real scenario would call dispute())');
      process.exit(1);
    }
    log('AgentA', `Hash verified ✓ — work matches expected output`);
  } else {
    // In real usage, Agent A retrieves the actual work product off-chain and hashes it
    log('AgentA', `Hash committed on-chain. Verify off-chain before approving.`);
    log('AgentA', `Received work_hash confirms Agent B has the deliverable.`);
  }

  // ── Step 4: Approve ────────────────────────────────────────────────────────
  log('AgentA', `Approving — releasing ${Number(ESCROW_AMOUNT_MIST) / 1e9} SUI to Agent B`);

  const approveTx = new Transaction();
  approveTx.moveCall({
    target: `${PACKAGE_ID}::pact_escrow::approve`,
    arguments: [
      approveTx.object(pactId), // &mut Pact
    ],
  });
  approveTx.setGasBudget(10_000_000);

  const approveResult = await execAndWait(client, approveTx, keypairA);
  log('AgentA', `Approved! TX: ${approveResult.digest}`);

  const approvedEvent = approveResult.events?.find(
    e => e.type.endsWith('::pact_escrow::PactApproved')
  );
  const releasedEvent = approveResult.events?.find(
    e => e.type.endsWith('::pact_escrow::PactReleased')
  );

  if (approvedEvent) {
    log('AgentA', `PactApproved — ${approvedEvent.parsedJson.amount_mist} MIST released`);
  }
  if (releasedEvent) {
    log('AgentA', `PactReleased → Agent B (${releasedEvent.parsedJson.recipient})`);
  }

  log('AgentA', '✅ Commerce complete. No trust required.');
  console.log('');
  console.log(`  TX (create):  https://testnet.suivision.xyz/txblock/${result.digest}`);
  console.log(`  TX (approve): https://testnet.suivision.xyz/txblock/${approveResult.digest}`);
  console.log(`  Pact object:  https://testnet.suivision.xyz/object/${pactId}`);
}

/** In demo mode, Agent A can pre-compute the expected analysis output */
function buildExpectedAnalysis() {
  return `PactEscrow Security Analysis
=============================

1. Reentrancy: Eliminated by design. Sui's object model transfers Balance<SUI> via linear
   type — no external call occurs during state change. No CEI pattern required.

2. Double-spend: Impossible. Balance<SUI> is a linear type in Move — it cannot be copied
   or dropped silently. Exactly one path withdraws the balance.

3. Deadline bypass: Protected. submit_work() checks clock.timestamp_ms() <= deadline_ms.
   The Sui Clock object is consensus-controlled — no miner manipulation.

4. Unauthorized approval: Protected. approve() asserts sender == pact.creator.
   submit_work() asserts sender == pact.recipient. Role separation is enforced on-chain.

Verdict: PactEscrow implements the core trust invariants correctly. The Move port
is structurally safer than the Solidity original due to language-level guarantees.

— Agent B Risk Analysis Engine v0.1.0`;
}

main().catch(err => {
  console.error('[AgentA] Fatal:', err.message);
  process.exit(1);
});
