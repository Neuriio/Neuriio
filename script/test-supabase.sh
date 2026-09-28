#!/usr/bin/env bash
# Runs supabase/tests/*.test.ts under Node (Deno isn't required): copies the Edge Function shared code into a temp
# folder inside keeper/ (for its node_modules), rewriting Deno "npm:pkg@ver" imports to plain "pkg".
set -euo pipefail
cd "$(dirname "$0")/.."
T=keeper/.tmp-supabase-tests
rm -rf $T && mkdir -p $T && trap 'rm -rf $T' EXIT
for f in supabase/functions/_shared/*.ts supabase/tests/*.test.ts; do
  sed -E 's#"npm:([^@"]+)@[^/"]+(/[^"]*)?"#"\1\2"#g' "$f" > "$T/$(basename "$f")"
done
node --test $T/*.test.ts
