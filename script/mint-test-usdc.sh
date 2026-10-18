#!/usr/bin/env bash
# Mints test USDC on Elysium testnet (testnet only): the owner of TestUSDC makes itself a minter, mints AMOUNT whole
# USDC to TO, and removes itself again. TO = "faucet" tops up the faucet wallet, which pays each X account 1,000 test
# USDC once (ftf function: claimHype) from its balance.
#   ./script/mint-test-usdc.sh <to address | faucet> <amount> [account]   (default account: burner; asks its password)
set -euo pipefail
cd "$(dirname "$0")/.."
D=${DEPLOYMENTS:-deployments/elysium-testnet.json}
RPC=${RPC:-https://testnet-rpc.elysium.kinetiq.xyz}
TO=${1:?usage: mint-test-usdc.sh <to|faucet> <amount> [account]}
AMOUNT=${2:?usage: mint-test-usdc.sh <to|faucet> <amount> [account]}
ACCOUNT=${3:-burner}
USDC=$(jq -r .usdc $D)
[ "$TO" = faucet ] && TO=$(jq -r .faucet $D)
[[ "$TO" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "Not an address: $TO" >&2; exit 1; }
[[ "$AMOUNT" =~ ^[0-9]+$ ]] || { echo "Amount in whole USDC: $AMOUNT" >&2; exit 1; }
if [ -z "${OWNER_KEY:-}" ]; then
  echo "Enter the '$ACCOUNT' keystore password:"
  OWNER_KEY=$(cast wallet decrypt-keystore "$ACCOUNT" | awk '{print $NF}')
fi
OWNER=$(cast wallet address --private-key "$OWNER_KEY")
send() { cast send "$@" --rpc-url $RPC --private-key "$OWNER_KEY" >/dev/null; }
bal() { python3 -c "print(f'{$(cast call $USDC "balanceOf(address)(uint256)" $TO --rpc-url $RPC | awk '{print $1}')/1e6:,.2f}')"; }
echo "== $TO holds $(bal) test USDC; minting $AMOUNT"
send $USDC "setMinter(address,bool)" $OWNER true
trap 'send $USDC "setMinter(address,bool)" $OWNER false && echo "== Owner is no longer a minter"; unset OWNER_KEY' EXIT
send $USDC "mint(address,uint256)" $TO "${AMOUNT}000000"
echo "== $TO now holds $(bal) test USDC"
