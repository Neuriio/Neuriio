#!/usr/bin/env bash
# Prints every change our Uniswap V2 fork (src/swap/v2) makes to upstream v2-core v1.0.1 (lib/v2-core, pinned
# submodule). For auditors: everything not in this diff is Uniswap's audited code, byte for byte.
#   ./script/v2-diff.sh          (exit 0 even when there are differences)
set -uo pipefail
cd "$(dirname "$0")/.."
git -C lib/v2-core describe --tags --exact-match 2>/dev/null | grep -qx v1.0.1 \
  || { echo "lib/v2-core is not at tag v1.0.1: run git submodule update --init" >&2; exit 1; }
diff -ruN lib/v2-core/contracts src/swap/v2 --exclude=test --exclude=LICENSE
exit 0
