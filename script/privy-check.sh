#!/usr/bin/env bash
# Privy wallet check on testnet: starts the gas sponsor (:8787) and the test faucet (:8788) that the
# check page in app/ talks to. Run the bots in another tab first (./script/run-bots.sh burner).
#   ./script/privy-check.sh [funder-account]   (default: burner; asks its keystore password once)
# Two throwaway keys (sponsor, faucet) are funded with 0.01 HYPE each. Ctrl-C stops both services.
set -euo pipefail
cd "$(dirname "$0")/.."
FUNDER=${1:-burner}
D=deployments/elysium-testnet.json
RPC=https://testnet-rpc.elysium.kinetiq.xyz
[ -n "$(jq -r '.neuriioAccount // empty' $D)" ] || { echo "NeuriioAccount not deployed" >&2; exit 1; }

SPONSOR_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
FAUCET_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
echo "Funding throwaway sponsor + faucet keys with 0.01 HYPE each from '$FUNDER' (enter keystore password)"
FUNDER_KEY=$(cast wallet decrypt-keystore "$FUNDER" | awk '{print $NF}')
if [[ ! $FUNDER_KEY =~ ^0x[0-9a-fA-F]{64}$ ]]; then echo "could not unlock keystore" >&2; exit 1; fi
INVENTORY=$(cast wallet address --private-key "$FUNDER_KEY") # the relayer's HyperCore inventory account
for K in "$SPONSOR_KEY" "$FAUCET_KEY"; do
  TO=$(cast wallet address --private-key "$K")
  for try in 1 2 3 4 5; do
    if cast send "$TO" --value 0.01ether --private-key "$FUNDER_KEY" --rpc-url $RPC >/dev/null 2>&1; then break; fi
    [ $try -lt 5 ] || { unset FUNDER_KEY; echo "funding $TO failed" >&2; exit 1; }
    sleep 0.3
  done
done
unset FUNDER_KEY

mkdir -p logs
PIDS=()
trap 'echo; echo "stopping sponsor + faucet"; kill "${PIDS[@]}" 2>/dev/null || true' INT TERM EXIT
RPC_URL=$RPC DELEGATE=$(jq -r .neuriioAccount $D) SPONSOR_KEY=$SPONSOR_KEY CORS_ORIGIN=http://localhost:5173 \
  RELAYER_KICK_URL=http://127.0.0.1:8790/kick node keeper/sponsor.mjs >logs/sponsor.log 2>&1 &
PIDS+=($!)
FAUCET_KEY=$FAUCET_KEY RPC_URL=$RPC INVENTORY=$INVENTORY node keeper/test/live/privy-faucet.mjs >logs/faucet.log 2>&1 &
PIDS+=($!)
unset SPONSOR_KEY FAUCET_KEY

echo "sponsor :8787 + faucet :8788 running | open http://localhost:5173 | Ctrl-C to stop"
tail -n +1 -f logs/sponsor.log logs/faucet.log
