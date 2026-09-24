#!/usr/bin/env bash
# Owner settings for the testnet deployment (one keystore password for all changes).
#   ./script/apply-settings.sh [account]    (default: burner)
#
#   oracle: 2.5s clock slack. Elysium block time trails real time by ~1-2s, so HyperCore
#           timestamps were being rejected as "from the future" (~18% of pushes).
#   pool:   subscription pricing: edge = HyperCore perps taker fee (4.5 bps, rounded up to 5),
#           no size impact, no inventory skew. Revenue comes from subscriptions, not spread.
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=deployments/elysium-testnet.json
RPC=https://testnet-rpc.elysium.kinetiq.xyz
O=$(jq -r .oracle $D); P=$(jq -r .propAMM $D)

echo "Unlocking keystore '$ACCOUNT'"
KEY=$(cast wallet decrypt-keystore "$ACCOUNT" | awk '{print $NF}')

# The feeder signs with the same account every few seconds: retry if it takes our nonce.
send() {
  local label=$1; shift
  for try in 1 2 3 4 5; do
    if out=$(cast send "$@" --private-key "$KEY" --rpc-url $RPC --json 2>&1); then
      echo "$out" | jq -r --arg l "$label" '"  \($l): tx \(.transactionHash) status \(.status)"'; return 0
    fi
    if echo "$out" | grep -qE "nonce too low|replacement transaction underpriced" && [ $try -lt 5 ]; then sleep 0.3; continue; fi
    echo "  $label failed: $(echo "$out" | head -2)" >&2; return 1
  done
}

send "oracle clock slack 2.5s " $O 'setMaxFutureDriftMs(uint64)' 2500
# order matters: lower the floor first, then the edge
send "pool risk (minEdge 5 bps)" $P 'setRiskParams((uint16,uint16,uint32,uint32,uint32,uint16))' '(5,1000,20000,5000,50,50)'
send "pool quote (5 bps, no impact/skew)" $P 'setQuoteParams((uint16,uint16,uint16,uint16,uint16))' '(5,5000,0,0,0)'
unset KEY

echo "Now:"
echo "  oracle maxFutureDriftMs = $(cast call $O 'maxFutureDriftMs()(uint64)' --rpc-url $RPC)"
echo "  pool quoteParams (edge,target,skewFactor,maxSkew,impact) = $(cast call $P 'quoteParams()(uint16,uint16,uint16,uint16,uint16)' --rpc-url $RPC | tr '\n' ' ')"
echo "  pool riskParams  (minEdge,...) = $(cast call $P 'riskParams()(uint16,uint16,uint32,uint32,uint32,uint16)' --rpc-url $RPC | tr '\n' ' ')"
