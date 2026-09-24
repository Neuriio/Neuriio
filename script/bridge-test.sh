#!/usr/bin/env bash
# Live FastBridge round trip on testnet from a throwaway trader (needs the bots running).
#   ./script/bridge-test.sh [funder-account]   (default: burner; asks its keystore password once)
set -euo pipefail
cd "$(dirname "$0")/.."
FUNDER=${1:-burner}
D=deployments/elysium-testnet.json
RPC=https://testnet-rpc.elysium.kinetiq.xyz

TRADER_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
TRADER=$(cast wallet address --private-key "$TRADER_KEY")
echo "Funding throwaway trader $TRADER with 0.01 HYPE from '$FUNDER' (enter keystore password)"
FUNDER_KEY=$(cast wallet decrypt-keystore "$FUNDER" | awk '{print $NF}')
INVENTORY=$(cast wallet address --private-key "$FUNDER_KEY") # the relayer's HyperCore inventory account
for try in 1 2 3 4 5; do
  if cast send "$TRADER" --value 0.01ether --private-key "$FUNDER_KEY" --rpc-url $RPC >/dev/null 2>&1; then break; fi
  [ $try -lt 5 ] || { unset FUNDER_KEY; echo "funding failed" >&2; exit 1; }
  sleep 0.3
done
unset FUNDER_KEY

cd keeper
TRADER_KEY=$TRADER_KEY INVENTORY=$INVENTORY RPC_URL=$RPC BRIDGE=$(jq -r .fastBridge ../$D) USDC=$(jq -r .tUSDC ../$D) \
  node test/live/bridge.live.mjs
