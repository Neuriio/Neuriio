#!/usr/bin/env bash
# Deploys the tKNTQ/tUSDC PropAMM on Elysium testnet (see script/DeployKntqPool.s.sol) and records it
# in deployments/elysium-testnet.json. STOP THE BOTS FIRST: the feeder signs with the same key.
#   ./script/deploy-kntq-pool.sh [account]    (default: burner; asks the keystore password once)
# Then restart the bots: run-bots.sh now feeds HYPE (107) and KNTQ (334) prices.
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=deployments/elysium-testnet.json

PRICE_E6=$(curl -s -X POST https://api.hyperliquid.xyz/info -H 'content-type: application/json' -d '{"type":"allMids"}' \
  | python3 -c "import json,sys;print(round(float(json.load(sys.stdin)['@334'])*1e6))")
echo "Seeding at live HyperCore KNTQ price \$$(python3 -c "print($PRICE_E6/1e6)") (enter keystore password)"

ORACLE=$(jq -r .oracle $D) USDC=$(jq -r .tUSDC $D) BRIDGE=$(jq -r .fastBridge $D) SEED_PRICE_E6=$PRICE_E6 \
  forge script script/DeployKntqPool.s.sol --rpc-url elysium_testnet --account "$ACCOUNT" --broadcast --slow

RUN=broadcast/DeployKntqPool.s.sol/99801/run-latest.json
addr() { jq -r --arg c "$1" '[.transactions[] | select(.contractName==$c and .transactionType=="CREATE")][0].contractAddress' $RUN; }
KNTQ=$(addr MockERC20)
POOL=$(addr PropAMM)
jq --arg k "$KNTQ" --arg p "$POOL" '. + {tKNTQ: $k, propAMMKntq: $p}' $D > $D.tmp && mv $D.tmp $D
echo "== Deployed (saved to $D)"
cat $D
