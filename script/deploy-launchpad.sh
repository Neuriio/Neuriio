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

LAUNCH_SIGNER=$SIGNER WHYPE=$(jq -r '.whype // empty' $D) VIRTUAL_HYPE=${VIRTUAL_HYPE:-100000000000000000} FEE_BPS=${FEE_BPS:-75} \
  forge script script/DeployLaunchpad.s.sol --rpc-url elysium_testnet --account "$ACCOUNT" --broadcast --slow

RUN=broadcast/DeployLaunchpad.s.sol/99801/run-latest.json
addr() { jq -r --arg c "$1" '[.transactions[] | select(.contractName==$c and .transactionType=="CREATE")][0].contractAddress' $RUN; }
W=$(addr WHYPE); [ "$W" = "null" ] && W=$(jq -r .whype $D)
jq --arg w "$W" --arg f "$(addr UniswapV2Factory)" --arg l "$(addr Launchpad)" --arg r "$(addr SwapRouter)" --arg v "$(addr FeeVault)" \
  '. + {whype: $w, swapFactory: $f, launchpad: $l, swapRouter: $r, feeVault: $v}' $D > $D.tmp && mv $D.tmp $D
if [ -f supabase/.temp/project-ref ]; then
  supabase secrets set --project-ref "$(cat supabase/.temp/project-ref)" LAUNCHPAD_ADDRESS="$(addr Launchpad)" >/dev/null \
    && echo "== Supabase LAUNCHPAD_ADDRESS updated"
fi
echo "== Deployed (saved to $D)"
cat $D
