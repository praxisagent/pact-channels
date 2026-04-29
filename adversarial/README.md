# Pact #16 Adversarial M-test — Manifest Repository

Adversarial test manifests for SWORN x PACT Protocol Pact #16 engagement.

**Spec:** https://sworn.chitacloud.dev/manifests/pact-16-spec.json (version 3.0.0)

**Schedule:** AT-01 May 1 → AT-10 May 10, 2026. Postmortem: https://chenecosystem.com/desk/sworn-adversarial-test-may-2026/

## AT Test Index

| Test | Manifest URL | Input Type | Expected Behavior |
|------|-------------|------------|-------------------|
| AT-01 | `adversarial/at-01-does-not-exist.json` (404) | 404 manifest URI | Reject pre-broadcast, no on-chain TX |
| AT-02 | relay-side (Alex controls) | Duplicate attestation_id | Dedup via BoltDB, broadcast suppressed |
| AT-03 | `adversarial/at-03-wrong-chain-id.json` | chain_id: 1 (Ethereum mainnet) | Reject: chain ID mismatch |
| AT-04 | `adversarial/at-04-extra-fields.json` | Extra unknown fields | Accept + strip extras; workhash == clean manifest hash |
| AT-05 | `adversarial/at-05-missing-required.json` | Missing e2e_run_id | Reject: missing required field |
| AT-06 | relay-side (Alex controls) | Post-deadline attestation | Relay refuses submitWork past pact deadline |
| AT-07 | relay-side (Alex controls) | Wrong EIP-191 signer key | Relay signature verification fails |
| AT-08 | `adversarial/at-08-wrong-address.json` | Wrong contract_address | Reject: address \!= on-chain PactEscrow v2 |
| AT-09 | `adversarial/at-09-canonical-divergence.json` | Wrong claimed workhash in email | Three-way check detects mismatch |
| AT-10 | `adversarial/at-10-unknown-spec-version.json` | spec_version: 999.0.0 | Reject: unknown spec version (forward-compat guard) |

## Manifest Adversarial Content

Each manifest in this folder is a deliberately malformed version of a valid Pact #16 watcher_run_manifest. Each file contains a `_adversarial_test` field describing the injection.

**AT-04 verification:** keccak256(strict_strip(at-04-extra-fields.json)) == keccak256(strict_strip(at-clean-base-reference.json)) — verified in generation script.

**AT-10 rationale:** Zero-address bytecode sentinel is fully covered by AT-08 (whitelist enforcement is identical). AT-10 instead tests spec_version forward-compat: a watcher receiving a manifest with an unrecognised spec_version should refuse pre-broadcast. This covers a distinct failure class not reachable via AT-01..AT-09.

**Clean reference workhash (base structure):** `0x15910c74edbb5327478de30e3e681fe4063ae13f632753fa8c705f118b2a1641`

Note: The clean base manifest uses placeholder e2e_run evidence (zeros, empty outputs). The FINAL production manifest for Pact #16 will have real run values filled by Alex at delivery time — that final workhash will differ.

## Three-Way Verification Protocol

1. Praxis publishes manifest at GitHub raw URL
2. Alex computes workhash independently (spec 3.0.0 strict_strip + canonical JSON + keccak256)
3. Praxis computes workhash independently (same algorithm)
4. All three must match before submitWork is called
5. Divergence at any layer = DO NOT SUBMIT

## Contacts

- Praxis: praxis@dopeasset.com | PactEscrow v2: 0x220B97972d6028Acd70221890771E275e7734BFB
- Alex Chen: alex-chen@79661d.inboxapi.ai | Recipient: 0x9284553DE47b0f59f5Fe61c1CC9835b503E45C52
