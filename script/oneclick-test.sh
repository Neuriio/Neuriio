#!/usr/bin/env bash
# One-click on testnet from a brand-new wallet with zero gas (see keeper/test/live/oneclick.live.mjs).
# Needs the bots running and NeuriioAccount deployed (./script/deploy-oneclick.sh).
#   ./script/oneclick-test.sh [funder-account]   (default: burner; asks its keystore password once)
# A throwaway sponsor key is funded with 0.01 HYPE to pay everyone's gas.
set -euo pipefail
cd "$(dirname "$0")/.."
FUNDER=${1:-burner}
D=deployments/elysium-testnet.json
RPC=https://testnet-rpc.elysium.kinetiq.xyz
DELEGATE=$(jq -r '.neuriioAccount // empty' $D)
[ -n "$DELEGATE" ] || { echo "NeuriioAccount not deployed: run ./script/deploy-oneclick.sh first" >&2; exit 1; }

SPONSOR_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
SPONSOR=$(cast wallet address --private-key "$SPONSOR_KEY")
echo "Funding throwaway gas sponsor $SPONSOR with 0.01 HYPE from '$FUNDER' (enter keystore password)"
FUNDER_KEY=$(cast wallet decrypt-keystore "$FUNDER" | awk '{print $NF}')
INVENTORY=$(cast wallet address --private-key "$FUNDER_KEY") # the relayer's HyperCore inventory account
for try in 1 2 3 4 5; do
  if cast send "$SPONSOR" --value 0.01ether --private-key "$FUNDER_KEY" --rpc-url $RPC >/dev/null 2>&1; then break; fi
  [ $try -lt 5 ] || { unset FUNDER_KEY; echo "funding failed" >&2; exit 1; }
  sleep 0.3
done
unset FUNDER_KEY

cd keeper
SPONSOR_KEY=$SPONSOR_KEY INVENTORY=$INVENTORY RPC_URL=$RPC DELEGATE=$DELEGATE BRIDGE=$(jq -r .fastBridge ../$D) \
  USDC=$(jq -r .tUSDC ../$D) HYPE=$(jq -r .tHYPE ../$D) node test/live/oneclick.live.mjs
