#!/usr/bin/env bash
# ONE-TIME per network: deploys the PERMANENT core (LaunchRegistry, swap factory = our Uniswap V2 fork, FeeVault,
# SwapRouter; reuses WHYPE from the deployments file) and then the first Launchpad version (./script/deploy-launchpad.sh).
# Never run this for an upgrade: a new core is a new world (old tokens stay on the old core). For upgrades run
# ./script/deploy-launchpad.sh only. Optional env COMMUNITY_WALLET + BUYBACK_WALLET (protocol share).
#   ./script/deploy-core.sh [account]    (default: burner; asks the keystore password)
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=deployments/elysium-testnet.json
RPC=https://testnet-rpc.elysium.kinetiq.xyz
FROM=$(cast block-number --rpc-url $RPC) # indexers start here (the registry is deployed after this block)

OUT=$(WHYPE=$(jq -r '.whype // empty' $D) \
  forge script script/DeployCore.s.sol --rpc-url elysium_testnet --account "$ACCOUNT" --broadcast --slow | tee /dev/stderr)
addr() { echo "$OUT" | awk -v k="$1" '$1 == k":" { print tolower($2) }' | tail -1; }
W=$(addr WHYPE); REG=$(addr NeuriioRegistry); V=$(addr NeuriioFees); R=$(addr NeuriioSwap)
F=$(echo "$OUT" | awk '/SwapFactory \(UniswapV2Factory\):/ { print tolower($NF) }' | tail -1)
for x in "$W" "$REG" "$F" "$V" "$R"; do
  [[ "$x" =~ ^0x[0-9a-f]{40}$ ]] || { echo "Couldn't read a deployed address from the script output: '$x'" >&2; exit 1; }
done
# a fresh core: no Launchpad versions yet (the previous core's list would be wrong here)
jq --arg w "$W" --arg reg "$REG" --arg f "$F" --arg v "$V" --arg r "$R" --argjson b "$FROM" \
  '. + {whype: $w, launchRegistry: $reg, swapFactory: $f, feeVault: $v, feeVaults: [$v], swapRouter: $r, routers: [$r], coreBlock: $b, launchpads: []} | del(.launchpad)' \
  $D > $D.tmp && mv $D.tmp $D
echo "== Core deployed (saved to $D). Deploying the first Launchpad version..."
./script/deploy-launchpad.sh "$ACCOUNT"
