#!/usr/bin/env bash
# Pushes schema changes, sets the functions' secrets (registry, current Launchpad, routers) from deployments/elysium-testnet.json, and deploys every Edge
# Function (launch-pass, register, indexer). Run after ./script/supabase-setup.sh (one-time). Safe to re-run.
#   ./script/supabase-deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REF=yviymgfgaepmtijgyyyo
D=deployments/elysium-testnet.json
RPC=https://testnet-rpc.elysium.kinetiq.xyz

echo "== Applying schema"
supabase db push

# the indexer follows EVERY Launchpad version in the registry (read on-chain), from the core's deploy block; passes are
# signed for the current version
REG=$(jq -r .launchRegistry $D); PAD=$(jq -r .launchpad $D); FROM=$(jq -r .coreBlock $D)
supabase secrets set --project-ref $REF REGISTRY_ADDRESS="$REG" LAUNCHPAD_ADDRESS="$PAD" \
  ROUTER_ADDRESSES="$(jq -r '(.routers // [.swapRouter]) | join(",")' $D)" \
  WHYPE_ADDRESS="$(jq -r .whype $D)" INDEX_FROM_BLOCK="$FROM" RPC_URL=$RPC HL_TESTNET=true >/dev/null
echo "   registry $REG (indexed from block $FROM), current Launchpad $PAD"

for f in launch-pass register indexer ftf; do
  echo "== Deploying $f"
  supabase functions deploy $f --project-ref $REF --use-api
done
echo "== Done. Indexer runs every minute; run it now:"
echo "   curl -s -X POST https://$REF.supabase.co/functions/v1/indexer | jq"
