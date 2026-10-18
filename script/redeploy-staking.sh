#!/usr/bin/env bash
# Replaces the staking side of the testnet USDC world with the final design (user, 2026-10-17): X-token stakers earn
# their pool's USDC fees and mint $NEURIIO (100 per $1 earned, decaying after $1M of platform fees); curve fees 80%
# $NEURIIO stakers / 10% KNTQ buyback / 10% treasury; pool fees 40/40/10/10. Deploys NeuriioStaking (+ a fresh
# $NEURIIO), NeuriioMinter, NeuriioFees and NeuriioRouter on the existing registry, factory, USDC and NeuriioPad, points
# the factory and every pad at the new vault, updates deployments/elysium-testnet.json, runs the live test, and
# verifies everything on the explorer. Supabase, the indexer, the watcher and the app are NOT switched here.
#   ./script/redeploy-staking.sh [account]    (default: burner; asks its keystore password once)
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=${DEPLOYMENTS:-deployments/elysium-testnet.json}
RPC=${RPC:-https://testnet-rpc.elysium.kinetiq.xyz} # another RPC (a local anvil) for dry runs
WALLET=${TREASURY_WALLET:-0x10E942585ceBf3dcf8377ff8eC38F2458662EEC3}
BUYBACK=${BUYBACK_WALLET:-$WALLET}
if [ -z "${OWNER_KEY:-}" ]; then # OWNER_KEY preset: local dry runs only
  echo "Enter the '$ACCOUNT' keystore password:"
  OWNER_KEY=$(cast wallet decrypt-keystore "$ACCOUNT" | awk '{print $NF}')
fi

OUT=$(REGISTRY=$(jq -r .launchRegistry $D) SWAP_FACTORY=$(jq -r .swapFactory $D) TREASURY_WALLET=$WALLET BUYBACK_WALLET=$BUYBACK \
  forge script script/DeployStaking.s.sol --rpc-url "$RPC" --private-key "$OWNER_KEY" --broadcast --slow | tee /dev/stderr)
addr() { echo "$OUT" | awk -v k="$1" '$1 == k":" { print tolower($2) }' | tail -1; }
ST=$(addr NeuriioStaking); N=$(addr NeuriioPlatformToken); M=$(addr NeuriioMinter); V=$(addr NeuriioFees); R=$(addr NeuriioRouter)
for x in "$ST" "$N" "$M" "$V" "$R"; do
  [[ "$x" =~ ^0x[0-9a-f]{40}$ ]] || { echo "Couldn't read a deployed address from the script output: '$x'" >&2; exit 1; }
done
jq --arg st "$ST" --arg n "$N" --arg m "$M" --arg v "$V" --arg r "$R" \
  '.staking = $st | .neuriio = $n | .minter = $m | .feeVault = $v | .feeVaults = ([$v] + (.feeVaults // []))
   | .router = $r | .routers = ([$r] + (.routers // []))' $D > $D.tmp && mv $D.tmp $D
echo "== Staking side replaced (saved to $D)"

echo "== Live test"
OWNER_KEY=$OWNER_KEY DEPLOYMENTS=$D RPC=$RPC ./script/launchpad-test.sh "$ACCOUNT"
unset OWNER_KEY
if [ "$RPC" = "https://testnet-rpc.elysium.kinetiq.xyz" ]; then
  echo "== Verifying on the explorer"
  ./script/verify-world.sh
fi
