#!/usr/bin/env bash
# One-time Supabase setup for "Tokenize Yourself" (project ref yviymgfgaepmtijgyyyo). Safe to re-run.
#   ./script/supabase-setup.sh
# 1. installs the Supabase CLI (Homebrew) and logs in (browser)   2. links the project (asks the DB password)
# 3. applies the schema (supabase/migrations)                     4. creates the launch-signer key INSIDE Supabase
#    secrets (printed: only its address; the key is never shown or saved locally)
# 5. asks for the Privy app secret (hidden input)                 6. deploys the launch-pass Edge Function
# Re-run with ROTATE_SIGNER=1 to make a new signer key (then point the Launchpad at it: setLaunchSigner).
set -euo pipefail
cd "$(dirname "$0")/.."
REF=yviymgfgaepmtijgyyyo
D=deployments/elysium-testnet.json

command -v supabase >/dev/null || brew install supabase/tap/supabase
supabase projects list >/dev/null 2>&1 || supabase login
[ -f supabase/.temp/project-ref ] && [ "$(cat supabase/.temp/project-ref)" = "$REF" ] || supabase link --project-ref $REF

echo "== Applying schema"
supabase db push

if [ -z "$(jq -r '.launchSigner // empty' $D)" ] || [ "${ROTATE_SIGNER:-}" = 1 ]; then
  echo "== Creating the launch-signer key (stored only as a Supabase secret)"
  KEY=$(cast wallet new --json | jq -r '.[0].private_key')
  ADDR=$(cast wallet address --private-key "$KEY")
  supabase secrets set --project-ref $REF LAUNCH_SIGNER_KEY="$KEY" >/dev/null
  unset KEY
  jq --arg a "$ADDR" '. + {launchSigner: $a}' $D > $D.tmp && mv $D.tmp $D
  echo "   launch signer address: $ADDR (saved to $D)"
fi

if ! supabase secrets list --project-ref $REF 2>/dev/null | grep -q PRIVY_APP_SECRET; then
  echo "== Paste the Privy app secret (dashboard.privy.io -> your app -> Settings -> App secret; input hidden):"
  read -rs PRIVY_SECRET; echo
  supabase secrets set --project-ref $REF PRIVY_APP_SECRET="$PRIVY_SECRET" >/dev/null
  unset PRIVY_SECRET
fi
PRIVY_APP_ID=$(grep '^VITE_PRIVY_APP_ID=' app/.env.local | cut -d= -f2-)
LAUNCHPAD=$(jq -r '.launchpad' $D)
supabase secrets set --project-ref $REF PRIVY_APP_ID="$PRIVY_APP_ID" LAUNCHPAD_ADDRESS="$LAUNCHPAD" \
  CHAIN_ID=99801 RPC_URL=https://testnet-rpc.elysium.kinetiq.xyz >/dev/null
echo "   LAUNCHPAD_ADDRESS=$LAUNCHPAD"

echo "== Deploying launch-pass"
supabase functions deploy launch-pass --project-ref $REF --use-api
echo "== Done: https://$REF.supabase.co/functions/v1/launch-pass"
