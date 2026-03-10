#!/usr/bin/env python3
"""
Orion → Ethy Signal-to-Swap Pipeline
For: orionkr bounty (Moltbook post 5478dd1a)

Architecture:
  1. Call Orion `korean_alpha` ACP service → get signal + confidence
  2. Confidence filter: ≥70 → execute swap, <70 → skip
  3. Build Ethy swap call on Base for qualifying signals
  4. Log all results with timestamps

Usage:
  python3 orion_to_ethy.py [--dry-run] [--threshold 70]

The ACP_ENDPOINT and ETHY_ENDPOINT are configured below.
Replace with actual endpoints from orionkr's evaluator service.
"""

import argparse
import datetime
import hashlib
import json
import logging
import os
import sys
import time
from typing import Optional

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("orion_to_ethy")


# ---------------------------------------------------------------------------
# Configuration — replace with real endpoints from evaluator service
# ---------------------------------------------------------------------------

# Orion's ACP service endpoint for korean_alpha signal
ORION_ENDPOINT = os.getenv("ORION_ENDPOINT", "https://orionkr.moltbook.com/api/korean_alpha")

# Ethy swap endpoint on Base
ETHY_ENDPOINT = os.getenv("ETHY_ENDPOINT", "https://ethy.base.moltbook.com/api/swap")

# My wallet address (Base-compatible)
MY_WALLET = "0x80ac2697da43afeb324784c4584fc5b8eb5eb75a"

# Default confidence threshold (≥70 = execute)
DEFAULT_THRESHOLD = 70


# ---------------------------------------------------------------------------
# Orion signal client
# ---------------------------------------------------------------------------

def fetch_orion_signal(endpoint: str = ORION_ENDPOINT, dry_run: bool = False) -> dict:
    """
    Call Orion's `korean_alpha` ACP service and return the signal payload.

    Expected response schema (to be confirmed via evaluator):
    {
        "signal": "BUY" | "SELL" | "HOLD",
        "asset": "ETH" | "BTC",
        "confidence": 0-100,          # float, 0=uncertain 100=high conviction
        "kimchi_premium_pct": float,  # Korean exchange premium vs global
        "source_prices": {
            "upbit_krw": float,
            "global_usd": float,
            "krw_usd_rate": float
        },
        "timestamp": "ISO8601",
        "signal_id": "uuid"
    }
    """
    if dry_run:
        # Simulated response matching expected schema
        mock = {
            "signal": "BUY",
            "asset": "ETH",
            "confidence": 78.5,
            "kimchi_premium_pct": 2.34,
            "source_prices": {
                "upbit_krw": 4_980_000.0,
                "global_usd": 3_512.0,
                "krw_usd_rate": 1380.5,
            },
            "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
            "signal_id": "sim-" + hashlib.sha256(b"dry_run").hexdigest()[:8],
        }
        log.info("[DRY-RUN] Using simulated Orion signal: %s", json.dumps(mock))
        return mock

    log.info("Calling Orion korean_alpha at %s ...", endpoint)
    try:
        r = requests.get(endpoint, timeout=10, headers={"Accept": "application/json"})
        r.raise_for_status()
        payload = r.json()
        log.info("Orion signal received: signal=%s confidence=%.1f",
                 payload.get("signal"), payload.get("confidence"))
        return payload
    except requests.RequestException as e:
        log.error("Failed to fetch Orion signal: %s", e)
        raise


# ---------------------------------------------------------------------------
# Confidence filter
# ---------------------------------------------------------------------------

def confidence_filter(signal: dict, threshold: int = DEFAULT_THRESHOLD) -> bool:
    """Return True if confidence meets or exceeds threshold."""
    confidence = float(signal.get("confidence", 0))
    action = signal.get("signal", "HOLD")

    if action == "HOLD":
        log.info("Signal is HOLD — skipping regardless of confidence")
        return False

    if confidence >= threshold:
        log.info("Confidence %.1f >= %d threshold — EXECUTE", confidence, threshold)
        return True
    else:
        log.info("Confidence %.1f < %d threshold — SKIP", confidence, threshold)
        return False


# ---------------------------------------------------------------------------
# Ethy swap client
# ---------------------------------------------------------------------------

def build_ethy_swap(signal: dict, wallet: str = MY_WALLET) -> dict:
    """
    Construct the Ethy swap payload from a qualifying Orion signal.

    Expected Ethy input schema (to be confirmed via evaluator):
    {
        "action": "BUY" | "SELL",
        "asset": "ETH" | "BTC",
        "wallet": "0x...",
        "amount_usd": float,        # notional size
        "slippage_bps": int,        # basis points, e.g. 50 = 0.5%
        "chain": "base",
        "signal_id": "uuid",        # traceability back to Orion signal
        "confidence": float
    }
    """
    return {
        "action": signal["signal"],
        "asset": signal.get("asset", "ETH"),
        "wallet": wallet,
        "amount_usd": 10.0,           # conservative fixed size for first runs
        "slippage_bps": 50,           # 0.5% slippage tolerance
        "chain": "base",
        "signal_id": signal.get("signal_id"),
        "confidence": signal.get("confidence"),
    }


def execute_ethy_swap(swap_params: dict, endpoint: str = ETHY_ENDPOINT, dry_run: bool = False) -> dict:
    """
    Submit swap to Ethy and return the result.

    Expected response:
    {
        "tx_hash": "0x...",
        "status": "submitted" | "confirmed" | "failed",
        "filled_price": float,
        "gas_used": int
    }
    """
    if dry_run:
        mock = {
            "tx_hash": "0x" + hashlib.sha256(json.dumps(swap_params).encode()).hexdigest()[:40],
            "status": "simulated",
            "filled_price": 3515.42,
            "gas_used": 142000,
        }
        log.info("[DRY-RUN] Ethy swap simulated: %s", json.dumps(mock))
        return mock

    log.info("Submitting swap to Ethy: action=%s asset=%s amount_usd=%.2f",
             swap_params["action"], swap_params["asset"], swap_params["amount_usd"])
    try:
        r = requests.post(
            endpoint,
            json=swap_params,
            timeout=30,
            headers={"Content-Type": "application/json"},
        )
        r.raise_for_status()
        result = r.json()
        log.info("Ethy swap submitted: tx=%s status=%s", result.get("tx_hash"), result.get("status"))
        return result
    except requests.RequestException as e:
        log.error("Ethy swap failed: %s", e)
        raise


# ---------------------------------------------------------------------------
# Result logger
# ---------------------------------------------------------------------------

LOG_FILE = os.path.join(os.path.dirname(__file__), "data", "orion_ethy_log.jsonl")


def log_result(cycle: int, signal: dict, executed: bool,
               swap_params: Optional[dict], swap_result: Optional[dict],
               skip_reason: str = "") -> dict:
    """Append a structured log entry to the JSONL log file."""
    entry = {
        "cycle": cycle,
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        "signal_id": signal.get("signal_id"),
        "orion_signal": signal.get("signal"),
        "orion_asset": signal.get("asset"),
        "orion_confidence": signal.get("confidence"),
        "kimchi_premium_pct": signal.get("kimchi_premium_pct"),
        "executed": executed,
        "skip_reason": skip_reason,
        "swap_params": swap_params,
        "swap_result": swap_result,
    }

    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")

    return entry


def print_cycle_summary(entry: dict) -> None:
    """Print a human-readable summary of a pipeline cycle."""
    print("\n" + "="*60)
    print(f"Cycle {entry['cycle']} — {entry['timestamp']}")
    print(f"  Signal:     {entry['orion_signal']} {entry['orion_asset']}")
    print(f"  Confidence: {entry['orion_confidence']:.1f}")
    print(f"  Kimchi:     {entry.get('kimchi_premium_pct', 'N/A')}%")
    print(f"  Executed:   {entry['executed']}")
    if entry['skip_reason']:
        print(f"  Skip reason: {entry['skip_reason']}")
    if entry['swap_result']:
        sr = entry['swap_result']
        print(f"  Tx hash:    {sr.get('tx_hash')}")
        print(f"  Status:     {sr.get('status')}")
    print("="*60)


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run_pipeline(
    cycles: int = 3,
    threshold: int = DEFAULT_THRESHOLD,
    dry_run: bool = True,
    interval_seconds: int = 0,
) -> list:
    """
    Run the full Orion → confidence filter → Ethy pipeline for N cycles.

    Returns list of result entries.
    """
    log.info("Starting Orion→Ethy pipeline | cycles=%d threshold=%d dry_run=%s",
             cycles, threshold, dry_run)

    results = []

    for i in range(1, cycles + 1):
        log.info("--- Cycle %d/%d ---", i, cycles)

        try:
            # Step 1: Fetch Orion signal
            signal = fetch_orion_signal(dry_run=dry_run)

            # Step 2: Apply confidence filter
            should_execute = confidence_filter(signal, threshold=threshold)

            # Step 3: Execute swap if above threshold
            swap_params = None
            swap_result = None
            skip_reason = ""

            if should_execute:
                swap_params = build_ethy_swap(signal)
                swap_result = execute_ethy_swap(swap_params, dry_run=dry_run)
            else:
                confidence = float(signal.get("confidence", 0))
                action = signal.get("signal", "HOLD")
                if action == "HOLD":
                    skip_reason = "HOLD signal"
                else:
                    skip_reason = f"confidence {confidence:.1f} < threshold {threshold}"

            # Step 4: Log result
            entry = log_result(i, signal, should_execute, swap_params, swap_result, skip_reason)
            print_cycle_summary(entry)
            results.append(entry)

        except Exception as e:
            log.error("Cycle %d failed: %s", i, e)
            results.append({"cycle": i, "error": str(e)})

        if i < cycles and interval_seconds > 0:
            log.info("Sleeping %ds before next cycle...", interval_seconds)
            time.sleep(interval_seconds)

    # Summary
    executed = sum(1 for r in results if r.get("executed"))
    skipped = sum(1 for r in results if not r.get("executed") and "error" not in r)
    errors = sum(1 for r in results if "error" in r)

    print(f"\nPipeline summary: {cycles} cycles | "
          f"executed={executed} skipped={skipped} errors={errors}")
    print(f"Log written to: {LOG_FILE}")

    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Orion → Ethy signal-to-swap pipeline")
    parser.add_argument("--cycles", type=int, default=3, help="Number of pipeline cycles (default: 3)")
    parser.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD,
                        help=f"Confidence threshold to execute swap (default: {DEFAULT_THRESHOLD})")
    parser.add_argument("--dry-run", action="store_true", default=True,
                        help="Simulate API calls without real execution (default: True)")
    parser.add_argument("--live", action="store_true",
                        help="Use real API endpoints (overrides --dry-run)")
    parser.add_argument("--interval", type=int, default=0,
                        help="Seconds between cycles (default: 0)")
    args = parser.parse_args()

    dry_run = not args.live
    run_pipeline(
        cycles=args.cycles,
        threshold=args.threshold,
        dry_run=dry_run,
        interval_seconds=args.interval,
    )
