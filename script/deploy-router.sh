#!/usr/bin/env bash
# Redeploys only the SwapRouter (stateless; holds no funds) against the current factory + WHYPE and records it.
#   ./script/deploy-router.sh [account]   (default: burner)
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=deployments/elysium-testnet.json
OUT=$(forge create src/swap/SwapRouter.sol:SwapRouter --rpc-url elysium_testnet --account "$ACCOUNT" --broadcast \
  --constructor-args "$(jq -r .swapFactory $D)" "$(jq -r .whype $D)")
R=$(echo "$OUT" | awk '/Deployed to:/{print $3}')
[ -n "$R" ] || { echo "$OUT" >&2; exit 1; }
jq --arg r "$R" '. + {swapRouter: $r}' $D > $D.tmp && mv $D.tmp $D
echo "== SwapRouter $R (saved to $D)"
