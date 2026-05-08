/// PactEscrow test suite — covers all state transitions
///
/// Tests mirror the adversarial test cases (AT-01 through AT-10) that
/// verified PactEscrowV2.sol on Arbitrum. Every lifecycle path is covered.
#[test_only]
module pact_escrow::pact_escrow_tests {
    use std::vector;
    use sui::coin::{Self};
    use sui::sui::SUI;
    use sui::clock::{Self};
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::test_utils::assert_eq;
    use pact_escrow::pact_escrow::{Self, Pact};

    // ─── Addresses ───────────────────────────────────────────────────────────

    const CREATOR: address    = @0xCA;
    const RECIPIENT: address  = @0xBE;
    const ARBITRATOR: address = @0xAA;
    const STRANGER: address   = @0x1234;

    // ─── Time helpers (ms) ───────────────────────────────────────────────────

    const ONE_HOUR_MS: u64   = 3_600_000;
    const ONE_DAY_MS: u64    = 86_400_000;
    const START_MS: u64      = 1_000_000_000_000; // arbitrary start epoch

    // Deadline: 7 days from start
    fun deadline(): u64 { START_MS + 7 * ONE_DAY_MS }
    // Dispute window: exactly 1 hour (minimum)
    fun dispute_window(): u64 { ONE_HOUR_MS }
    // Arbitration window: exactly 24 hours (minimum)
    fun arb_window(): u64 { ONE_DAY_MS }

    // ─── Test helpers ────────────────────────────────────────────────────────

    /// Creates a dummy 32-byte SHA256 work hash
    fun dummy_hash(): vector<u8> {
        let h = vector::empty<u8>();
        let i = 0;
        while (i < 32) {
            vector::push_back(&mut h, (i as u8));
            i = i + 1;
        };
        h
    }

    /// Creates a SUI coin with the given MIST value for testing
    fun mint_sui(amount: u64, ctx: &mut sui::tx_context::TxContext): coin::Coin<SUI> {
        coin::mint_for_testing<SUI>(amount, ctx)
    }

    /// Convenience: create a pact with no arbitrator
    fun create_simple_pact(scenario: &mut Scenario, amount: u64) {
        ts::next_tx(scenario, CREATOR);
        {
            let clock = clock::create_for_testing(ts::ctx(scenario));
            clock::set_for_testing(&mut clock, START_MS);
            let payment = mint_sui(amount, ts::ctx(scenario));
            pact_escrow::create(
                RECIPIENT,
                @0x0,           // no arbitrator
                0,              // no arb fee
                deadline(),
                dispute_window(),
                0,              // arb window irrelevant (no arb)
                payment,
                &clock,
                ts::ctx(scenario)
            );
            clock::destroy_for_testing(clock);
        };
    }

    /// Convenience: create a pact with arbitrator
    fun create_pact_with_arb(scenario: &mut Scenario, amount: u64, arb_fee: u64) {
        ts::next_tx(scenario, CREATOR);
        {
            let clock = clock::create_for_testing(ts::ctx(scenario));
            clock::set_for_testing(&mut clock, START_MS);
            let payment = mint_sui(amount, ts::ctx(scenario));
            pact_escrow::create(
                RECIPIENT,
                ARBITRATOR,
                arb_fee,
                deadline(),
                dispute_window(),
                arb_window(),
                payment,
                &clock,
                ts::ctx(scenario)
            );
            clock::destroy_for_testing(clock);
        };
    }

    // ─────────────────────── Lifecycle tests ────────────────────────────────

    /// Happy path: create → submit_work → approve
    #[test]
    fun test_happy_path_approve() {
        let scenario = ts::begin(CREATOR);

        // Create pact
        create_simple_pact(&mut scenario, 1_000_000_000); // 1 SUI

        // Recipient submits work
        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS); // 1h after start
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            assert_eq(pact_escrow::get_status(&pact), pact_escrow::status_work_submitted());
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // Creator approves
        ts::next_tx(&mut scenario, CREATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            pact_escrow::approve(&mut pact, ts::ctx(&mut scenario));
            assert_eq(pact_escrow::get_status(&pact), pact_escrow::status_complete());
            assert_eq(pact_escrow::get_amount_mist(&pact), 0); // Balance drained
            ts::return_shared(pact);
        };

        // Verify recipient received SUI coin
        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let coin = ts::take_from_address<coin::Coin<SUI>>(&scenario, RECIPIENT);
            assert_eq(coin::value(&coin), 1_000_000_000);
            ts::return_to_address(RECIPIENT, coin);
        };

        ts::end(scenario);
    }

    /// Happy path: create → submit_work → release (after dispute window)
    #[test]
    fun test_happy_path_auto_release() {
        let scenario = ts::begin(CREATOR);

        create_simple_pact(&mut scenario, 500_000_000); // 0.5 SUI

        // Recipient submits work
        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS);
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // Wait out the dispute window, then anyone can release
        ts::next_tx(&mut scenario, STRANGER); // STRANGER triggers release
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            // Set clock to after dispute window
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS + dispute_window() + 1);
            assert_eq(pact_escrow::is_releaseable(&pact, &clock), true);
            pact_escrow::release(&mut pact, &clock, ts::ctx(&mut scenario));
            assert_eq(pact_escrow::get_status(&pact), pact_escrow::status_complete());
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::end(scenario);
    }

    /// Creator reclaims after deadline (no work submitted)
    #[test]
    fun test_reclaim_after_deadline() {
        let scenario = ts::begin(CREATOR);

        create_simple_pact(&mut scenario, 1_000_000_000);

        ts::next_tx(&mut scenario, CREATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, deadline() + 1); // Just after deadline
            pact_escrow::reclaim(&mut pact, &clock, ts::ctx(&mut scenario));
            assert_eq(pact_escrow::get_status(&pact), pact_escrow::status_refunded());
            assert_eq(pact_escrow::get_amount_mist(&pact), 0);
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::end(scenario);
    }

    /// Full arbitration path: creator wins
    #[test]
    fun test_arbitration_creator_wins() {
        let scenario = ts::begin(CREATOR);

        create_pact_with_arb(&mut scenario, 1_000_000_000, 100_000_000); // 100M MIST fee

        // Recipient submits work
        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS);
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // Creator disputes within window
        ts::next_tx(&mut scenario, CREATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS + 1000); // within dispute window
            pact_escrow::dispute(&mut pact, &clock, ts::ctx(&mut scenario));
            assert_eq(pact_escrow::get_status(&pact), pact_escrow::status_disputed());
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // Arbitrator rules for creator
        ts::next_tx(&mut scenario, ARBITRATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + 2 * ONE_HOUR_MS);
            pact_escrow::rule(&mut pact, false, &clock, ts::ctx(&mut scenario)); // false = creator wins
            assert_eq(pact_escrow::get_status(&pact), pact_escrow::status_refunded());
            assert_eq(pact_escrow::get_amount_mist(&pact), 0);
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // Verify creator got back 900M MIST (1B - 100M fee)
        ts::next_tx(&mut scenario, CREATOR);
        {
            let coin = ts::take_from_address<coin::Coin<SUI>>(&scenario, CREATOR);
            assert_eq(coin::value(&coin), 900_000_000);
            ts::return_to_address(CREATOR, coin);
        };

        // Verify arbitrator got 100M MIST fee
        ts::next_tx(&mut scenario, ARBITRATOR);
        {
            let coin = ts::take_from_address<coin::Coin<SUI>>(&scenario, ARBITRATOR);
            assert_eq(coin::value(&coin), 100_000_000);
            ts::return_to_address(ARBITRATOR, coin);
        };

        ts::end(scenario);
    }

    /// Full arbitration path: recipient wins
    #[test]
    fun test_arbitration_recipient_wins() {
        let scenario = ts::begin(CREATOR);

        create_pact_with_arb(&mut scenario, 1_000_000_000, 50_000_000);

        // Submit work
        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS);
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // Creator disputes
        ts::next_tx(&mut scenario, CREATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS + 1000);
            pact_escrow::dispute(&mut pact, &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // Arbitrator rules for recipient
        ts::next_tx(&mut scenario, ARBITRATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + 2 * ONE_HOUR_MS);
            pact_escrow::rule(&mut pact, true, &clock, ts::ctx(&mut scenario)); // true = recipient wins
            assert_eq(pact_escrow::get_status(&pact), pact_escrow::status_complete());
            assert_eq(pact_escrow::get_amount_mist(&pact), 0);
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // Verify recipient got 950M MIST (1B - 50M fee)
        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let coin = ts::take_from_address<coin::Coin<SUI>>(&scenario, RECIPIENT);
            assert_eq(coin::value(&coin), 950_000_000);
            ts::return_to_address(RECIPIENT, coin);
        };

        ts::end(scenario);
    }

    /// Arbitrator timeout: full amount to recipient, arb gets nothing
    #[test]
    fun test_arbitration_timeout_finalizes_for_recipient() {
        let scenario = ts::begin(CREATOR);

        create_pact_with_arb(&mut scenario, 1_000_000_000, 200_000_000);

        // Submit + dispute
        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS);
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::next_tx(&mut scenario, CREATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS + 1000);
            pact_escrow::dispute(&mut pact, &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // Arb window expires, stranger finalizes
        ts::next_tx(&mut scenario, STRANGER);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            let expire_ms = START_MS + ONE_HOUR_MS + 1000 + arb_window() + 1;
            clock::set_for_testing(&mut clock, expire_ms);
            assert_eq(pact_escrow::is_arbitration_timed_out(&pact, &clock), true);
            pact_escrow::finalize_arbitration(&mut pact, &clock, ts::ctx(&mut scenario));
            assert_eq(pact_escrow::get_status(&pact), pact_escrow::status_complete());
            assert_eq(pact_escrow::get_amount_mist(&pact), 0);
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // Recipient gets full 1 SUI (arb forfeits fee for inaction)
        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let coin = ts::take_from_address<coin::Coin<SUI>>(&scenario, RECIPIENT);
            assert_eq(coin::value(&coin), 1_000_000_000);
            ts::return_to_address(RECIPIENT, coin);
        };

        ts::end(scenario);
    }

    // ─────────────────────── Adversarial tests ──────────────────────────────

    /// AT-01: Stranger cannot submit_work (only recipient)
    #[test]
    #[expected_failure(abort_code = pact_escrow::pact_escrow::E_NOT_RECIPIENT)]
    fun test_at01_stranger_cannot_submit_work() {
        let scenario = ts::begin(CREATOR);
        create_simple_pact(&mut scenario, 1_000_000_000);

        ts::next_tx(&mut scenario, STRANGER);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + 100);
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::end(scenario);
    }

    /// AT-02: Creator cannot reclaim after work is submitted
    #[test]
    #[expected_failure(abort_code = pact_escrow::pact_escrow::E_WORK_ALREADY_SUBMITTED)]
    fun test_at02_creator_cannot_reclaim_after_work_submitted() {
        let scenario = ts::begin(CREATOR);
        create_simple_pact(&mut scenario, 1_000_000_000);

        // Recipient submits
        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS);
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // Creator tries to reclaim — must fail (core v1 fix)
        ts::next_tx(&mut scenario, CREATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, deadline() + 1);
            pact_escrow::reclaim(&mut pact, &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::end(scenario);
    }

    /// AT-03: Cannot release during open dispute window
    #[test]
    #[expected_failure(abort_code = pact_escrow::pact_escrow::E_DISPUTE_WINDOW_OPEN)]
    fun test_at03_cannot_release_during_dispute_window() {
        let scenario = ts::begin(CREATOR);
        create_simple_pact(&mut scenario, 1_000_000_000);

        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS);
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::next_tx(&mut scenario, STRANGER);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            // Still within dispute window
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS + dispute_window() - 1000);
            pact_escrow::release(&mut pact, &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::end(scenario);
    }

    /// AT-04: Recipient cannot submit work after deadline
    #[test]
    #[expected_failure(abort_code = pact_escrow::pact_escrow::E_DEADLINE_PASSED)]
    fun test_at04_cannot_submit_after_deadline() {
        let scenario = ts::begin(CREATOR);
        create_simple_pact(&mut scenario, 1_000_000_000);

        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, deadline() + 1); // after deadline
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::end(scenario);
    }

    /// AT-05: Cannot dispute without arbitrator set
    #[test]
    #[expected_failure(abort_code = pact_escrow::pact_escrow::E_NO_ARBITRATOR)]
    fun test_at05_cannot_dispute_without_arbitrator() {
        let scenario = ts::begin(CREATOR);
        create_simple_pact(&mut scenario, 1_000_000_000); // no arbitrator

        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS);
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::next_tx(&mut scenario, CREATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS + 1000);
            pact_escrow::dispute(&mut pact, &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::end(scenario);
    }

    /// AT-06: Wrong work hash length rejected
    #[test]
    #[expected_failure(abort_code = pact_escrow::pact_escrow::E_WRONG_HASH_LENGTH)]
    fun test_at06_wrong_hash_length_rejected() {
        let scenario = ts::begin(CREATOR);
        create_simple_pact(&mut scenario, 1_000_000_000);

        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS);
            let bad_hash = vector[0u8, 1u8, 2u8]; // Only 3 bytes — wrong length
            pact_escrow::submit_work(&mut pact, bad_hash, &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::end(scenario);
    }

    /// AT-07: Arbitrator fee exceeding 50% rejected at creation
    #[test]
    #[expected_failure(abort_code = pact_escrow::pact_escrow::E_FEE_TOO_HIGH)]
    fun test_at07_arb_fee_too_high_rejected() {
        let scenario = ts::begin(CREATOR);
        ts::next_tx(&mut scenario, CREATOR);
        {
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS);
            let payment = coin::mint_for_testing<SUI>(1_000_000_000, ts::ctx(&mut scenario));
            pact_escrow::create(
                RECIPIENT,
                ARBITRATOR,
                500_000_001, // > 50% of 1B
                deadline(),
                ONE_HOUR_MS,
                ONE_DAY_MS,
                payment,
                &clock,
                ts::ctx(&mut scenario)
            );
            clock::destroy_for_testing(clock);
        };
        ts::end(scenario);
    }

    /// AT-08: Creator cannot approve from Active state (must be WorkSubmitted)
    #[test]
    #[expected_failure(abort_code = pact_escrow::pact_escrow::E_NOT_WORK_SUBMITTED)]
    fun test_at08_cannot_approve_from_active() {
        let scenario = ts::begin(CREATOR);
        create_simple_pact(&mut scenario, 1_000_000_000);

        ts::next_tx(&mut scenario, CREATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            pact_escrow::approve(&mut pact, ts::ctx(&mut scenario));
            ts::return_shared(pact);
        };

        ts::end(scenario);
    }

    /// AT-09: Dispute must be raised within the dispute window
    #[test]
    #[expected_failure(abort_code = pact_escrow::pact_escrow::E_DISPUTE_WINDOW_CLOSED)]
    fun test_at09_dispute_window_must_be_open() {
        let scenario = ts::begin(CREATOR);
        create_pact_with_arb(&mut scenario, 1_000_000_000, 100_000_000);

        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS);
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::next_tx(&mut scenario, CREATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            // Dispute window closed
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS + dispute_window() + 1);
            pact_escrow::dispute(&mut pact, &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::end(scenario);
    }

    /// AT-10: Stranger cannot rule (only arbitrator can)
    #[test]
    #[expected_failure(abort_code = pact_escrow::pact_escrow::E_NOT_ARBITRATOR)]
    fun test_at10_only_arbitrator_can_rule() {
        let scenario = ts::begin(CREATOR);
        create_pact_with_arb(&mut scenario, 1_000_000_000, 0);

        ts::next_tx(&mut scenario, RECIPIENT);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS);
            pact_escrow::submit_work(&mut pact, dummy_hash(), &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::next_tx(&mut scenario, CREATOR);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + ONE_HOUR_MS + 1000);
            pact_escrow::dispute(&mut pact, &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        // STRANGER tries to rule — must fail
        ts::next_tx(&mut scenario, STRANGER);
        {
            let pact = ts::take_shared<Pact>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            clock::set_for_testing(&mut clock, START_MS + 2 * ONE_HOUR_MS);
            pact_escrow::rule(&mut pact, true, &clock, ts::ctx(&mut scenario));
            clock::destroy_for_testing(clock);
            ts::return_shared(pact);
        };

        ts::end(scenario);
    }
}
