#!/usr/bin/env bash
# Moves HYPE from an account's HyperCore (testnet) spot balance to the same address on Elysium testnet:
# HyperCore -> HyperEVM (sendAsset to 0x2222…2222) -> Elysium (rollup Inbox.depositEth). Keeps 0.01 HYPE on HyperEVM.
#   ./script/hype-to-elysium.sh [account] [amount]   (default: burner, all spot HYPE; asks the keystore password once)
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
echo "Moving HYPE HyperCore -> HyperEVM -> Elysium for keystore '$ACCOUNT' (enter keystore password)"
KEY=$(cast wallet decrypt-keystore "$ACCOUNT" | awk '{print $NF}')
cd keeper
KEY=$KEY AMOUNT=${2:-} node tools/hype-to-elysium.mjs
