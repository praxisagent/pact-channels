// node test runner. Invoked via: npm run test:verify
//
// Tests the pure decideVerification() helper from src/verify.ts. We exercise
// every refusal branch and the happy path with canned sworn-verifier decisions
// so we never touch the network here.
//
// End-to-end happy path (real RPC + real manifest) is covered by the receipt
// run captured in PR-RECEIPTS.md against pact 16 + at-clean-base-reference.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideVerification } from '../dist/verify.js';

const ZERO_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const KNOWN_HASH =
  '0xa67d40000000000000000000000000000000000000000000000000000000c0de';

function fakeAllow(stripped_hash, spec_version = '3.0.0') {
  return {
    url: 'https://example.test/manifest.json',
    configured: true,
    fetched_at: new Date().toISOString(),
    status_code: 200,
    allow: true,
    spec_version,
    stripped_hash,
    reason: '',
  };
}

function fakeRefuse(reason, status_code = 200, spec_version = '') {
  return {
    url: 'https://example.test/manifest.json',
    configured: true,
    fetched_at: new Date().toISOString(),
    status_code,
    allow: false,
    spec_version,
    stripped_hash: '',
    reason,
  };
}

test('refuse when on-chain workHash is zero (Active state)', () => {
  const r = decideVerification({
    pactId: '999',
    manifestUrl: 'https://example.test/m.json',
    onChainHash: ZERO_HASH,
    statusCode: 0, // Active
    decision: fakeAllow(KNOWN_HASH),
  });
  assert.equal(r.verified, false);
  assert.match(r.reason, /work_not_yet_submitted/);
  assert.equal(r.pact_status, 'Active');
  assert.equal(r.on_chain_hash, ZERO_HASH);
});

test('refuse when on-chain workHash is zero (WorkSubmitted with zero hash impossible-but-handled)', () => {
  const r = decideVerification({
    pactId: '999',
    manifestUrl: 'https://example.test/m.json',
    onChainHash: ZERO_HASH,
    statusCode: 1,
    decision: fakeAllow(KNOWN_HASH),
  });
  assert.equal(r.verified, false);
  assert.match(r.reason, /work_not_yet_submitted/);
});

test('refuse when pact is in Refunded state', () => {
  const r = decideVerification({
    pactId: '999',
    manifestUrl: 'https://example.test/m.json',
    onChainHash: KNOWN_HASH,
    statusCode: 5, // Refunded
    decision: fakeAllow(KNOWN_HASH),
  });
  assert.equal(r.verified, false);
  assert.match(r.reason, /pact_not_in_verifiable_state/);
  assert.equal(r.pact_status, 'Refunded');
});

test('refuse when pact is in Disputed state', () => {
  const r = decideVerification({
    pactId: '999',
    manifestUrl: 'https://example.test/m.json',
    onChainHash: KNOWN_HASH,
    statusCode: 3, // Disputed
    decision: fakeAllow(KNOWN_HASH),
  });
  assert.equal(r.verified, false);
  assert.match(r.reason, /pact_not_in_verifiable_state/);
});

test('refuse on manifest 404 (sworn-verifier reason surfaced verbatim)', () => {
  const r = decideVerification({
    pactId: '16',
    manifestUrl: 'https://example.test/missing.json',
    onChainHash: KNOWN_HASH,
    statusCode: 1,
    decision: fakeRefuse('manifest_404', 404),
  });
  assert.equal(r.verified, false);
  assert.match(r.reason, /^manifest_refused: manifest_404$/);
  assert.equal(r.manifest_status_code, 404);
});

test('refuse on unknown_spec_version (AT-10 forward-compat refuse path)', () => {
  const r = decideVerification({
    pactId: '16',
    manifestUrl: 'https://example.test/m.json',
    onChainHash: KNOWN_HASH,
    statusCode: 1,
    decision: fakeRefuse('unknown_spec_version', 200, '99.99.99'),
  });
  assert.equal(r.verified, false);
  assert.match(r.reason, /^manifest_refused: unknown_spec_version$/);
});

test('refuse on hash mismatch (computed != on-chain)', () => {
  const wrongHash =
    '0xb5a3000000000000000000000000000000000000000000000000000000000000';
  const r = decideVerification({
    pactId: '16',
    manifestUrl: 'https://example.test/m.json',
    onChainHash: KNOWN_HASH,
    statusCode: 1,
    decision: fakeAllow(wrongHash),
  });
  assert.equal(r.verified, false);
  assert.match(r.reason, /^hash_mismatch:/);
  assert.equal(r.computed_hash, wrongHash);
  assert.equal(r.on_chain_hash, KNOWN_HASH);
});

test('allow on matching hash with WorkSubmitted state', () => {
  const r = decideVerification({
    pactId: '16',
    manifestUrl: 'https://example.test/at-clean-base-reference.json',
    onChainHash: KNOWN_HASH,
    statusCode: 1,
    decision: fakeAllow(KNOWN_HASH),
  });
  assert.equal(r.verified, true);
  assert.equal(r.pact_status, 'WorkSubmitted');
  assert.equal(r.computed_hash, KNOWN_HASH);
  assert.equal(r.on_chain_hash, KNOWN_HASH);
  assert.equal(r.spec_version, '3.0.0');
  assert.match(r.reason, /^verified:/);
});

test('allow on matching hash with Approved state (post-approval verification)', () => {
  const r = decideVerification({
    pactId: '16',
    manifestUrl: 'https://example.test/m.json',
    onChainHash: KNOWN_HASH,
    statusCode: 2, // Approved
    decision: fakeAllow(KNOWN_HASH),
  });
  assert.equal(r.verified, true);
  assert.equal(r.pact_status, 'Approved');
});

test('allow on matching hash with Released state (post-settlement verification)', () => {
  const r = decideVerification({
    pactId: '16',
    manifestUrl: 'https://example.test/m.json',
    onChainHash: KNOWN_HASH,
    statusCode: 4, // Released
    decision: fakeAllow(KNOWN_HASH),
  });
  assert.equal(r.verified, true);
  assert.equal(r.pact_status, 'Released');
});

test('case-insensitive hash comparison (on-chain returns mixed case)', () => {
  const mixedCase =
    '0xA67d40000000000000000000000000000000000000000000000000000000C0DE';
  const lower =
    '0xa67d40000000000000000000000000000000000000000000000000000000c0de';
  const r = decideVerification({
    pactId: '16',
    manifestUrl: 'https://example.test/m.json',
    onChainHash: mixedCase,
    statusCode: 1,
    decision: fakeAllow(lower),
  });
  assert.equal(r.verified, true);
  assert.equal(r.on_chain_hash, lower);
  assert.equal(r.computed_hash, lower);
});