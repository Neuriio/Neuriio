#!/usr/bin/env bash
# Pushes schema changes, sets the indexer's secrets from deployments/elysium-testnet.json, and deploys every Edge
# Function (launch-pass, register, indexer). Run after ./script/supabase-setup.sh (one-time). Safe to re-run.
#   ./script/supabase-deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REF=yviymgfgaepmtijgyyyo
D=deployments/elysium-testnet.json
RPC=https://testnet-rpc.elysium.kinetiq.xyz

echo "== Applying schema"
supabase db push

# index from the block the current Launchpad was deployed in
PAD=$(jq -r .launchpad $D)
FROM=$(jq -r --arg p "$PAD" '[.receipts[] | select((.contractAddress // "" | ascii_downcase) == ($p | ascii_downcase))][0].blockNumber' \
  broadcast/DeployLaunchpad.s.sol/99801/run-latest.json)
FROM=$(cast to-dec "$FROM")
supabase secrets set --project-ref $REF LAUNCHPAD_ADDRESS="$PAD" ROUTER_ADDRESS="$(jq -r .swapRouter $D)" \
  WHYPE_ADDRESS="$(jq -r .whype $D)" INDEX_FROM_BLOCK="$FROM" RPC_URL=$RPC HL_TESTNET=true >/dev/null
echo "   indexing Launchpad $PAD from block $FROM"

for f in launch-pass register indexer ftf; do
  echo "== Deploying $f"
  supabase functions deploy $f --project-ref $REF --use-api
done
echo "== Done. Indexer runs every minute; run it now:"
echo "   curl -s -X POST https://$REF.supabase.co/functions/v1/indexer | jq"
