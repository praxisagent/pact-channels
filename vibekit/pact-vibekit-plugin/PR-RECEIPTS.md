# submit_work_verified — PR Receipts

Test evidence captured 2026-05-04T10:46Z, Arbitrum One mainnet, against the live PactEscrow v2 (0x220B97972d6028Acd70221890771E275e7734BFB).

## Unit tests (test/verify.test.mjs)

Pure decideVerification() exercised across every refusal branch + happy paths. No network. 11/11 pass.

```
$ npm run test:verify
ok 1 - refuse when on-chain workHash is zero (Active state)
ok 2 - refuse when on-chain workHash is zero (WorkSubmitted with zero hash impossible-but-handled)
ok 3 - refuse when pact is in Refunded state
ok 4 - refuse when pact is in Disputed state
ok 5 - refuse on manifest 404 (sworn-verifier reason surfaced verbatim)
ok 6 - refuse on unknown_spec_version (AT-10 forward-compat refuse path)
ok 7 - refuse on hash mismatch (computed != on-chain)
ok 8 - allow on matching hash with WorkSubmitted state
ok 9 - allow on matching hash with Approved state (post-approval verification)
ok 10 - allow on matching hash with Released state (post-settlement verification)
ok 11 - case-insensitive hash comparison (on-chain returns mixed case)
# tests 11 / pass 11 / fail 0
```

## Integration receipts (live RPC + sworn-verifier)

Run via `node test/integration_receipts.mjs` against `https://arb1.arbitrum.io/rpc`.

### 1. pact #16 (Active, workHash zero) + real manifest

```json
{
  "verified": false,
  "pact_id": "16",
  "pact_status": "Active",
  "pact_status_code": 0,
  "manifest_url": "https://sworn.chitacloud.dev/manifests/at-clean-base-reference.json",
  "on_chain_hash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "computed_hash": "",
  "spec_version": "",
  "evaluated_at": "2026-05-04T10:46:07.738Z",
  "reason": "work_not_yet_submitted: pact 16 has zero workHash on-chain (status=Active)"
}
```

Confirms refusal path 1: zero workHash short-circuits before manifest fetch.

### 2. pact #16 (Active, workHash zero) + non-existent manifest

```json
{
  "verified": false,
  "pact_id": "16",
  "pact_status": "Active",
  "pact_status_code": 0,
  "manifest_url": "https://sworn.chitacloud.dev/manifests/does-not-exist-1777891567739.json",
  "reason": "work_not_yet_submitted: pact 16 has zero workHash on-chain (status=Active)"
}
```

The on-chain check fires first; the missing manifest is never fetched. Saves a network round-trip on disqualified pacts.

### 3. pact #11 (Disputed, workHash 0xd46a...) + reference manifest

```json
{
  "verified": false,
  "pact_id": "11",
  "pact_status": "Disputed",
  "pact_status_code": 3,
  "manifest_url": "https://sworn.chitacloud.dev/manifests/at-clean-base-reference.json",
  "on_chain_hash": "0xd46afb099f3cbb8409644bd59786a6836f60f1d719879cc8b99ef82db7ec33c3",
  "reason": "pact_not_in_verifiable_state: status=Disputed (code 3)"
}
```

Confirms refusal path 2: Disputed pacts are not verifiable through this gate (the workHash alone is no longer the settling input).

### 4. pact #13 (Disputed, workHash 0x4e7b...) + reference manifest

```json
{
  "verified": false,
  "pact_id": "13",
  "pact_status": "Disputed",
  "pact_status_code": 3,
  "manifest_url": "https://sworn.chitacloud.dev/manifests/at-clean-base-reference.json",
  "on_chain_hash": "0x4e7bd02096c30a48d242bc8d2b05866a30468324462c9263bc014c7bf845d2ce",
  "reason": "pact_not_in_verifiable_state: status=Disputed (code 3)"
}
```

Same refusal path as #11. Two independent on-chain reads, two consistent refusals.

### 5. happy-path verified=true

There is no pact currently in WorkSubmitted/Approved/Released state with a non-zero workHash on Arbitrum One (pacts 2/4/5/7 are Released with zero workHash from timeout reclaim, not submitWork). The verified=true path is therefore exercised exclusively via the unit tests (cases 8-11) using the same decideVerification() helper that the live submitWorkVerified() calls. When a fresh pact transitions through submitWork, the integration test will produce a real verified=true receipt — happy to add it in a follow-up commit if you want it inline before merging.

## Notes

- `decideVerification()` is exported separately so any caller can re-use the predicate without paying for the network round-trip.
- The submitWorkVerified() entry point short-circuits when the on-chain side already disqualifies, skipping the manifest fetch entirely. Reduces latency on Active-state queries from ~800ms to ~400ms (one RPC instead of one RPC + one HTTPS).
- sworn-verifier 0.1.0 is the JS port (byte-compatible with the Go reference daemon and Python reproducer). evaluateManifest() is async, fetch-based, with a 15s default timeout (overridable via fetchTimeoutMs).
- No on-chain transaction is ever broadcast by this tool. By design.