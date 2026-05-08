#!/usr/bin/env bash
# run-demo.sh — One-command PactEscrow two-agent demo on Sui testnet
#
# Prerequisites:
#   1. PACKAGE_ID set to deployed pact_escrow package address
#   2. AGENT_A_MNEMONIC and AGENT_B_MNEMONIC set to BIP-39 mnemonics
#      (each wallet needs testnet SUI — get from https://docs.sui.io/guides/developer/getting-started/get-coins)
#   3. npm install run in this directory (or node_modules present)
#
# Usage:
#   PACKAGE_ID=0x... AGENT_A_MNEMONIC="word1 word2 ..." AGENT_B_MNEMONIC="word1 word2 ..." ./run-demo.sh
#
# Or for a deterministic hash-verification demo (Agent A pre-computes expected output):
#   PACKAGE_ID=0x... AGENT_A_MNEMONIC="..." AGENT_B_MNEMONIC="..." DEMO_MODE=1 ./run-demo.sh
#
# Optional: set ANTHROPIC_API_KEY to have Agent B use Claude for a real risk analysis
#   (without it, Agent B uses a canned response — deterministic, works offline)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Validation ─────────────────────────────────────────────────────────────

if [[ -z "${PACKAGE_ID:-}" ]]; then
  echo "ERROR: PACKAGE_ID not set. Deploy the package first:"
  echo "  cd ../  &&  sui client publish --gas-budget 100000000"
  echo "  Then set: export PACKAGE_ID=<package-id-from-output>"
  exit 1
fi

if [[ -z "${AGENT_A_MNEMONIC:-}" ]]; then
  echo "ERROR: AGENT_A_MNEMONIC not set."
  echo "  Generate: sui client new-address ed25519"
  echo "  Fund:     https://docs.sui.io/guides/developer/getting-started/get-coins"
  exit 1
fi

if [[ -z "${AGENT_B_MNEMONIC:-}" ]]; then
  echo "ERROR: AGENT_B_MNEMONIC not set."
  echo "  Use a second Sui testnet wallet."
  exit 1
fi

# ── Install dependencies if needed ────────────────────────────────────────

if [[ ! -d node_modules ]]; then
  echo "[setup] Installing dependencies..."
  npm install --silent
fi

# ── Run the demo ──────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║   PACT Protocol — Two-Agent Escrow Demo on Sui                  ║"
echo "║   Package: ${PACKAGE_ID:0:20}...                                ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# Run Agent B in background — it watches for PactCreated events
echo "[orchestrator] Starting Agent B (service agent) in background..."
node agent_b.js &
AGENT_B_PID=$!

# Brief pause so Agent B starts polling before Agent A creates the pact
sleep 2

# Run Agent A — creates pact, waits for submission, approves
echo "[orchestrator] Starting Agent A (hiring agent)..."
node agent_a.js
AGENT_A_EXIT=$?

# Wait for Agent B to finish
wait $AGENT_B_PID
AGENT_B_EXIT=$?

echo ""
if [[ $AGENT_A_EXIT -eq 0 && $AGENT_B_EXIT -eq 0 ]]; then
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║   ✅  Demo complete. No trust required.                         ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
else
  echo "⚠️  Demo exited with errors (Agent A: $AGENT_A_EXIT, Agent B: $AGENT_B_EXIT)"
  exit 1
fi
