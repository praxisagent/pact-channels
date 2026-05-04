// Integration receipts — real Arbitrum RPC + real sworn manifests.
// Records the verifier output for each scenario and prints JSON for the PR receipt.

import { submitWorkVerified } from '../dist/verify.js';

const RPC = process.env.RPC_URL || 'https://arb1.arbitrum.io/rpc';

async function run(label, params) {
  const t0 = Date.now();
  let result;
  try {
    result = await submitWorkVerified({ ...params, rpcUrl: RPC });
  } catch (err) {
    result = { error: String(err && err.message ? err.message : err) };
  }
  const ms = Date.now() - t0;
  console.log('\n=== ' + label + ' (' + ms + 'ms) ===');
  console.log(JSON.stringify(result, null, 2));
}

await run('pact-16 active state, real manifest', {
  pactId: '16',
  manifestUrl: 'https://sworn.chitacloud.dev/manifests/at-clean-base-reference.json',
});

await run('pact-16 active state, missing manifest (404)', {
  pactId: '16',
  manifestUrl: 'https://sworn.chitacloud.dev/manifests/does-not-exist-' + Date.now() + '.json',
});

await run('pact-11 (settled), at-clean-base-reference', {
  pactId: '11',
  manifestUrl: 'https://sworn.chitacloud.dev/manifests/at-clean-base-reference.json',
});

await run('pact-13 (settled), at-clean-base-reference', {
  pactId: '13',
  manifestUrl: 'https://sworn.chitacloud.dev/manifests/at-clean-base-reference.json',
});