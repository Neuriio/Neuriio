#!/usr/bin/env bash
# Sets the current NeuriioPad's starting virtual USDC for NEW launches (tokens already on a curve keep theirs). A token
# graduates at a market cap of ~13.7x this and raises ~2.83x it: 6,000 USDC = ~$82k market cap, ~$17k raised.
#   ./script/set-virtual-quote.sh <whole USDC> [account]   (default: burner; asks its password unless OWNER_KEY is set)
set -euo pipefail
cd "$(dirname "$0")/.."
D=${DEPLOYMENTS:-deployments/elysium-testnet.json}
RPC=${RPC:-https://testnet-rpc.elysium.kinetiq.xyz}
VQ=${1:?usage: set-virtual-quote.sh <whole USDC> [account]}
ACCOUNT=${2:-burner}
[[ "$VQ" =~ ^[0-9]+$ ]] || { echo "Whole USDC: $VQ" >&2; exit 1; }
PAD=$(jq -r .launchpad $D)
if [ -z "${OWNER_KEY:-}" ]; then
  echo "Enter the '$ACCOUNT' keystore password:"
  OWNER_KEY=$(cast wallet decrypt-keystore "$ACCOUNT" | awk '{print $NF}')
fi
cast send $PAD "setVirtualQuote(uint256)" "${VQ}000000" --rpc-url $RPC --private-key "$OWNER_KEY" >/dev/null
echo "== NeuriioPad $PAD: new launches start at $(cast call $PAD 'virtualQuote()(uint256)' --rpc-url $RPC | awk '{print $1/1e6}') virtual USDC"
