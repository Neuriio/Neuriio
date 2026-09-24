#!/usr/bin/env bash
# Subscription model: remove the FastBridge fee (users pay only HyperCore's own costs, e.g. its
# one-time $1 fee when USDC is first sent to a brand-new HyperCore account, which is passed on).
#   ./script/bridge-fee-off.sh [account]    (default: burner; one keystore password)
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
RPC=https://testnet-rpc.elysium.kinetiq.xyz
B=$(jq -r .fastBridge deployments/elysium-testnet.json)

echo "Unlocking keystore '$ACCOUNT'"
KEY=$(cast wallet decrypt-keystore "$ACCOUNT" | awk '{print $NF}')
# (feeBps, minFee, maxDeposit, refundDelay, maxPayout, dailyPayoutCap): only the fee fields change
CFG='(0,0,25000000000,3600,25000000000,100000000000)'
for try in 1 2 3 4 5; do # the feeder may share this account's nonce
  if out=$(cast send $B 'setConfig((uint16,uint64,uint64,uint32,uint64,uint64))' "$CFG" --private-key "$KEY" --rpc-url $RPC --json 2>&1); then
    echo "$out" | jq -r '"  setConfig tx \(.transactionHash) status \(.status)"'; break
  fi
  echo "$out" | grep -qE "nonce too low|underpriced" && [ $try -lt 5 ] && { sleep 0.3; continue; }
  unset KEY; echo "$out" >&2; exit 1
done
unset KEY
echo "  bridge config now: $(cast call $B 'config()(uint16,uint64,uint64,uint32,uint64,uint64)' --rpc-url $RPC | tr '\n' ' ')"
