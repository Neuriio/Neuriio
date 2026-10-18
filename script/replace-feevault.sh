#!/usr/bin/env bash
# Replaces the FeeVault (a fix or a new fee split) without touching tokens, pools or Launchpads: pools and every
# Launchpad version send new fees to the new vault; old creator balances stay claimable in the old one (the app adds
# up every vault listed in `feeVaults`). Emergency (a vault failing and blocking swaps): the factory owner can also
# call setFeeVault(0x0) on the factory, so pools keep the fee like plain V2 until a new vault is in.
#   ./script/replace-feevault.sh [account]    (default: burner; asks the keystore password)
# env: DEPLOYMENTS (the file), RPC + OWNER_KEY (local dry runs on anvil)
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=${DEPLOYMENTS:-deployments/elysium-testnet.json}
RPC=${RPC:-https://testnet-rpc.elysium.kinetiq.xyz}
KEY=(--account "$ACCOUNT"); [ -n "${OWNER_KEY:-}" ] && KEY=(--private-key "$OWNER_KEY")
OLD=$(jq -r .feeVault $D)
OUT=$(REGISTRY=$(jq -r .launchRegistry $D) SWAP_FACTORY=$(jq -r .swapFactory $D) STAKING=$(jq -r .staking $D) \
  MINTER=$(jq -r .minter $D) OLD_FEE_VAULT=$OLD \
  forge script script/ReplaceNeuriioFees.s.sol --rpc-url "$RPC" "${KEY[@]}" --broadcast --slow | tee /dev/stderr)
V=$(echo "$OUT" | awk '$1 == "NeuriioFees:" { print tolower($2) }' | tail -1)
[[ "$V" =~ ^0x[0-9a-f]{40}$ ]] || { echo "Couldn't read the new FeeVault address: '$V'" >&2; exit 1; }
jq --arg v "$V" --arg o "$OLD" '.feeVault = $v | .feeVaults = ([$v] + ((.feeVaults // [$o]) | map(select(. != $v))))' $D > $D.tmp && mv $D.tmp $D
echo "== FeeVault $V is live (old: $OLD, balances there stay claimable)"
