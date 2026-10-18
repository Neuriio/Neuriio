#!/usr/bin/env bash
# Live test of the USDC world on Elysium testnet. A throwaway trader launches a token, trades it on the curve through the
# NeuriioRouter, graduates it (LP burned), stakes the X token, trades the pool (the stakers earn USDC and mint $NEURIIO,
# 100 per $1), and claims staking rewards (the $NEURIIO is staked for them) and creator fees. Launch passes normally come from the Supabase launch-pass
# function; here the owner points the NeuriioPad at a throwaway signer for the run and restores the real one at the
# end. The owner mints the trader test USDC (as a minter only for the run) and sends a little HYPE for gas.
#   ./script/launchpad-test.sh [account]   (default: burner; asks its keystore password unless OWNER_KEY is set)
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=${DEPLOYMENTS:-deployments/elysium-testnet.json}
RPC=${RPC:-https://testnet-rpc.elysium.kinetiq.xyz}
DEAD=0x000000000000000000000000000000000000dEaD
ZERO=0x0000000000000000000000000000000000000000

if [ -z "${OWNER_KEY:-}" ]; then
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
call1() { cast call "$@" --rpc-url $RPC | head -1 | awk '{print $1}'; } # first of several return values
usd() { python3 -c "print(f'{$1/1e6:,.6f}'.rstrip('0').rstrip('.'))"; }
tok() { python3 -c "print(f'{$1/1e18:,.2f}')"; }
py() { python3 -c "print($1)"; }
check() { if [ "$2" = "true" ]; then echo "  ✓ $1"; else echo "  ✗ $1" >&2; FAIL=1; fi; }
FAIL=0

PAD=$(jq -r .launchpad $D); ROUTER=$(jq -r .router $D); FACTORY=$(jq -r .swapFactory $D); USDC=$(jq -r .usdc $D)
STAKING=$(jq -r .staking $D); NEURIIO=$(jq -r .neuriio $D); VAULT=$(jq -r .feeVault $D); REG=$(jq -r .launchRegistry $D)
echo "  NeuriioPad $PAD · NeuriioRouter $ROUTER · factory $FACTORY · USDC $USDC"
echo "  staking $STAKING · \$NEURIIO $NEURIIO · fees $VAULT"

TRADER_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
TRADER=$(cast wallet address --private-key "$TRADER_KEY")
echo "== Funding throwaway trader $TRADER: 0.02 HYPE for gas + 10,000 test USDC"
send "$TRADER" --value 0.02ether --private-key "$OWNER_KEY" >/dev/null
send $USDC "setMinter(address,bool)" $OWNER true --private-key "$OWNER_KEY" >/dev/null
send $USDC "mint(address,uint256)" $TRADER 10000000000 --private-key "$OWNER_KEY" >/dev/null
send $USDC "setMinter(address,bool)" $OWNER false --private-key "$OWNER_KEY" >/dev/null
DL=$(( $(date +%s) + 900 ))
T() { send "$@" --private-key "$TRADER_KEY"; }
MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935
T $USDC "approve(address,uint256)" $PAD $MAX >/dev/null
T $USDC "approve(address,uint256)" $ROUTER $MAX >/dev/null

echo "== 1. Launch (free, signed pass) with a 10 USDC creator buy"
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
T $PAD "launch((address,uint64,string,uint8,bytes32,uint256),bytes,uint256,uint256)" "$PASS" $SIG 10000000 0 >/dev/null
TOKEN=$(call $PAD "allTokens(uint256)(address)" $N0)
echo "  token $TOKEN"
NAME=$(cast call $TOKEN "name()(string)" --rpc-url $RPC); SYM=$(cast call $TOKEN "symbol()(string)" --rpc-url $RPC)
check "named $NAME / $SYM" "$( [ "$NAME" = "\"@$HANDLE\"" ] && echo true )"
check "one token per X account (registry tokenOfXUser set)" "$( [ "$(call $REG "tokenOfXUser(uint64)(address)" $XID)" = "$TOKEN" ] && echo true )"
BAL1=$(call $TOKEN "balanceOf(address)(uint256)" $TRADER)
check "creator got $(tok $BAL1) $HANDLE" "$( [ "$BAL1" != "0" ] && echo true )"
T $TOKEN "approve(address,uint256)" $ROUTER $MAX >/dev/null
T $TOKEN "approve(address,uint256)" $STAKING $MAX >/dev/null

echo "== 2. Buy 100 USDC on the curve through the router"
EXP=$(call1 $ROUTER "quoteBuy(address,uint256)(uint256,uint256)" $TOKEN 100000000)
T $ROUTER "buy(address,uint256,uint256,uint256)" $TOKEN 100000000 $EXP $DL >/dev/null
BAL2=$(call $TOKEN "balanceOf(address)(uint256)" $TRADER)
BOUGHT=$(py "$BAL2-$BAL1")
check "received exactly the quote: $(tok $BOUGHT) $HANDLE" "$( [ "$BOUGHT" = "$EXP" ] && echo true )"

echo "== 3. Sell them back through the router (curve fee: 80% \$NEURIIO stakers / 10% buyback / 10% treasury)"
BB0=$(call $VAULT "buybackBalance()(uint256)"); SUP0=$(call $NEURIIO "totalSupply()(uint256)")
T $ROUTER "sell(address,uint256,uint256,uint256)" $TOKEN $BOUGHT 0 $DL >/dev/null
BB1=$(call $VAULT "buybackBalance()(uint256)")
check "KNTQ buyback got $(usd $(py "$BB1-$BB0")) USDC (10%)" "$(py "'true' if $BB1 > $BB0 else ''")"
check "no \$NEURIIO minted on the curve" "$( [ "$(call $NEURIIO "totalSupply()(uint256)")" = "$SUP0" ] && echo true )"

echo "== 4. Graduate: buy out the rest of the curve through the router"
NEED=$(call $PAD "quoteToGraduate(address)(uint256)" $TOKEN)
echo "  USDC to graduate: $(usd $NEED)"
U0=$(call $USDC "balanceOf(address)(uint256)" $TRADER)
T $ROUTER "buy(address,uint256,uint256,uint256)" $TOKEN $(py "$NEED+50000000") 0 $DL >/dev/null
U1=$(call $USDC "balanceOf(address)(uint256)" $TRADER)
check "took only what was needed ($(usd $(py "$U0-$U1")) USDC)" "$( [ "$(py "$U0-$U1")" = "$NEED" ] && echo true )"
GRAD=$(cast call $PAD "curves(address)(address,bool,uint128,uint128,uint128,uint128)" $TOKEN --rpc-url $RPC | sed -n 2p)
check "graduated" "$GRAD"
PAIR=$(call $FACTORY "getPair(address,address)(address)" $TOKEN $USDC)
echo "  pool $PAIR"
LP_DEAD=$(call $PAIR "balanceOf(address)(uint256)" $DEAD); LP_TOTAL=$(call $PAIR "totalSupply()(uint256)")
LP_ZERO=$(call $PAIR "balanceOf(address)(uint256)" $ZERO) # V2 locks 1,000 units there
check "all LP burned" "$( [ "$(py "$LP_DEAD+$LP_ZERO")" = "$LP_TOTAL" ] && echo true )"
RAISED=$(cast call $PAD "curves(address)(address,bool,uint128,uint128,uint128,uint128)" $TOKEN --rpc-url $RPC | sed -n 5p | awk '{print $1}')
check "launchpad kept none of its tokens or USDC" "$( [ "$(call $TOKEN "balanceOf(address)(uint256)" $PAD)$RAISED" = "00" ] && echo true )"
check "staking is open for the token" "$(call $STAKING "isStakeable(address)(bool)" $TOKEN)"

echo "== 5. Stake half the trader's $HANDLE, then trade the pool through the router (1% fee)"
HALF=$(py "$(call $TOKEN "balanceOf(address)(uint256)" $TRADER)//2")
T $STAKING "stake(address,uint256)" $TOKEN $HALF >/dev/null
H0=$(call $VAULT "holdersEarned(address)(uint256)" $TOKEN); S0=$(call $VAULT "stakersEarned()(uint256)")
SUP0=$(call $NEURIIO "totalSupply()(uint256)"); NSTAKED=$(call $STAKING "totalStaked(address)(uint256)" $NEURIIO)
Q=$(call1 $ROUTER "quoteBuy(address,uint256)(uint256,uint256)" $TOKEN 200000000)
B0=$(call $TOKEN "balanceOf(address)(uint256)" $TRADER)
T $ROUTER "buy(address,uint256,uint256,uint256)" $TOKEN 200000000 $Q $DL >/dev/null
B1=$(call $TOKEN "balanceOf(address)(uint256)" $TRADER)
check "pool buy 200 USDC -> $(tok $(py "$B1-$B0")) $HANDLE (= quote)" "$( [ "$(py "$B1-$B0")" = "$Q" ] && echo true )"
T $ROUTER "sell(address,uint256,uint256,uint256)" $TOKEN $(py "$B1-$B0") 0 $DL >/dev/null
H1=$(call $VAULT "holdersEarned(address)(uint256)" $TOKEN); S1=$(call $VAULT "stakersEarned()(uint256)")
check "token stakers got $(usd $(py "$H1-$H0")) USDC (40%)" "$(py "'true' if $H1 > $H0 else ''")"
MINTED=$(py "$(call $NEURIIO "totalSupply()(uint256)")-$SUP0")
check "which minted $(tok $MINTED) \$NEURIIO for them (100 per \$1)" "$( [ "$MINTED" = "$(py "($H1-$H0)*10**14")" ] && echo true )"
if [ "$NSTAKED" = "0" ]; then
  check "\$NEURIIO stakers' 40% fell to the treasury (nobody stakes \$NEURIIO yet)" "$( [ "$S1" = "$S0" ] && echo true )"
else
  check "\$NEURIIO stakers got $(usd $(py "$S1-$S0")) USDC (40%)" "$(py "'true' if abs(($S1-$S0)-($H1-$H0)) <= 10 else ''")"
fi
echo "  platform fees so far: $(usd $(call $VAULT "totalFees()(uint256)")) USDC"

echo "== 6. Wait 15 s for the drip, then claim: USDC to the wallet, \$NEURIIO staked"
sleep 15
T $TRADER --value 0 >/dev/null # Elysium only makes blocks for txs: this one moves the chain's clock forward
E=$(cast call $STAKING "earned(address,address)(uint256,uint256)" $TRADER $TOKEN --rpc-url $RPC | awk '{print $1}' | tr '\n' ' ')
check "earning on $HANDLE (USDC, \$NEURIIO): $E" "$(py "'true' if $(echo $E | awk '{print $1}') > 0 and $(echo $E | awk '{print $2}') > 0 else ''")"
U0=$(call $USDC "balanceOf(address)(uint256)" $TRADER)
T $STAKING "claim(address[],address)" "[$TOKEN]" $TRADER >/dev/null
U1=$(call $USDC "balanceOf(address)(uint256)" $TRADER)
NS=$(call $STAKING "stakedOf(address,address)(uint256)" $TRADER $NEURIIO)
check "claimed $(usd $(py "$U1-$U0")) USDC and $(tok $NS) \$NEURIIO (now staked)" "$(py "'true' if $U1 > $U0 and $NS > 0 else ''")"
CF=$(call $VAULT "creatorBalance(address)(uint256)" $TRADER)
T $VAULT "claim(address)" $TRADER >/dev/null
U2=$(call $USDC "balanceOf(address)(uint256)" $TRADER)
check "creator claimed $(usd $CF) USDC of fees (10%)" "$( [ "$(py "$U2-$U1")" = "$CF" ] && [ "$CF" != "0" ] && echo true )"
check "vault holds exactly what it owes" "$( [ "$(call $USDC "balanceOf(address)(uint256)" $VAULT)" = "$(call $VAULT "held()(uint256)")" ] && echo true )"

LEFT=$(cast balance $TRADER --rpc-url $RPC)
GP=$(cast gas-price --rpc-url $RPC)
# a plain transfer costs ~21.9k gas on Elysium (L2 gas + data fee), not 21k: fix the limit, keep 2x headroom on price
RET=$(py "max(0, $LEFT - 40000*$GP*2)")
if [ "$RET" != "0" ]; then
  if send $OWNER --value $RET --gas-limit 40000 --gas-price $((GP * 2)) --private-key "$TRADER_KEY" >/dev/null; then
    echo "== Returned $(cast from-wei $RET) HYPE to $ACCOUNT"
  else
    echo "!! Could not return the trader's HYPE; its key (keep it, testnet only): $TRADER_KEY" >&2; FAIL=1
  fi
fi
unset TRADER_KEY
[ $FAIL = 0 ] && echo "== ALL CHECKS PASSED" || { echo "== SOME CHECKS FAILED" >&2; exit 1; }
