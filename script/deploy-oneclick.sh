#!/usr/bin/env bash
# Deploys NeuriioAccount (the EIP-7702 delegate for one-click buys) against the deployed FastBridge
# and records it in deployments/elysium-testnet.json. Run while the bots are STOPPED (same account
# as the feeder, so nonces would clash).
#   ./script/deploy-oneclick.sh [account]    (default: burner; asks its keystore password once)
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=deployments/elysium-testnet.json

BRIDGE=$(jq -r .fastBridge $D) forge script script/DeployNeuriioAccount.s.sol --rpc-url elysium_testnet \
  --account "$ACCOUNT" --broadcast --slow
DELEGATE=$(jq -r '[.transactions[] | select(.contractName=="NeuriioAccount" and .transactionType=="CREATE")][0].contractAddress' \
  broadcast/DeployNeuriioAccount.s.sol/99801/run-latest.json)
jq --arg a "$DELEGATE" '.neuriioAccount = $a' $D >$D.tmp && mv $D.tmp $D
echo "== NeuriioAccount $DELEGATE (saved to $D)"
