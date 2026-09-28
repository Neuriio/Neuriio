#!/usr/bin/env bash
# Live launchpad test on Elysium testnet: a throwaway trader launches a token, buys, sells, graduates it (LP burned)
# and swaps on the pool. Launch passes normally come from the Supabase launch-pass function; here the owner points
# the Launchpad at a throwaway test signer for the run and restores the real signer at the end.
#   ./script/launchpad-test.sh [account]   (default: burner; asks its keystore password once)
# Testnet VIRTUAL_HYPE = 0.1 HYPE -> graduates at ~0.29 HYPE. The trader's leftover HYPE goes back to the account.
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=${DEPLOYMENTS:-deployments/elysium-testnet.json}
RPC=${RPC:-https://testnet-rpc.elysium.kinetiq.xyz}
DEAD=0x000000000000000000000000000000000000dEaD

if [ -n "${LOCAL_KEY:-}" ]; then OWNER_KEY=$LOCAL_KEY; else # LOCAL_KEY: local anvil dry runs only
  echo "Enter the '$ACCOUNT' keystore password:"
  OWNER_KEY=$(cast wallet decrypt-keystore "$ACCOUNT" | awk '{print $NF}')
fi
OWNER=$(cast wallet address --private-key "$OWNER_KEY")

send() { # retry a few times (Elysium's clock / nonce hiccups)
  for try in 1 2 3 4 5; do
    if out=$(cast send "$@" --rpc-url $RPC --json 2>&1); then echo "$out" | jq -r .transactionHash; return 0; fi
    [ $try -lt 5 ] || { echo "FAILED: $out" >&2; return 1; }
    sleep 1
  done
}
call() { cast call "$@" --rpc-url $RPC | awk '{print $1}'; }
eth() { cast from-wei "$1"; }
check() { if [ "$2" = "true" ]; then echo "  ✓ $1"; else echo "  ✗ $1" >&2; FAIL=1; fi; }
FAIL=0

PAD=$(jq -r .launchpad $D); ROUTER=$(jq -r .swapRouter $D); FACTORY=$(jq -r .swapFactory $D); WHYPE=$(jq -r .whype $D)
echo "  Launchpad $PAD · SwapRouter $ROUTER · SwapFactory $FACTORY · WHYPE $WHYPE"

TRADER_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
TRADER=$(cast wallet address --private-key "$TRADER_KEY")
FUND=${FUND:-0.35}
echo "== Funding throwaway trader $TRADER with $FUND HYPE (the run spends ~0.30; leftovers come back)"
send "$TRADER" --value ${FUND}ether --private-key "$OWNER_KEY" >/dev/null
DL=$(( $(date +%s) + 600 ))
T() { send "$@" --private-key "$TRADER_KEY"; }

echo "== 1. Launch (free, signed pass) with a 0.01 HYPE creator buy"
REAL_SIGNER=$(call $PAD "launchSigner()(address)")
TEST_SIGNER_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
send $PAD "setLaunchSigner(address)" $(cast wallet address --private-key "$TEST_SIGNER_KEY") --private-key "$OWNER_KEY" >/dev/null
restore_signer() { send $PAD "setLaunchSigner(address)" $REAL_SIGNER --private-key "$OWNER_KEY" >/dev/null && echo "== Restored launch signer $REAL_SIGNER"; }
trap restore_signer EXIT
XID=$(( 1000000 + RANDOM * 1000 + RANDOM % 1000 )); HANDLE="test_$RANDOM$RANDOM"; HANDLE=${HANDLE:0:15}
PROFILE_HASH=$(cast keccak "live test profile $XID")
PASS="($TRADER,$XID,$HANDLE,0,$PROFILE_HASH,$DL)"
DIGEST=$(call $PAD "hashLaunchPass((address,uint64,string,uint8,bytes32,uint256))(bytes32)" "$PASS")
SIG=$(cast wallet sign --no-hash "$DIGEST" --private-key "$TEST_SIGNER_KEY")
N0=$(call $PAD "allTokensLength()(uint256)")
T $PAD "launch((address,uint64,string,uint8,bytes32,uint256),bytes,uint256)" "$PASS" $SIG 0 --value 0.01ether >/dev/null
TOKEN=$(call $PAD "allTokens(uint256)(address)" $N0)
echo "  token $TOKEN"
NAME=$(cast call $TOKEN "name()(string)" --rpc-url $RPC); SYM=$(cast call $TOKEN "symbol()(string)" --rpc-url $RPC)
check "named $NAME / $SYM" "$( [ "$NAME" = "\"@$HANDLE\"" ] && echo true )"
check "one token per X account (tokenOfXUser set)" "$( [ "$(call $PAD "tokenOfXUser(uint64)(address)" $XID)" = "$TOKEN" ] && echo true )"
BAL1=$(call $TOKEN "balanceOf(address)(uint256)" $TRADER)
check "creator got $(eth $BAL1) $HANDLE" "$( [ "$BAL1" != "0" ] && echo true )"

echo "== 2. Buy 0.05 HYPE on the curve"
EXP=$(cast call $PAD "previewBuy(address,uint256)(uint256,uint256,uint256,uint256)" $TOKEN 50000000000000000 --rpc-url $RPC | head -1 | awk '{print $1}')
T $PAD "buy(address,uint256,uint256)" $TOKEN $EXP $DL --value 0.05ether >/dev/null
BAL2=$(call $TOKEN "balanceOf(address)(uint256)" $TRADER)
check "received exactly the preview: $(python3 -c "print(($BAL2-$BAL1)/1e18)") $HANDLE" "$( [ "$(python3 -c "print($BAL2-$BAL1)")" = "$EXP" ] && echo true )"

echo "== 3. Sell half back"
HALF=$(python3 -c "print($BAL2//2)")
EXPH=$(cast call $PAD "previewSell(address,uint256)(uint256,uint256)" $TOKEN $HALF --rpc-url $RPC | head -1 | awk '{print $1}')
T $TOKEN "approve(address,uint256)" $PAD $HALF >/dev/null
HB=$(cast balance $TRADER --rpc-url $RPC)
TX=$(T $PAD "sell(address,uint256,uint256,uint256)" $TOKEN $HALF $EXPH $DL)
GAS=$(python3 -c "print($(cast receipt $TX gasUsed --rpc-url $RPC) * $(cast receipt $TX effectiveGasPrice --rpc-url $RPC))")
HA=$(cast balance $TRADER --rpc-url $RPC)
check "got $(eth $EXPH) HYPE back (after the curve fee)" "$(python3 -c "print('true' if $HA-$HB+$GAS==$EXPH else '')")"

echo "== 4. Graduate: buy out the rest of the curve"
NEED=$(call $PAD "hypeToGraduate(address)(uint256)" $TOKEN)
echo "  HYPE to graduate: $(eth $NEED)"
T $PAD "buy(address,uint256,uint256)" $TOKEN 0 $DL --value $(python3 -c "print($NEED + 10**16)") >/dev/null
GRAD=$(cast call $PAD "curves(address)(address,bool,uint128,uint128,uint128,uint128)" $TOKEN --rpc-url $RPC | sed -n 2p)
check "graduated" "$GRAD"
PAIR=$(call $FACTORY "getPair(address,address)(address)" $TOKEN $WHYPE)
echo "  pool $PAIR"
LP_DEAD=$(call $PAIR "balanceOf(address)(uint256)" $DEAD); LP_TOTAL=$(call $PAIR "totalSupply()(uint256)")
check "all LP burned ($(eth $LP_DEAD) of $(eth $LP_TOTAL) at 0x…dEaD)" "$( [ "$LP_DEAD" = "$LP_TOTAL" ] && echo true )"
check "launchpad holds no tokens" "$( [ "$(call $TOKEN "balanceOf(address)(uint256)" $PAD)" = "0" ] && echo true )"
RES=$(cast call $PAIR "getReserves()(uint112,uint112,uint32)" --rpc-url $RPC | awk '{print $1}' | head -2 | tr '\n' ' ')
echo "  pool reserves: $RES"

echo "== 5. Trade on the pool through the router"
Q=$(call $ROUTER "quoteBuy(address,uint256)(uint256)" $TOKEN 10000000000000000)
B0=$(call $TOKEN "balanceOf(address)(uint256)" $TRADER)
T $ROUTER "buy(address,uint256,address,uint256)" $TOKEN $Q $TRADER $DL --value 0.01ether >/dev/null
B1=$(call $TOKEN "balanceOf(address)(uint256)" $TRADER)
check "router buy 0.01 HYPE -> $(python3 -c "print(($B1-$B0)/1e18)") $HANDLE (= quote)" "$( [ "$(python3 -c "print($B1-$B0)")" = "$Q" ] && echo true )"
QS=$(call $ROUTER "quoteSell(address,uint256)(uint256)" $TOKEN $B1)
T $TOKEN "approve(address,uint256)" $ROUTER $B1 >/dev/null
T $ROUTER "sell(address,uint256,uint256,address,uint256)" $TOKEN $B1 $QS $TRADER $DL >/dev/null
check "router sold all remaining $HANDLE for $(eth $QS) HYPE" "$( [ "$(call $TOKEN "balanceOf(address)(uint256)" $TRADER)" = "0" ] && echo true )"

VAULT=$(jq -r .feeVault $D)
EARNED=$(call $VAULT "creatorBalance(address)(uint256)" $TRADER)
echo "== Fees in the vault: $(eth $(cast balance $VAULT --rpc-url $RPC)) HYPE (community $(eth $(call $VAULT "communityBalance()(uint256)")), buyback $(eth $(call $VAULT "buybackBalance()(uint256)")))"
check "creator (the trader) earned $(eth $EARNED) HYPE = 80% of curve + pool fees" "$( [ "$EARNED" != "0" ] && echo true )"
CB=$(cast balance $TRADER --rpc-url $RPC)
T $VAULT "claim(address)" $TRADER >/dev/null
CA=$(cast balance $TRADER --rpc-url $RPC)
check "creator claimed their fees" "$(python3 -c "print('true' if $CA > $CB else '')")"
LEFT=$(cast balance $TRADER --rpc-url $RPC)
GP=$(cast gas-price --rpc-url $RPC)
# a plain transfer costs ~21.9k gas on Elysium (L2 gas + data fee), not 21k: fix the limit, keep 2x headroom on price
RET=$(python3 -c "print(max(0, $LEFT - 40000*$GP*2))")
if [ "$RET" != "0" ]; then
  if send $OWNER --value $RET --gas-limit 40000 --gas-price $((GP * 2)) --private-key "$TRADER_KEY" >/dev/null; then
    echo "== Returned $(eth $RET) HYPE to $ACCOUNT"
  else
    echo "!! Could not return the trader's HYPE; its key (keep it, testnet only): $TRADER_KEY" >&2; FAIL=1
  fi
fi
unset TRADER_KEY
[ $FAIL = 0 ] && echo "== ALL CHECKS PASSED" || { echo "== SOME CHECKS FAILED" >&2; exit 1; }
