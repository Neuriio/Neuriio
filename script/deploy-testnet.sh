#!/usr/bin/env bash
# Deploys Steps 1, 2 and 4 to Elysium testnet from a Foundry keystore account.
#   ./script/deploy-testnet.sh [account]    (default account: burner)
# Foundry asks for the keystore password once per forge script (twice total).
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
RPC=elysium_testnet

MID=$(curl -s -X POST https://api.hyperliquid.xyz/info -H 'content-type: application/json' -d '{"type":"allMids"}' \
  | python3 -c "import json,sys;print(int(float(json.load(sys.stdin)['HYPE'])))")
echo "Seeding pool at live HYPE price ~\$$MID"

echo "== 1/2 Oracle + test tokens + PropAMM (enter keystore password)"
SEED_PRICE=$MID forge script script/DeployPropAMM.s.sol --rpc-url $RPC --account "$ACCOUNT" --broadcast --slow
RUN=broadcast/DeployPropAMM.s.sol/99801/run-latest.json
addr() { jq -r --arg c "$1" --argjson n "${2:-0}" '[.transactions[] | select(.contractName==$c and .transactionType=="CREATE")][$n].contractAddress' $RUN; }
ORACLE=$(addr KeeperHyperCoreOracle)
HYPE=$(addr MockERC20 0)
USDC=$(addr MockERC20 1)
POOL=$(addr PropAMM)

echo "== 2/2 FastBridge (enter keystore password again)"
POOL=$POOL forge script script/DeployFastBridge.s.sol --rpc-url $RPC --account "$ACCOUNT" --broadcast --slow
BRIDGE=$(jq -r '[.transactions[] | select(.contractName=="FastBridge" and .transactionType=="CREATE")][0].contractAddress' \
  broadcast/DeployFastBridge.s.sol/99801/run-latest.json)

mkdir -p deployments
cat > deployments/elysium-testnet.json <<EOF
{
  "chainId": 99801,
  "oracle": "$ORACLE",
  "tHYPE": "$HYPE",
  "tUSDC": "$USDC",
  "propAMM": "$POOL",
  "fastBridge": "$BRIDGE"
}
EOF
echo "== Deployed (saved to deployments/elysium-testnet.json)"
cat deployments/elysium-testnet.json
