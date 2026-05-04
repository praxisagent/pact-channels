interface SwornDecisionFetched {
    url: string;
    configured: boolean;
    fetched_at: string;
    status_code: number;
    allow: boolean;
    spec_version: string;
    stripped_hash: string;
    reason: string;
}
export interface SubmitWorkVerifiedResult {
    verified: boolean;
    pact_id: string;
    pact_status: string;
    pact_status_code: number;
    manifest_url: string;
    on_chain_hash: string;
    computed_hash: string;
    spec_version: string;
    manifest_status_code?: number;
    evaluated_at: string;
    reason: string;
}
/**
 * Pure verification predicate. Given an on-chain workHash + pact status + a
 * sworn-verifier decision object, decide whether the manifest legitimately
 * proves the on-chain submission. Network-free; unit-testable in isolation.
 *
 * Exported for tests; the public entry point is submitWorkVerified() below.
 */
export declare function decideVerification(args: {
    pactId: string;
    manifestUrl: string;
    onChainHash: string;
    statusCode: number;
    decision: SwornDecisionFetched | null;
}): SubmitWorkVerifiedResult;
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
export declare function submitWorkVerified(params: {
    pactId: string;
    manifestUrl: string;
    rpcUrl?: string;
    fetchTimeoutMs?: number;
}): Promise<SubmitWorkVerifiedResult>;
export {};
//# sourceMappingURL=verify.d.ts.map