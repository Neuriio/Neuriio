#!/usr/bin/env bash
# Deploys a fresh launchpad + swap factory (our Uniswap V2 fork, src/swap/v2) + router on Elysium testnet (reuses WHYPE from the deployments file) and
# records them in deployments/elysium-testnet.json. Launch passes must be signed by `launchSigner` from that file
# (created by ./script/supabase-setup.sh). Fees: FeeVault (80% creator / 20% protocol); optional env COMMUNITY_WALLET +
# BUYBACK_WALLET set where the protocol share goes (otherwise it waits in the vault; owner: FeeVault.setWallets). If the Supabase project is linked, LAUNCHPAD_ADDRESS is updated there too.
#   ./script/deploy-launchpad.sh [account]    (default: burner; asks the keystore password once)
# Testnet default VIRTUAL_HYPE=0.1 HYPE so a token graduates at ~0.29 HYPE (mainnet default: 60 HYPE -> ~170 HYPE).
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=deployments/elysium-testnet.json
SIGNER=$(jq -r '.launchSigner // empty' $D)
[ -n "$SIGNER" ] || { echo "No launchSigner in $D: run ./script/supabase-setup.sh first" >&2; exit 1; }

# Addresses come from the script's own console lines ("Launchpad: 0x..."), not from the broadcast's contractName
# (forge leaves that null for contracts built with a separate compiler profile, like the size-optimized Launchpad).
OUT=$(LAUNCH_SIGNER=$SIGNER WHYPE=$(jq -r '.whype // empty' $D) VIRTUAL_HYPE=${VIRTUAL_HYPE:-100000000000000000} FEE_BPS=${FEE_BPS:-75} \
  forge script script/DeployLaunchpad.s.sol --rpc-url elysium_testnet --account "$ACCOUNT" --broadcast --slow | tee /dev/stderr)
addr() { echo "$OUT" | awk -v k="$1" '$1 == k":" { print tolower($2) }' | tail -1; }
W=$(addr WHYPE); F=$(echo "$OUT" | awk '/SwapFactory \(UniswapV2Factory\):/ { print tolower($NF) }' | tail -1)
L=$(addr Launchpad); R=$(addr SwapRouter); V=$(addr FeeVault)
for x in "$W" "$F" "$L" "$R" "$V"; do
  [[ "$x" =~ ^0x[0-9a-f]{40}$ ]] || { echo "Couldn't read a deployed address from the script output: '$x'" >&2; exit 1; }
done
jq --arg w "$W" --arg f "$F" --arg l "$L" --arg r "$R" --arg v "$V" \
  '. + {whype: $w, swapFactory: $f, launchpad: $l, swapRouter: $r, feeVault: $v}' $D > $D.tmp && mv $D.tmp $D
if [ -f supabase/.temp/project-ref ]; then
  supabase secrets set --project-ref "$(cat supabase/.temp/project-ref)" LAUNCHPAD_ADDRESS="$L" >/dev/null \
    && echo "== Supabase LAUNCHPAD_ADDRESS updated"
fi
echo "== Deployed (saved to $D)"
cat $D
