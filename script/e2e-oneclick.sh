#!/usr/bin/env bash
# Local end-to-end run of the one-click flow: anvil + PropAMM + FastBridge + NeuriioAccount,
# sponsor + relayer in-process (HyperCore simulated, HYPE prices live from HyperCore mainnet).
# Uses anvil's public test keys only.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8548
R=http://127.0.0.1:$PORT
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80      # anvil #0: deployer / relayer / feeder
SPONSOR=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a # anvil #2: gas sponsor

anvil --port $PORT --hardfork prague --silent &
ANVIL=$!
trap 'kill $ANVIL ${FEED:-} 2>/dev/null || true' EXIT
if pgrep -f "feed-bbo.mjs" >/dev/null; then echo "a feed-bbo process is already running; stop it first" >&2; exit 1; fi
sleep 2

MID=$(curl -s -X POST https://api.hyperliquid.xyz/info -H 'content-type: application/json' -d '{"type":"allMids"}' | python3 -c "import json,sys;print(int(float(json.load(sys.stdin)['HYPE'])))")
OUT=$(SEED_PRICE=$MID forge script script/DeployPropAMM.s.sol --rpc-url $R --broadcast --private-key $PK 2>&1)
ORACLE=$(echo "$OUT" | awk '/oracle:/{print $2}')
POOL=$(echo "$OUT" | awk '/PropAMM:/{print $2}')
HYPE=$(echo "$OUT" | awk '/tHYPE:/{print $2}')
USDC=$(echo "$OUT" | awk '/tUSDC:/{print $2}')
BRIDGE=$(POOL=$POOL forge script script/DeployFastBridge.s.sol --rpc-url $R --broadcast --private-key $PK 2>&1 | awk '/FastBridge:/{print $2}')
DELEGATE=$(BRIDGE=$BRIDGE forge script script/DeployNeuriioAccount.s.sol --rpc-url $R --broadcast --private-key $PK 2>&1 | awk '/NeuriioAccount:/{print $2}')
echo "pool=$POOL bridge=$BRIDGE delegate=$DELEGATE"

HL_API=https://api.hyperliquid.xyz/info RPC_URL=$R ORACLE=$ORACLE PRIVATE_KEY=$PK MARKETS=107 node keeper/feed-bbo.mjs --loop 1000 >/dev/null 2>&1 &
FEED=$!
sleep 3

cd keeper && RPC_URL=$R BRIDGE=$BRIDGE USDC=$USDC HYPE=$HYPE DELEGATE=$DELEGATE RELAYER_KEY=$PK SPONSOR_KEY=$SPONSOR \
  node test/e2e/oneclick.e2e.mjs
