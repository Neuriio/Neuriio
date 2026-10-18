#!/usr/bin/env bash
# Points the Supabase backend at the testnet worlds and deploys its Edge Functions. Two worlds exist while the app moves
# from HYPE to USDC (2026-10-17): the old HYPE world (deployments/elysium-testnet-hype.json) and the USDC world
# (deployments/elysium-testnet.json). The indexer indexes both (secret WORLDS); APP_REGISTRY picks the one the app lists.
#   ./script/supabase-deploy.sh prepare   index the USDC world too, but keep the app, launch passes and FTFs on the old
#                                         world (safe while the live app is still the HYPE one); deploys the indexer only
#   ./script/supabase-deploy.sh switch    go-live: the app lists the USDC world and launch passes / FTFs are signed for
#                                         its NeuriioPad; deploys every function (launch-pass, register, indexer, ftf)
# Run after ./script/supabase-setup.sh (one-time). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
MODE=${1:?usage: supabase-deploy.sh prepare|switch}
REF=yviymgfgaepmtijgyyyo
D=deployments/elysium-testnet.json
OLD=deployments/elysium-testnet-hype.json
RPC=https://testnet-rpc.elysium.kinetiq.xyz

# every Launchpad version of each registry is read on-chain; each world is indexed from its core's deploy block
WORLDS=$(jq -cn --slurpfile o $OLD --slurpfile n $D '[
  {registry: $o[0].launchRegistry, routers: ($o[0].routers // [$o[0].swapRouter]), quote: $o[0].whype, decimals: 18, usd: "hype", fromBlock: $o[0].coreBlock},
  {registry: $n[0].launchRegistry, routers: $n[0].routers, quote: $n[0].usdc, decimals: 6, usd: "1", fromBlock: $n[0].coreBlock}
]')
case $MODE in
  prepare) APP=$OLD ;;
  switch) APP=$D ;;
  *) echo "usage: supabase-deploy.sh prepare|switch" >&2; exit 1 ;;
esac
REG=$(jq -r .launchRegistry $APP); PAD=$(jq -r .launchpad $APP)

if [ "$MODE" = switch ]; then
  echo "== Applying schema"
  supabase db push
  supabase secrets set --project-ref $REF WORLDS="$WORLDS" APP_REGISTRY="$REG" REGISTRY_ADDRESS="$REG" \
    LAUNCHPAD_ADDRESS="$PAD" RPC_URL=$RPC HL_TESTNET=true >/dev/null
  FUNCTIONS="launch-pass register indexer ftf"
else
  supabase secrets set --project-ref $REF WORLDS="$WORLDS" APP_REGISTRY="$REG" RPC_URL=$RPC HL_TESTNET=true >/dev/null
  FUNCTIONS="indexer"
fi
echo "   indexing $(echo "$WORLDS" | jq length) worlds; the app lists registry $REG ($([ "$MODE" = switch ] && echo USDC || echo HYPE) world)"

for f in $FUNCTIONS; do
  echo "== Deploying $f"
  supabase functions deploy $f --project-ref $REF --use-api
done
echo "== Done. The indexer runs every minute; run it now:"
echo "   curl -s -X POST https://$REF.supabase.co/functions/v1/indexer | jq"
