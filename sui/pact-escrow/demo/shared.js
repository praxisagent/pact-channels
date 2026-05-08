/**
 * shared.js — Shared config and utilities for PactEscrow demo
 *
 * Requires env vars:
 *   PACKAGE_ID       - Deployed package address (e.g. 0xabc...)
 *   AGENT_A_MNEMONIC - BIP-39 mnemonic for Agent A (hiring agent)
 *   AGENT_B_MNEMONIC - BIP-39 mnemonic for Agent B (service agent)
 *   SUI_RPC_URL      - Sui RPC endpoint (default: Sui testnet)
 */

import {
  SuiClient,
  getFullnodeUrl,
} from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { createHash } from 'crypto';

// ─── Config ────────────────────────────────────────────────────────────────

export const PACKAGE_ID = process.env.PACKAGE_ID
  ?? '0x0000000000000000000000000000000000000000000000000000000000000000';

export const RPC_URL = process.env.SUI_RPC_URL ?? getFullnodeUrl('testnet');

// Sui well-known shared objects
export const CLOCK_ID = '0x6';

// Pact parameters
export const ESCROW_AMOUNT_MIST  = 100_000_000n;    // 0.1 SUI (in MIST, 1 SUI = 1e9 MIST)
export const DEADLINE_OFFSET_MS  = 7 * 24 * 60 * 60 * 1000;  // 7 days from now
export const DISPUTE_WINDOW_MS   = 3_600_000;        // 1 hour (minimum)
export const ARB_WINDOW_MS       = 86_400_000;       // 24 hours

// ─── Client ────────────────────────────────────────────────────────────────

export function makeClient() {
  return new SuiClient({ url: RPC_URL });
}

// ─── Keypairs ──────────────────────────────────────────────────────────────

export function keypairFromMnemonic(mnemonic) {
  return Ed25519Keypair.deriveKeypair(mnemonic, `m/44'/784'/0'/0'/0'`);
}

export function agentAKeypair() {
  const m = process.env.AGENT_A_MNEMONIC;
  if (!m) throw new Error('AGENT_A_MNEMONIC env var required');
  return keypairFromMnemonic(m);
}

export function agentBKeypair() {
  const m = process.env.AGENT_B_MNEMONIC;
  if (!m) throw new Error('AGENT_B_MNEMONIC env var required');
  return keypairFromMnemonic(m);
}

// ─── Hash utilities ────────────────────────────────────────────────────────

/** SHA256 of a UTF-8 string → Buffer (32 bytes) */
export function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest();
}

/** SHA256 → Array<number> (for Sui vector<u8>) */
export function sha256Vec(content) {
  return Array.from(sha256(content));
}

// ─── Transaction helpers ───────────────────────────────────────────────────

/**
 * Execute a PTB (Programmable Transaction Block) and wait for confirmation.
 *
 * @param {SuiClient} client
 * @param {Transaction} tx
 * @param {Ed25519Keypair} signer
 * @returns {Promise<SuiTransactionBlockResponse>}
 */
export async function execAndWait(client, tx, signer) {
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: {
      showEvents:         true,
      showObjectChanges:  true,
      showBalanceChanges: true,
    },
    requestType: 'WaitForLocalExecution',
  });
  if (result.errors && result.errors.length > 0) {
    throw new Error(`Transaction failed: ${JSON.stringify(result.errors)}`);
  }
  return result;
}

// ─── Event helpers ─────────────────────────────────────────────────────────

/** Build an event type string for this package */
export function eventType(name) {
  return `${PACKAGE_ID}::pact_escrow::${name}`;
}

/**
 * Poll for a specific event type, returning the first matching event.
 *
 * @param {SuiClient} client
 * @param {string} eventTypeName  - e.g. 'PactCreated'
 * @param {Function} predicate    - filter function for event.parsedJson
 * @param {number} pollIntervalMs - how often to poll
 * @param {number} timeoutMs      - how long before giving up
 * @returns {Promise<object>}     - the matching event's parsedJson
 */
export async function pollForEvent(
  client,
  eventTypeName,
  predicate = () => true,
  pollIntervalMs = 3000,
  timeoutMs = 5 * 60 * 1000,
) {
  const start    = Date.now();
  const evtType  = eventType(eventTypeName);
  let   cursor   = null;

  console.log(`  Polling for ${eventTypeName} ...`);

  while (Date.now() - start < timeoutMs) {
    const page = await client.queryEvents({
      query:   { MoveEventType: evtType },
      cursor,
      limit:   50,
      order:   'ascending',
    });

    for (const ev of page.data) {
      if (predicate(ev.parsedJson)) {
        return ev.parsedJson;
      }
    }

    if (page.hasNextPage) {
      cursor = page.nextCursor;
    } else {
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(`Timeout waiting for ${eventTypeName}`);
}

// ─── Misc ──────────────────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function mist(n) {
  return BigInt(n);
}

export function log(agent, msg) {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  console.log(`[${ts}] [${agent}] ${msg}`);
}
