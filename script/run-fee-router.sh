#!/usr/bin/env bash
# Runs the fee router (keeper/fee-router.mjs). Its key IS the fee wallet, so it controls whatever has arrived since the last
# payout: use a dedicated keystore for nothing else. Dry run unless SEND=1. Other settings: see keeper/fee-router.mjs.
#   ./script/run-fee-router.sh <account>
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:?keystore account of the fee wallet}
echo "Fee router, fee wallet keystore '$ACCOUNT' (enter keystore password)"
KEY=$(cast wallet decrypt-keystore "$ACCOUNT" | awk '{print $NF}')
mkdir -p logs
cd keeper && KEY=$KEY exec node fee-router.mjs 2>&1 | tee -a ../logs/fee-router.log
