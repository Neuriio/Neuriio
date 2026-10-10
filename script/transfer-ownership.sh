#!/usr/bin/env bash
# Moves contract ownership from the hot key to a multisig (Safe), for mainnet. Two parts:
#   ./script/transfer-ownership.sh <safe> [account]   run by the current owner (default: burner; asks the keystore password).
#       Starts the transfer on NeuriioRegistry, every NeuriioPad and every NeuriioFees (they then wait for the Safe to
#       accept) and hands the factory's feeToSetter to the Safe (immediate). Refuses unless <safe> is a deployed Safe
#       needing 2+ signatures. Writes the Safe's acceptOwnership() batch to deployments/accept-ownership.json.
#   ./script/transfer-ownership.sh check <safe>      read-only: who owns what now (owner / pendingOwner per contract).
# The Safe's owners then sign one batch transaction of acceptOwnership() calls; after it executes, `check` shows the
# Safe as owner everywhere and the burner key has no admin power left.
set -euo pipefail
cd "$(dirname "$0")/.."
D=${DEPLOYMENTS:-deployments/elysium-testnet.json}
RPC=$(jq -r '.rpc // "https://testnet-rpc.elysium.kinetiq.xyz"' "$D")
REGISTRY=$(jq -r .launchRegistry "$D")
FACTORY=$(jq -r .swapFactory "$D")
VAULTS=$(jq -r '(.feeVaults // [.feeVault]) | join(",")' "$D")

owned() { # registry, every launchpad it knows, every fee vault
  echo "$REGISTRY"
  local n; n=$(cast call "$REGISTRY" "launchpadsLength()(uint256)" --rpc-url "$RPC")
  for ((i = 0; i < n; i++)); do cast call "$REGISTRY" "launchpads(uint256)(address)" "$i" --rpc-url "$RPC"; done
  tr ',' '\n' <<<"$VAULTS"
}

if [[ "${1:-}" == "check" ]]; then
  SAFE=$(cast to-check-sum-address "${2:?usage: check <safe>}")
  for c in $(owned); do
    o=$(cast call "$c" "owner()(address)" --rpc-url "$RPC")
    p=$(cast call "$c" "pendingOwner()(address)" --rpc-url "$RPC")
    s="owner $o"; [[ "$o" == "$SAFE" ]] && s="owner = Safe"; [[ "$p" == "$SAFE" ]] && s="$s, waiting for the Safe to accept"
    echo "$c  $s"
  done
  f=$(cast call "$FACTORY" "feeToSetter()(address)" --rpc-url "$RPC")
  echo "$FACTORY  factory feeToSetter $f$([[ "$f" == "$SAFE" ]] && echo " (= Safe)")"
  exit 0
fi

SAFE=$(cast to-check-sum-address "${1:?usage: transfer-ownership.sh <safe> [account] | check <safe>}")
ACCOUNT=${2:-burner}
OUT=$(SAFE=$SAFE REGISTRY=$REGISTRY SWAP_FACTORY=$FACTORY FEE_VAULTS=$VAULTS \
  forge script script/TransferOwnership.s.sol --rpc-url "$RPC" --account "$ACCOUNT" --broadcast --slow | tee /dev/stderr)

# acceptOwnership() batch for the Safe (Transaction Builder format: import it, or send the same calls from any Safe tool)
CHAIN=$(cast chain-id --rpc-url "$RPC")
echo "$OUT" | awk '$1 == "ACCEPT" { print $2 }' |
  jq -R . | jq -s --arg chain "$CHAIN" --arg safe "$SAFE" '{
    version: "1.0", chainId: $chain,
    meta: { name: "Neuriio: accept ownership", createdFromSafeAddress: $safe },
    transactions: map({ to: ., value: "0", data: "0x79ba5097" })
  }' >deployments/accept-ownership.json
echo "== Transfers started. The Safe now signs deployments/accept-ownership.json ($(jq '.transactions | length' deployments/accept-ownership.json) acceptOwnership calls)."
echo "== Then: ./script/transfer-ownership.sh check $SAFE"
