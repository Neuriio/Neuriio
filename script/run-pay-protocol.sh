#!/usr/bin/env bash
# Runs the protocol-fee payout bot (keeper/pay-protocol.mjs): hourly, pays the protocol share waiting in the FeeVault(s)
# to the protocol wallets once it reaches MIN_HYPE (default 0.01). The key only pays gas: use a small keystore with a
# little HYPE (default: burner). Ctrl-C / closing the tab stops it. ONCE=1 = a single check.
#   ./script/run-pay-protocol.sh [account]
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
echo "Protocol-fee payout bot, gas paid by keystore '$ACCOUNT' (enter keystore password)"
KEY=$(cast wallet decrypt-keystore "$ACCOUNT" | awk '{print $NF}')
mkdir -p logs
cd keeper && KEY=$KEY exec node pay-protocol.mjs 2>&1 | tee -a ../logs/pay-protocol.log
