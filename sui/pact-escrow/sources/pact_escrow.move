/// PactEscrow — Trustless agent-to-agent service escrow on Sui
///
/// Port of PactEscrowV2.sol (deployed on Arbitrum One) to Sui Move.
/// Production record: 9,999+ PACT settled across adversarially-reviewed cycles.
///
/// Sui Move advantages over EVM for this use case:
///   - Balance<SUI> prevents double-spend at the language level (linear types)
///   - Shared object model eliminates reentrancy: no CEI pattern needed
///   - Object ownership maps cleanly to per-engagement lifecycle
///   - Clock object gives deterministic, manipulatable timestamps in tests
///
/// Lifecycle:
///   create()  → Active
///   submit_work() → WorkSubmitted
///   approve() or release() (after dispute window) → Complete
///   dispute() → Disputed
///   rule() → Complete | Refunded
///   finalize_arbitration() (after arb window) → Complete
///   reclaim() (after deadline, no work submitted) → Refunded
module pact_escrow::pact_escrow {
    use std::option::{Self, Option};
    use sui::object::{Self, UID};
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;

    // ─────────────────────── Constants ──────────────────────────────────────

    /// Minimum time creator has to dispute after work submitted: 1 hour (ms)
    const MIN_DISPUTE_WINDOW_MS: u64 = 3_600_000;

    /// Minimum time arbitrator has to rule after dispute raised: 24 hours (ms)
    const MIN_ARBITRATION_WINDOW_MS: u64 = 86_400_000;

    // Status constants (u8 discriminant stored in Pact.status)
    const STATUS_ACTIVE: u8         = 0;
    const STATUS_WORK_SUBMITTED: u8 = 1;
    const STATUS_DISPUTED: u8       = 2;
    const STATUS_COMPLETE: u8       = 3;
    const STATUS_REFUNDED: u8       = 4;

    // ─────────────────────── Error codes ────────────────────────────────────

    const E_ZERO_RECIPIENT: u64               = 1;
    const E_CREATOR_IS_RECIPIENT: u64         = 2;
    const E_ZERO_AMOUNT: u64                  = 3;
    const E_DEADLINE_IN_PAST: u64             = 4;
    const E_DISPUTE_WINDOW_TOO_SHORT: u64     = 5;
    const E_FEE_WITHOUT_ARBITRATOR: u64       = 6;
    const E_ARBITRATOR_IS_CREATOR: u64        = 7;
    const E_ARBITRATOR_IS_RECIPIENT: u64      = 8;
    const E_FEE_TOO_HIGH: u64                 = 9;
    const E_ARBITRATION_WINDOW_TOO_SHORT: u64 = 10;
    const E_NOT_ACTIVE: u64                   = 11;
    const E_NOT_RECIPIENT: u64                = 12;
    const E_DEADLINE_PASSED: u64              = 13;
    const E_NOT_WORK_SUBMITTED: u64           = 14;
    const E_NOT_CREATOR: u64                  = 15;
    const E_NO_ARBITRATOR: u64                = 16;
    const E_DISPUTE_WINDOW_CLOSED: u64        = 17;
    const E_DISPUTE_WINDOW_OPEN: u64          = 18;
    const E_NOT_DISPUTED: u64                 = 19;
    const E_NOT_ARBITRATOR: u64               = 20;
    const E_ARBITRATION_WINDOW_CLOSED: u64    = 21;
    const E_ARBITRATION_WINDOW_OPEN: u64      = 22;
    const E_WORK_ALREADY_SUBMITTED: u64       = 23;
    const E_DEADLINE_NOT_PASSED: u64          = 24;
    const E_WRONG_HASH_LENGTH: u64            = 25;

    // ─────────────────────── Core struct ────────────────────────────────────

    /// A Pact is a shared object representing a service escrow agreement.
    ///
    /// Shared so creator and recipient (and arbitrator) can all mutate it.
    /// Balance<SUI> holds the locked funds — linear type guarantees they cannot
    /// be duplicated or silently dropped.
    struct Pact has key {
        id: UID,
        creator: address,
        recipient: address,
        arbitrator: Option<address>,     // option::none() = no dispute capability
        amount: Balance<SUI>,            // Locked SUI in MIST (1 SUI = 1e9 MIST)
        arbitrator_fee_mist: u64,        // Paid to arbitrator if invoked (0 if no arb)
        deadline_ms: u64,                // Unix ms: work must be submitted before this
        dispute_window_ms: u64,          // Ms creator has to dispute after submit_work
        arbitration_window_ms: u64,      // Ms arbitrator has to rule after dispute()
        work_submitted_at_ms: u64,       // Set by submit_work()
        dispute_raised_at_ms: u64,       // Set by dispute()
        work_hash: vector<u8>,           // 32-byte SHA256 of off-chain evidence
        status: u8,                      // One of STATUS_* constants above
    }

    // ─────────────────────── Events ─────────────────────────────────────────

    struct PactCreated has copy, drop {
        pact_id: address,
        creator: address,
        recipient: address,
        has_arbitrator: bool,
        amount_mist: u64,
        deadline_ms: u64,
        dispute_window_ms: u64,
    }

    struct WorkSubmitted has copy, drop {
        pact_id: address,
        recipient: address,
        work_hash: vector<u8>,
    }

    struct PactApproved has copy, drop {
        pact_id: address,
        creator: address,
        amount_mist: u64,
    }

    struct PactDisputed has copy, drop {
        pact_id: address,
        creator: address,
    }

    struct ArbitrationRuled has copy, drop {
        pact_id: address,
        arbitrator: address,
        favor_recipient: bool,
    }

    struct PactReleased has copy, drop {
        pact_id: address,
        recipient: address,
        amount_mist: u64,
    }

    struct PactRefunded has copy, drop {
        pact_id: address,
        creator: address,
        amount_mist: u64,
    }

    struct ArbitrationFinalized has copy, drop {
        pact_id: address,
    }

    // ─────────────────────── Create ─────────────────────────────────────────

    /// Create a new escrow pact. Locks the provided SUI coin in a shared object.
    ///
    /// Parameters:
    ///   recipient          - Agent who performs the work (cannot be creator)
    ///   arbitrator_addr    - @0x0 = no arbitration capability; otherwise the arbitrator's address
    ///   arbitrator_fee_mist - MIST paid to arbitrator if invoked (must be 0 if no arbitrator,
    ///                         cannot exceed amount / 2)
    ///   deadline_ms        - Unix ms timestamp by which work must be submitted
    ///   dispute_window_ms  - How long creator has to dispute after work submission (≥ 1h)
    ///   arbitration_window_ms - How long arbitrator has to rule after dispute (≥ 24h, ignored if no arb)
    ///   payment            - The SUI coin to lock in escrow
    ///   clock              - Sui Clock object (required for timestamp)
    public entry fun create(
        recipient: address,
        arbitrator_addr: address,
        arbitrator_fee_mist: u64,
        deadline_ms: u64,
        dispute_window_ms: u64,
        arbitration_window_ms: u64,
        payment: Coin<SUI>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let amount_mist = coin::value(&payment);
        let now_ms = clock::timestamp_ms(clock);

        assert!(recipient != @0x0, E_ZERO_RECIPIENT);
        assert!(sender != recipient, E_CREATOR_IS_RECIPIENT);
        assert!(amount_mist > 0, E_ZERO_AMOUNT);
        assert!(deadline_ms > now_ms, E_DEADLINE_IN_PAST);
        assert!(dispute_window_ms >= MIN_DISPUTE_WINDOW_MS, E_DISPUTE_WINDOW_TOO_SHORT);

        let arbitrator: Option<address> = if (arbitrator_addr == @0x0) {
            assert!(arbitrator_fee_mist == 0, E_FEE_WITHOUT_ARBITRATOR);
            // arbitration_window_ms is irrelevant but we don't restrict it
            option::none()
        } else {
            assert!(arbitrator_addr != sender, E_ARBITRATOR_IS_CREATOR);
            assert!(arbitrator_addr != recipient, E_ARBITRATOR_IS_RECIPIENT);
            // Fee cannot exceed half the locked amount (prevents fee-as-ransom attack)
            assert!(arbitrator_fee_mist <= amount_mist / 2, E_FEE_TOO_HIGH);
            assert!(arbitration_window_ms >= MIN_ARBITRATION_WINDOW_MS, E_ARBITRATION_WINDOW_TOO_SHORT);
            option::some(arbitrator_addr)
        };

        let has_arbitrator = option::is_some(&arbitrator);

        let pact = Pact {
            id: object::new(ctx),
            creator: sender,
            recipient,
            arbitrator,
            amount: coin::into_balance(payment),
            arbitrator_fee_mist,
            deadline_ms,
            dispute_window_ms,
            arbitration_window_ms,
            work_submitted_at_ms: 0,
            dispute_raised_at_ms: 0,
            work_hash: vector[],
            status: STATUS_ACTIVE,
        };

        let pact_id = object::uid_to_address(&pact.id);

        event::emit(PactCreated {
            pact_id,
            creator: sender,
            recipient,
            has_arbitrator,
            amount_mist,
            deadline_ms,
            dispute_window_ms,
        });

        // Share so all parties (creator, recipient, arbitrator, anyone for release()) can act
        transfer::share_object(pact);
    }

    // ─────────────────────── Submit Work ────────────────────────────────────

    /// Recipient commits SHA256 hash of their work output on-chain.
    /// Starts the dispute window. Creator cannot reclaim after this point.
    ///
    /// work_hash must be exactly 32 bytes (SHA256 output).
    /// The preimage (actual work) is shared off-chain; the on-chain hash is the commitment.
    public entry fun submit_work(
        pact: &mut Pact,
        work_hash: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Validate hash length first (32 bytes = SHA256)
        assert!(std::vector::length(&work_hash) == 32, E_WRONG_HASH_LENGTH);
        assert!(pact.status == STATUS_ACTIVE, E_NOT_ACTIVE);
        assert!(tx_context::sender(ctx) == pact.recipient, E_NOT_RECIPIENT);
        let now_ms = clock::timestamp_ms(clock);
        assert!(now_ms <= pact.deadline_ms, E_DEADLINE_PASSED);

        pact.status = STATUS_WORK_SUBMITTED;
        pact.work_submitted_at_ms = now_ms;
        pact.work_hash = work_hash;

        event::emit(WorkSubmitted {
            pact_id: object::uid_to_address(&pact.id),
            recipient: pact.recipient,
            work_hash: pact.work_hash,
        });
    }

    // ─────────────────────── Approve ────────────────────────────────────────

    /// Creator accepts the submitted work and releases locked SUI immediately.
    /// No need to wait for the dispute window.
    public entry fun approve(
        pact: &mut Pact,
        ctx: &mut TxContext
    ) {
        assert!(pact.status == STATUS_WORK_SUBMITTED, E_NOT_WORK_SUBMITTED);
        assert!(tx_context::sender(ctx) == pact.creator, E_NOT_CREATOR);

        let recipient = pact.recipient;
        let amount_mist = balance::value(&pact.amount);
        pact.status = STATUS_COMPLETE;

        let payout = coin::from_balance(balance::withdraw_all(&mut pact.amount), ctx);
        transfer::public_transfer(payout, recipient);

        event::emit(PactApproved {
            pact_id: object::uid_to_address(&pact.id),
            creator: pact.creator,
            amount_mist,
        });
        event::emit(PactReleased {
            pact_id: object::uid_to_address(&pact.id),
            recipient,
            amount_mist,
        });
    }

    // ─────────────────────── Dispute ────────────────────────────────────────

    /// Creator contests the submitted work, invoking the arbitrator.
    /// Must be called within the dispute window. Arbitrator must have been set at creation.
    public entry fun dispute(
        pact: &mut Pact,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(pact.status == STATUS_WORK_SUBMITTED, E_NOT_WORK_SUBMITTED);
        assert!(tx_context::sender(ctx) == pact.creator, E_NOT_CREATOR);
        assert!(option::is_some(&pact.arbitrator), E_NO_ARBITRATOR);
        let now_ms = clock::timestamp_ms(clock);
        assert!(
            now_ms <= pact.work_submitted_at_ms + pact.dispute_window_ms,
            E_DISPUTE_WINDOW_CLOSED
        );

        pact.status = STATUS_DISPUTED;
        pact.dispute_raised_at_ms = now_ms;

        event::emit(PactDisputed {
            pact_id: object::uid_to_address(&pact.id),
            creator: pact.creator,
        });
    }

    // ─────────────────────── Release ────────────────────────────────────────

    /// Releases SUI to recipient after the dispute window expires without a dispute.
    ///
    /// Callable by ANYONE — not just recipient. This makes auto-release possible
    /// without the recipient being online (KeeperHub pattern).
    public entry fun release(
        pact: &mut Pact,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(pact.status == STATUS_WORK_SUBMITTED, E_NOT_WORK_SUBMITTED);
        let now_ms = clock::timestamp_ms(clock);
        assert!(
            now_ms > pact.work_submitted_at_ms + pact.dispute_window_ms,
            E_DISPUTE_WINDOW_OPEN
        );

        let recipient = pact.recipient;
        let amount_mist = balance::value(&pact.amount);
        pact.status = STATUS_COMPLETE;

        let payout = coin::from_balance(balance::withdraw_all(&mut pact.amount), ctx);
        transfer::public_transfer(payout, recipient);

        event::emit(PactReleased {
            pact_id: object::uid_to_address(&pact.id),
            recipient,
            amount_mist,
        });
    }

    // ─────────────────────── Rule ────────────────────────────────────────────

    /// Arbitrator rules on the dispute. Must rule within the arbitration window.
    ///
    /// favor_recipient = true:  recipient wins, gets amount minus arb fee
    /// favor_recipient = false: creator wins (refunded), gets amount minus arb fee
    /// In both cases, arbitrator receives their fee for acting.
    public entry fun rule(
        pact: &mut Pact,
        favor_recipient: bool,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(pact.status == STATUS_DISPUTED, E_NOT_DISPUTED);
        assert!(option::is_some(&pact.arbitrator), E_NO_ARBITRATOR);
        let sender = tx_context::sender(ctx);
        assert!(sender == *option::borrow(&pact.arbitrator), E_NOT_ARBITRATOR);
        let now_ms = clock::timestamp_ms(clock);
        assert!(
            now_ms <= pact.dispute_raised_at_ms + pact.arbitration_window_ms,
            E_ARBITRATION_WINDOW_CLOSED
        );

        let fee = pact.arbitrator_fee_mist;
        let total = balance::value(&pact.amount);
        let remainder = total - fee;

        event::emit(ArbitrationRuled {
            pact_id: object::uid_to_address(&pact.id),
            arbitrator: sender,
            favor_recipient,
        });

        if (favor_recipient) {
            let recipient = pact.recipient;
            pact.status = STATUS_COMPLETE;

            if (fee > 0) {
                let fee_coin = coin::from_balance(
                    balance::split(&mut pact.amount, fee), ctx
                );
                transfer::public_transfer(fee_coin, sender);
            };

            let payout = coin::from_balance(balance::withdraw_all(&mut pact.amount), ctx);
            transfer::public_transfer(payout, recipient);

            event::emit(PactReleased {
                pact_id: object::uid_to_address(&pact.id),
                recipient,
                amount_mist: remainder,
            });
        } else {
            let creator = pact.creator;
            pact.status = STATUS_REFUNDED;

            if (fee > 0) {
                let fee_coin = coin::from_balance(
                    balance::split(&mut pact.amount, fee), ctx
                );
                transfer::public_transfer(fee_coin, sender);
            };

            let refund = coin::from_balance(balance::withdraw_all(&mut pact.amount), ctx);
            transfer::public_transfer(refund, creator);

            event::emit(PactRefunded {
                pact_id: object::uid_to_address(&pact.id),
                creator,
                amount_mist: remainder,
            });
        }
    }

    // ─────────────────────── Finalize Arbitration ────────────────────────────

    /// If arbitrator doesn't rule within the arbitration window, anyone can finalize.
    ///
    /// Arbitrator forfeits their fee for inaction. Full amount goes to recipient.
    /// This prevents arbitrator from griefing either party by going silent.
    /// Callable by ANYONE (KeeperHub pattern).
    public entry fun finalize_arbitration(
        pact: &mut Pact,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(pact.status == STATUS_DISPUTED, E_NOT_DISPUTED);
        let now_ms = clock::timestamp_ms(clock);
        assert!(
            now_ms > pact.dispute_raised_at_ms + pact.arbitration_window_ms,
            E_ARBITRATION_WINDOW_OPEN
        );

        let recipient = pact.recipient;
        let amount_mist = balance::value(&pact.amount);
        pact.status = STATUS_COMPLETE;

        // Arbitrator gets nothing for not acting — full amount to recipient
        let payout = coin::from_balance(balance::withdraw_all(&mut pact.amount), ctx);
        transfer::public_transfer(payout, recipient);

        event::emit(ArbitrationFinalized {
            pact_id: object::uid_to_address(&pact.id),
        });
        event::emit(PactReleased {
            pact_id: object::uid_to_address(&pact.id),
            recipient,
            amount_mist,
        });
    }

    // ─────────────────────── Reclaim ────────────────────────────────────────

    /// Creator reclaims SUI after deadline passes without work being submitted.
    ///
    /// Critical invariant (same as v2 Solidity): this function ONLY works from
    /// STATUS_ACTIVE. Once submit_work() is called, creator CANNOT reclaim — the
    /// recipient has acted in good faith. Creator must dispute instead.
    public entry fun reclaim(
        pact: &mut Pact,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(pact.status == STATUS_ACTIVE, E_WORK_ALREADY_SUBMITTED);
        assert!(tx_context::sender(ctx) == pact.creator, E_NOT_CREATOR);
        let now_ms = clock::timestamp_ms(clock);
        assert!(now_ms > pact.deadline_ms, E_DEADLINE_NOT_PASSED);

        let creator = pact.creator;
        let amount_mist = balance::value(&pact.amount);
        pact.status = STATUS_REFUNDED;

        let refund = coin::from_balance(balance::withdraw_all(&mut pact.amount), ctx);
        transfer::public_transfer(refund, creator);

        event::emit(PactRefunded {
            pact_id: object::uid_to_address(&pact.id),
            creator,
            amount_mist,
        });
    }

    // ─────────────────────── View functions ──────────────────────────────────

    public fun get_status(pact: &Pact): u8 { pact.status }
    public fun get_creator(pact: &Pact): address { pact.creator }
    public fun get_recipient(pact: &Pact): address { pact.recipient }
    public fun get_amount_mist(pact: &Pact): u64 { balance::value(&pact.amount) }
    public fun get_deadline_ms(pact: &Pact): u64 { pact.deadline_ms }
    public fun get_work_hash(pact: &Pact): vector<u8> { pact.work_hash }
    public fun has_arbitrator(pact: &Pact): bool { option::is_some(&pact.arbitrator) }

    /// True if the dispute window has elapsed and release() can be called
    public fun is_releaseable(pact: &Pact, clock: &Clock): bool {
        pact.status == STATUS_WORK_SUBMITTED &&
        clock::timestamp_ms(clock) > pact.work_submitted_at_ms + pact.dispute_window_ms
    }

    /// True if arbitration has timed out and finalize_arbitration() can be called
    public fun is_arbitration_timed_out(pact: &Pact, clock: &Clock): bool {
        pact.status == STATUS_DISPUTED &&
        clock::timestamp_ms(clock) > pact.dispute_raised_at_ms + pact.arbitration_window_ms
    }

    // ─────────────────────── Status constants (for external use) ────────────

    public fun status_active(): u8 { STATUS_ACTIVE }
    public fun status_work_submitted(): u8 { STATUS_WORK_SUBMITTED }
    public fun status_disputed(): u8 { STATUS_DISPUTED }
    public fun status_complete(): u8 { STATUS_COMPLETE }
    public fun status_refunded(): u8 { STATUS_REFUNDED }
}
