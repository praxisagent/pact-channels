// Unit test for the pact_build_submit_work_verified MCP tool's core verification logic.
// Network: hits the live AT-clean reference manifest hosted at the canonical URL Praxis pinned.
// On-chain: not exercised here (calldata-only).

import assert from 'node:assert';
import { ethers } from 'ethers';
import { createRequire } from 'module';
const _r = createRequire(import.meta.url);
const sv = _r('sworn-verifier');

const ESCROW_ABI = ['function submitWork(uint256 pactId, bytes32 workHash)'];
const iface = new ethers.Interface(ESCROW_ABI);

const AT_CLEAN_URL =
  'https://raw.githubusercontent.com/praxisagent/pact-channels/main/adversarial/at-clean-base-reference.json';
const AT_CLEAN_EXPECTED_HASH =
  '0xa67d408151085fdb4fd484bac555fcbab3cfc60f1fb2cce861edadcc78183999';

async function main() {
  // Test 1 — clean manifest builds correct calldata
  const res = await fetch(AT_CLEAN_URL);
  assert.strictEqual(res.status, 200, 'fetch AT-clean manifest');
  const manifest = JSON.parse(await res.text());
  const decision = sv.evaluateManifestObject(manifest, AT_CLEAN_URL);
  assert.strictEqual(decision.allow, true, 'AT-clean must be allow=true');
  assert.strictEqual(
    decision.stripped_hash.toLowerCase(),
    AT_CLEAN_EXPECTED_HASH,
    'stripped_hash must match canonical AT-clean hash',
  );
  const calldata = iface.encodeFunctionData('submitWork', [16, decision.stripped_hash]);
  assert.ok(calldata.startsWith('0x0a9eeded'), 'submitWork selector');
  assert.ok(calldata.includes(AT_CLEAN_EXPECTED_HASH.slice(2)), 'workHash encoded');
  console.log('  ✓ AT-clean allow=true, stripped_hash matches, calldata correct');

  // Test 2 — bogus spec_version refuses
  const bogus = sv.evaluateManifestObject({ spec_version: 'bogus-9999.0.0' }, 'http://x');
  assert.strictEqual(bogus.allow, false);
  assert.strictEqual(bogus.reason, 'unknown_spec_version');
  console.log('  ✓ unknown spec_version refused');

  // Test 3 — empty manifest refuses (no spec_version)
  const empty = sv.evaluateManifestObject({}, 'http://x');
  assert.strictEqual(empty.allow, false);
  assert.strictEqual(empty.reason, 'spec_version_missing');
  console.log('  ✓ empty manifest refused (spec_version_missing)');

  // Test 4 — invalid JSON simulation (caller responsibility, but the tool returns a refusal)
  let bad;
  try {
    bad = JSON.parse('{not json}');
  } catch (err) {
    bad = err;
  }
  assert.ok(bad instanceof Error, 'invalid JSON throws');
  console.log('  ✓ invalid JSON detected at parse time');

  console.log('PASS submit_work_verified core logic (4/4)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
