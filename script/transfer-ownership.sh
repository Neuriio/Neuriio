#!/usr/bin/env bash
# Moves contract ownership from the hot key to a multisig (Safe), for mainnet. Two parts:
#   ./script/transfer-ownership.sh <safe> [account]   run by the current owner (default: burner; asks the keystore password).
#       Starts the transfer on NeuriioRegistry, every NeuriioPad, every NeuriioFees, $NEURIIO and the NeuriioMinter (they
#       then wait for the Safe to accept) and hands the factory's feeToSetter to the Safe (immediate); NeuriioRouter and
#       NeuriioStaking have no owner. Refuses unless <safe> is a deployed Safe needing 2+ signatures. Writes the Safe's
#       acceptOwnership() batch to deployments/accept-ownership.json.
#   ./script/transfer-ownership.sh check <safe>      read-only: who owns what now (owner / pendingOwner per contract).
# The Safe's owners then sign one batch transaction of acceptOwnership() calls; after it executes, `check` shows the
# Safe as owner everywhere and the burner key has no admin power left.
# env: DEPLOYMENTS (the file; the batch is written next to it), RPC + OWNER_KEY (local dry runs on anvil)
set -euo pipefail
cd "$(dirname "$0")/.."
D=${DEPLOYMENTS:-deployments/elysium-testnet.json}
RPC=${RPC:-$(jq -r '.rpc // "https://testnet-rpc.elysium.kinetiq.xyz"' "$D")}
BATCH=$(dirname "$D")/accept-ownership.json
REGISTRY=$(jq -r .launchRegistry "$D")
FACTORY=$(jq -r .swapFactory "$D")
VAULTS=$(jq -r '(.feeVaults // [.feeVault]) | join(",")' "$D")
EXTRA=$(jq -r '[.neuriio, .minter] | map(select(. != null)) | join(",")' "$D") # $NEURIIO + NeuriioMinter

owned() { # registry, every launchpad it knows, every fee vault, $NEURIIO and the minter
  echo "$REGISTRY"
  local n; n=$(cast call "$REGISTRY" "launchpadsLength()(uint256)" --rpc-url "$RPC")
  for ((i = 0; i < n; i++)); do cast call "$REGISTRY" "launchpads(uint256)(address)" "$i" --rpc-url "$RPC"; done
  tr ',' '\n' <<<"$VAULTS"
  [[ -n "$EXTRA" ]] && tr ',' '\n' <<<"$EXTRA"
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
KEY=(--account "$ACCOUNT"); [ -n "${OWNER_KEY:-}" ] && KEY=(--private-key "$OWNER_KEY")
OUT=$(SAFE=$SAFE REGISTRY=$REGISTRY SWAP_FACTORY=$FACTORY FEE_VAULTS=$VAULTS EXTRA_OWNED=$EXTRA \
  forge script script/TransferOwnership.s.sol --rpc-url "$RPC" "${KEY[@]}" --broadcast --slow | tee /dev/stderr)

# acceptOwnership() batch for the Safe (Transaction Builder format: import it, or send the same calls from any Safe tool)
CHAIN=$(cast chain-id --rpc-url "$RPC")
echo "$OUT" | awk '$1 == "ACCEPT" { print $2 }' |
  jq -R . | jq -s --arg chain "$CHAIN" --arg safe "$SAFE" '{
    version: "1.0", chainId: $chain,
    meta: { name: "Neuriio: accept ownership", createdFromSafeAddress: $safe },
    transactions: map({ to: ., value: "0", data: "0x79ba5097" })
  }' >"$BATCH"
echo "== Transfers started. The Safe now signs $BATCH ($(jq '.transactions | length' "$BATCH") acceptOwnership calls)."
echo "== Then: ./script/transfer-ownership.sh check $SAFE"
