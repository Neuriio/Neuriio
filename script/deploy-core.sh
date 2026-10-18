#!/usr/bin/env bash
# ONE-TIME per network: a new world. Deploys the PERMANENT core, all in USDC (NeuriioRegistry, our Uniswap V2 fork
# factory with TOKEN/USDC pools at 1%, NeuriioStaking + $NEURIIO, NeuriioMinter, NeuriioFees, NeuriioRouter) and the
# first NeuriioPad, writes the deployments file (a world already in it is saved next to it first), and on testnet runs
# the live test. The testnet USDC world was deployed this way on 2026-10-17. Supabase, the indexer, the watcher and the
# app are NOT switched here (./script/supabase-deploy.sh does that).
# Never run this for an upgrade: a new core is a new world (old tokens stay on the old core). Upgrades are
# ./script/deploy-launchpad.sh (a new NeuriioPad version) and ./script/replace-feevault.sh (a new NeuriioFees).
#   ./script/deploy-core.sh [account]    (default: burner; asks its keystore password once)
# env: USDC (mainnet: the bridged USDC; unset = deploy our TestUSDC, testnet only, mintable only by FAUCET),
#      FAUCET (testnet faucet wallet), TREASURY_WALLET / BUYBACK_WALLET (default: the user's wallet),
#      VIRTUAL_QUOTE (USDC base units; default 1,000 USDC = graduates at ~2,834 USDC raised, ~$13.7k market cap;
#      mainnet ~$70k = 5_109e6), LAUNCH_SIGNER / HL_BUILDER (default: the previous world's), DEPLOYMENTS (the file),
#      RPC (another RPC, e.g. a local anvil for dry runs, with OWNER_KEY preset)
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=${DEPLOYMENTS:-deployments/elysium-testnet.json}
RPC=${RPC:-https://testnet-rpc.elysium.kinetiq.xyz}
FAUCET=${FAUCET:-0x51c2146469186e42fe74e915d4f6de26e4ed135a}
WALLET=${TREASURY_WALLET:-0x10E942585ceBf3dcf8377ff8eC38F2458662EEC3}
BUYBACK=${BUYBACK_WALLET:-$WALLET}
VQ=${VIRTUAL_QUOTE:-1000000000}
prev() { if [ -f "$D" ]; then jq -r "$1 // empty" "$D"; fi; }
SIGNER=${LAUNCH_SIGNER:-$(prev .launchSigner)}
BUILDER=${HL_BUILDER:-$(prev .hlBuilder)}
[[ "$SIGNER" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "No launch signer: set LAUNCH_SIGNER (the backend's pass signer)" >&2; exit 1; }
if [ -n "$(prev .launchRegistry)" ]; then # keep the world being replaced
  OLD=${D%.json}-$(prev .launchRegistry | cut -c3-8).json
  cp "$D" "$OLD"
  echo "== The world in $D is saved as $OLD"
fi

if [ -z "${OWNER_KEY:-}" ]; then # OWNER_KEY preset: local dry runs only
  echo "Enter the '$ACCOUNT' keystore password:"
  OWNER_KEY=$(cast wallet decrypt-keystore "$ACCOUNT" | awk '{print $NF}')
fi
CHAIN=$(cast chain-id --rpc-url "$RPC")
FROM=$(cast block-number --rpc-url "$RPC") # indexers start here (everything is deployed after this block)

echo "== 1/2 The core"
OUT=$(USDC=${USDC:-} FAUCET=$FAUCET TREASURY_WALLET=$WALLET BUYBACK_WALLET=$BUYBACK \
  forge script script/DeployCore.s.sol --rpc-url "$RPC" --private-key "$OWNER_KEY" --broadcast --slow \
  | tee /dev/stderr)
addr() { echo "$OUT" | awk -v k="$1" '$1 == k":" { print tolower($2) }' | tail -1; }
U=$(addr USDC); REG=$(addr NeuriioRegistry); STAKING=$(addr NeuriioStaking)
NEURIIO=$(addr NeuriioPlatformToken); MINTER=$(addr NeuriioMinter); V=$(addr NeuriioFees); ROUTER=$(addr NeuriioRouter)
F=$(echo "$OUT" | awk '/SwapFactory \(UniswapV2Factory\):/ { print tolower($NF) }' | tail -1)
for x in "$U" "$REG" "$F" "$STAKING" "$NEURIIO" "$MINTER" "$V" "$ROUTER"; do
  [[ "$x" =~ ^0x[0-9a-f]{40}$ ]] || { echo "Couldn't read a deployed address from the script output: '$x'" >&2; exit 1; }
done

echo "== 2/2 The first NeuriioPad"
PB=$(cast block-number --rpc-url "$RPC")
OUT=$(REGISTRY=$REG SWAP_FACTORY=$F FEE_VAULT=$V LAUNCH_SIGNER=$SIGNER VIRTUAL_QUOTE=$VQ FEE_BPS=100 \
  forge script script/DeployNeuriioPad.s.sol --rpc-url "$RPC" --private-key "$OWNER_KEY" --broadcast --slow \
  | tee /dev/stderr)
PAD=$(echo "$OUT" | awk '$1 == "NeuriioPad:" { print tolower($2) }' | tail -1)
[[ "$PAD" =~ ^0x[0-9a-f]{40}$ ]] || { echo "Couldn't read the NeuriioPad address: '$PAD'" >&2; exit 1; }

TEST_USDC=$([ -z "${USDC:-}" ] && echo true || echo false) # our TestUSDC: a testnet world, with a faucet
jq -n --arg usdc "$U" --arg reg "$REG" --arg f "$F" --arg st "$STAKING" --arg n "$NEURIIO" --arg m "$MINTER" --arg v "$V" \
  --arg r "$ROUTER" --arg pad "$PAD" --arg signer "$SIGNER" --arg builder "$BUILDER" --arg faucet "$FAUCET" \
  --argjson chain "$CHAIN" --argjson from "$FROM" --argjson pb "$PB" --argjson test "$TEST_USDC" \
  '{chainId: $chain, usdc: $usdc, launchRegistry: $reg, swapFactory: $f, staking: $st, neuriio: $n, minter: $m,
    feeVault: $v, feeVaults: [$v], router: $r, routers: [$r], launchSigner: $signer}
   + (if $builder != "" then {hlBuilder: $builder} else {} end) + (if $test then {faucet: $faucet} else {} end)
   + {coreBlock: $from, launchpads: [{address: $pad, block: $pb}], launchpad: $pad}' > "$D.tmp" && mv "$D.tmp" "$D"
echo "== World deployed (saved to $D):"
jq . "$D"

if [ "$TEST_USDC" = true ]; then
  echo "== Live test"
  OWNER_KEY=$OWNER_KEY DEPLOYMENTS=$D RPC=$RPC ./script/launchpad-test.sh "$ACCOUNT"
fi
unset OWNER_KEY
echo "== Next: ./script/verify-world.sh (verifies every contract on the explorer; no key needed)"
