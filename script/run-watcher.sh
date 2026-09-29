#!/usr/bin/env bash
# Live trade watcher (keeper/watcher.mjs): broadcasts launched-token trades to the charts over Supabase Realtime the
# moment their block appears. Fetches the Supabase service_role key with the (logged-in) Supabase CLI into this
# process's environment only: never written to disk or printed. Ctrl-C / closing the tab stops it.
#   ./script/run-watcher.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REF=$(cat supabase/.temp/project-ref)
SUPABASE_SERVICE_KEY=$(supabase projects api-keys --project-ref "$REF" -o json 2>/dev/null \
  | python3 -c "import sys,json; print([k['api_key'] for k in json.load(sys.stdin) if k.get('name')=='service_role'][0])")
[ -n "$SUPABASE_SERVICE_KEY" ] || { echo "Couldn't read the service_role key: run 'supabase login' first" >&2; exit 1; }
export SUPABASE_SERVICE_KEY SUPABASE_URL="https://$REF.supabase.co"
mkdir -p logs
cd keeper && exec node watcher.mjs 2>&1 | tee -a ../logs/watcher.log
