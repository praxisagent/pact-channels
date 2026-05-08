#!/usr/bin/env node
/**
 * agent_b.js — Service Agent (Agent B)
 *
 * Demonstrates the PactEscrow lifecycle from the recipient's perspective:
 *   1. Watches for PactCreated events addressed to Agent B
 *   2. Logs the task embedded in the pact (retrieved from event / off-chain)
 *   3. Generates a risk analysis report (simulated LLM output)
 *   4. Computes SHA256 of the deliverable
 *   5. Calls submit_work() — commits hash on-chain, starts dispute window
 *   6. Waits for approval or auto-release
 *
 * Usage:
 *   PACKAGE_ID=0x... AGENT_A_MNEMONIC="..." AGENT_B_MNEMONIC="..." node agent_b.js
 *
 * Optional:
 *   PACT_ID=0x...    — Watch a specific pact instead of scanning all events
 *   ANTHROPIC_API_KEY=... — Use Claude to generate a real risk analysis
 */

import { Transaction } from '@mysten/sui/transactions';
import https          from 'https';
import {
  PACKAGE_ID, CLOCK_ID,
  makeClient, agentBKeypair, agentAKeypair,
  execAndWait, pollForEvent, sha256Vec,
  log, sleep,
} from './shared.js';

const TARGET_PACT_ID = process.env.PACT_ID ?? null;
const USE_CLAUDE     = !!(process.env.ANTHROPIC_API_KEY);

async function main() {
  const client  = makeClient();
  const keypairB = agentBKeypair();
  const keypairA = agentAKeypair();
  const addrB   = keypairB.toSuiAddress();
  const addrA   = keypairA.toSuiAddress();

  log('AgentB', `Address: ${addrB}`);
  log('AgentB', `Watching for pacts from Agent A (${addrA})`);

  // ── Step 1: Watch for PactCreated event ──────────────────────────────────
  let pactId = TARGET_PACT_ID;

  if (!pactId) {
    log('AgentB', 'Scanning for PactCreated events...');
    const ev = await pollForEvent(
      client,
      'PactCreated',
      ev => ev.recipient === addrB && ev.creator === addrA,
      5000,
      10 * 60 * 1000,  // wait up to 10 minutes
    );
    pactId = ev.pact_id;
    log('AgentB', `New pact found: ${pactId}`);
    log('AgentB', `Amount: ${ev.amount_mist} MIST`);
    log('AgentB', `Deadline: ${new Date(Number(ev.deadline_ms)).toISOString()}`);
  } else {
    log('AgentB', `Targeting specific pact: ${pactId}`);
  }

  // ── Step 2: Inspect pact state ────────────────────────────────────────────
  const pactObj = await client.getObject({
    id:      pactId,
    options: { showContent: true },
  });

  if (!pactObj.data?.content) throw new Error(`Pact object not found: ${pactId}`);
  const fields = pactObj.data.content.fields;
  log('AgentB', `Pact status: ${['Active','WorkSubmitted','Disputed','Complete','Refunded'][fields.status]}`);

  if (fields.status !== 0) {
    log('AgentB', 'Pact is not Active — nothing to do');
    process.exit(0);
  }

  // ── Step 3: Generate deliverable ─────────────────────────────────────────
  log('AgentB', 'Generating risk analysis report...');
  const analysis = await generateAnalysis(pactId, USE_CLAUDE);
  log('AgentB', `Report (${analysis.length} chars): "${analysis.slice(0, 80)}..."`);

  // ── Step 4: Compute SHA256 ───────────────────────────────────────────────
  const workHashVec = sha256Vec(analysis);
  const workHashHex = Buffer.from(workHashVec).toString('hex');
  log('AgentB', `SHA256: 0x${workHashHex}`);

  // Print deliverable for Agent A to verify (in production: send via MCP / IPFS / email)
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('DELIVERABLE (for Agent A to verify):');
  console.log(analysis);
  console.log('');
  console.log(`SHA256: 0x${workHashHex}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // ── Step 5: Submit work on-chain ─────────────────────────────────────────
  log('AgentB', 'Committing hash on-chain via submit_work()...');

  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::pact_escrow::submit_work`,
    arguments: [
      tx.object(pactId),              // &mut Pact
      tx.pure.vector('u8', workHashVec), // SHA256 work hash (32 bytes)
      tx.object(CLOCK_ID),            // Clock
    ],
  });
  tx.setGasBudget(10_000_000);

  const result = await execAndWait(client, tx, keypairB);
  log('AgentB', `Work submitted! TX: ${result.digest}`);

  const submittedEvent = result.events?.find(
    e => e.type.endsWith('::pact_escrow::WorkSubmitted')
  );
  if (submittedEvent) {
    log('AgentB', `On-chain hash: 0x${Buffer.from(submittedEvent.parsedJson.work_hash).toString('hex')}`);
  }

  // ── Step 6: Wait for approval or auto-release ────────────────────────────
  log('AgentB', 'Waiting for Agent A to approve (or dispute window to expire for auto-release)...');

  const approvedEvent = await pollForEvent(
    client,
    'PactReleased',
    ev => ev.pact_id === pactId,
    5000,
    30 * 60 * 1000,  // wait up to 30 minutes
  );

  log('AgentB', `✅ Payment received! ${approvedEvent.amount_mist} MIST from pact ${pactId}`);
  console.log('');
  console.log(`  TX (submit): https://testnet.suivision.xyz/txblock/${result.digest}`);
  console.log(`  Pact object: https://testnet.suivision.xyz/object/${pactId}`);
}

/**
 * Generate a risk analysis. In demo mode uses a canned response;
 * if ANTHROPIC_API_KEY is set, calls Claude for a real analysis.
 */
async function generateAnalysis(pactId, useClaudeAPI) {
  if (useClaudeAPI) {
    log('AgentB', 'Calling Claude API for risk analysis...');
    return await callClaude(
      `You are a security researcher. Analyze PactEscrow smart contract security.
Pact ID: ${pactId}
Provide a 200-word risk analysis covering:
1. Reentrancy protection in Move
2. Double-spend prevention via Balance<T>
3. Deadline manipulation resistance
4. Unauthorized approval prevention
Be precise and technical. Sign as "Agent B Risk Analysis Engine v0.1.0".`
    );
  }

  // Canned demo response (deterministic for hash verification)
  await sleep(1500);  // simulate processing time
  return buildDemoAnalysis();
}

function buildDemoAnalysis() {
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

/** Minimal Claude API call (no SDK needed — direct HTTPS) */
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages:   [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-api-key':        process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content[0].text);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

main().catch(err => {
  console.error('[AgentB] Fatal:', err.message);
  process.exit(1);
});
