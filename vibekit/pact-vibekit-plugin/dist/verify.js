import { ethers } from 'ethers';
import { createRequire } from 'module';
import { PACT_ESCROW_V2, ESCROW_ABI, PactStatus, RPC_URL_DEFAULT, } from './constants.js';
// sworn-verifier ships as CommonJS; use createRequire so this module
// keeps "type": "module" + NodeNext resolution working.
const require = createRequire(import.meta.url);
const swornVerifier = require('sworn-verifier');
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';
const PACT_STATUS_NAMES = {
    0: 'Active',
    1: 'WorkSubmitted',
    2: 'Approved',
    3: 'Disputed',
    4: 'Released',
    5: 'Refunded',
    6: 'ArbitrationRuled',
};
/**
 * Pure verification predicate. Given an on-chain workHash + pact status + a
 * sworn-verifier decision object, decide whether the manifest legitimately
 * proves the on-chain submission. Network-free; unit-testable in isolation.
 *
 * Exported for tests; the public entry point is submitWorkVerified() below.
 */
export function decideVerification(args) {
    const onChainHash = (args.onChainHash || ZERO_HASH).toLowerCase();
    const statusName = PACT_STATUS_NAMES[args.statusCode] ?? 'Unknown';
    const base = {
        verified: false,
        pact_id: args.pactId,
        pact_status: statusName,
        pact_status_code: args.statusCode,
        manifest_url: args.manifestUrl,
        on_chain_hash: onChainHash,
        computed_hash: '',
        spec_version: '',
        evaluated_at: new Date().toISOString(),
        reason: '',
    };
    // Refuse if workHash is unset — nothing to verify against.
    if (onChainHash === ZERO_HASH) {
        return {
            ...base,
            reason: 'work_not_yet_submitted: pact ' +
                args.pactId +
                ' has zero workHash on-chain (status=' +
                statusName +
                ')',
        };
    }
    // Refuse if pact is not in a state where the on-chain workHash is the
    // settling hash. WorkSubmitted is the canonical case (approver verifying
    // before approve()); Approved/Released keep the same workHash and are also
    // valid for historical verification. Other statuses (Refunded, Disputed,
    // ArbitrationRuled) mean the pact is no longer settling on the submitted
    // hash alone — refuse explicitly so the caller knows.
    if (args.statusCode !== PactStatus.WorkSubmitted &&
        args.statusCode !== PactStatus.Approved &&
        args.statusCode !== PactStatus.Released) {
        return {
            ...base,
            reason: 'pact_not_in_verifiable_state: status=' +
                statusName +
                ' (code ' +
                args.statusCode +
                ')',
        };
    }
    if (!args.decision) {
        return {
            ...base,
            reason: 'manifest_decision_missing',
        };
    }
    base.spec_version = args.decision.spec_version;
    base.computed_hash = (args.decision.stripped_hash || '').toLowerCase();
    base.manifest_status_code = args.decision.status_code;
    if (!args.decision.allow) {
        return {
            ...base,
            reason: 'manifest_refused: ' + (args.decision.reason || 'unknown'),
        };
    }
    if (base.computed_hash !== onChainHash) {
        return {
            ...base,
            reason: 'hash_mismatch: on_chain=' +
                onChainHash +
                ' computed=' +
                base.computed_hash,
        };
    }
    return {
        ...base,
        verified: true,
        reason: 'verified: manifest stripped_hash matches on-chain workHash',
    };
}
/**
 * Verify that a SWORN manifest's stripped_hash matches the on-chain workHash
 * recorded in PactEscrow.pacts(pactId).workHash.
 *
 * Per agreement with Praxis (2026-05-04T10:28Z): the on-chain workHash is the
 * sole authoritative source. The tool refuses to operate when:
 *   - workHash is still zero (submitWork has not been called yet)
 *   - pact status is not WorkSubmitted / Approved / Released
 *   - the manifest itself does not pass sworn-verifier (allow != true)
 *   - the canonical stripped_hash diverges from the on-chain workHash
 *
 * No on-chain transaction is broadcast; this is a pre-approve verification gate.
 * The intended consumer is an approver wallet about to call PactEscrow.approve(pactId)
 * who wants an independent, byte-compatible recomputation of the workHash before
 * signing the approve tx.
 */
export async function submitWorkVerified(params) {
    const rpcUrl = params.rpcUrl ?? RPC_URL_DEFAULT;
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const escrow = new ethers.Contract(PACT_ESCROW_V2, ESCROW_ABI, provider);
    const pact = await escrow.getPact(params.pactId);
    const onChainHash = (pact.workHash ?? ZERO_HASH).toLowerCase();
    const statusCode = Number(pact.status);
    // Skip the manifest fetch entirely if the on-chain side already disqualifies.
    if (onChainHash === ZERO_HASH ||
        (statusCode !== PactStatus.WorkSubmitted &&
            statusCode !== PactStatus.Approved &&
            statusCode !== PactStatus.Released)) {
        return decideVerification({
            pactId: params.pactId,
            manifestUrl: params.manifestUrl,
            onChainHash,
            statusCode,
            decision: null,
        });
    }
    let decision;
    try {
        decision = await swornVerifier.evaluateManifest(params.manifestUrl, {
            timeoutMs: params.fetchTimeoutMs ?? 15000,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return decideVerification({
            pactId: params.pactId,
            manifestUrl: params.manifestUrl,
            onChainHash,
            statusCode,
            decision: {
                url: params.manifestUrl,
                configured: true,
                fetched_at: new Date().toISOString(),
                status_code: 0,
                allow: false,
                spec_version: '',
                stripped_hash: '',
                reason: 'fetch_unhandled_error: ' + msg,
            },
        });
    }
    return decideVerification({
        pactId: params.pactId,
        manifestUrl: params.manifestUrl,
        onChainHash,
        statusCode,
        decision,
    });
}
//# sourceMappingURL=verify.js.map