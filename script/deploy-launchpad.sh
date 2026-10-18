#!/usr/bin/env bash
# Ships a NEW Launchpad version on the existing core (the upgrade path): approves it in the LaunchRegistry for new
# launches and retires the previous version for NEW launches only. Nothing is orphaned: old tokens keep trading on
# their own version's curve, graduate into the shared factory, and earn fees in the shared FeeVault; identity (one
# token per X account, handles, FTF tickers) is global in the registry. The indexer and watcher pick the new version
# up from the registry by themselves. Updates Supabase LAUNCHPAD_ADDRESS (passes are signed for the current version).
#   ./script/deploy-launchpad.sh [account]    (default: burner; asks the keystore password)
# The curve is priced in USDC. Testnet default VIRTUAL_QUOTE = 1,000 USDC (graduates at ~2,834 USDC raised, ~$13.7k
# market cap); mainnet ~$70k market cap = 5_109e6. FEE_BPS default 100 (1%).
# env: DEPLOYMENTS (the file), RPC + OWNER_KEY (local dry runs on anvil: Supabase is left alone)
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=${DEPLOYMENTS:-deployments/elysium-testnet.json}
TESTNET=https://testnet-rpc.elysium.kinetiq.xyz
RPC=${RPC:-$TESTNET}
KEY=(--account "$ACCOUNT"); [ -n "${OWNER_KEY:-}" ] && KEY=(--private-key "$OWNER_KEY")
REG=$(jq -r '.launchRegistry // empty' $D)
[ -n "$REG" ] || { echo "No launchRegistry in $D: run ./script/deploy-core.sh first (one time)" >&2; exit 1; }
SIGNER=$(jq -r '.launchSigner // empty' $D)
[ -n "$SIGNER" ] || { echo "No launchSigner in $D: run ./script/supabase-setup.sh first" >&2; exit 1; }
PREV=$(jq -r '.launchpad // empty' $D) # retired for new launches once the new one is approved
FROM=$(cast block-number --rpc-url $RPC)

OUT=$(REGISTRY=$REG SWAP_FACTORY=$(jq -r .swapFactory $D) FEE_VAULT=$(jq -r .feeVault $D) \
  LAUNCH_SIGNER=$SIGNER RETIRE=$PREV VIRTUAL_QUOTE=${VIRTUAL_QUOTE:-1000000000} FEE_BPS=${FEE_BPS:-100} \
  forge script script/DeployNeuriioPad.s.sol --rpc-url "$RPC" "${KEY[@]}" --broadcast --slow | tee /dev/stderr)
L=$(echo "$OUT" | awk '$1 == "NeuriioPad:" { print tolower($2) }' | tail -1)
[[ "$L" =~ ^0x[0-9a-f]{40}$ ]] || { echo "Couldn't read the Launchpad address from the script output: '$L'" >&2; exit 1; }
jq --arg l "$L" --argjson b "$FROM" '.launchpad = $l | .launchpads = ((.launchpads // []) + [{address: $l, block: $b}])' \
  $D > $D.tmp && mv $D.tmp $D
if [ "$RPC" = "$TESTNET" ] && [ -f supabase/.temp/project-ref ]; then
  supabase secrets set --project-ref "$(cat supabase/.temp/project-ref)" LAUNCHPAD_ADDRESS="$L" >/dev/null \
    && echo "== Supabase LAUNCHPAD_ADDRESS updated (restart nothing: indexer + watcher follow the registry)"
fi
echo "== Launchpad $L approved${PREV:+; $PREV retired for new launches} (saved to $D)"
