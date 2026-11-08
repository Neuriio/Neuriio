#!/bin/bash
# The "on switch" for trading a coin launched elsewhere through NeuriioSwap (user, 2026-11-08): give it the coin's address and it
#   1. reads the coin's Ascend pool from our own data (ascend_tokens) and checks the pool key against the pool id on record
#   2. on a local mainnet fork, approves it as the owner and does a real buy then a full sell; stops if the round trip loses more
#      than 20% (a coin that taxes or blocks transfers would trap buyers) or the sell leaves tokens behind
#   3. sends setPool(poolKey, coin, true) on mainnet; cast asks for the OWNER's private key (--interactive) (deployer 0x3606…bebf) at a hidden prompt
#   4. reads approved(coin) back from mainnet
# Works for any Ascend pair: WHYPE (paid in HYPE), KNTQ or USDC (paid in that token).
#   bash script/approve-coin.sh 0xCOIN [0xCOIN ...]        switch on (one key prompt per coin)
#   OFF=1 bash script/approve-coin.sh 0xCOIN               switch off (no fork test)
#   TEST_ONLY=1 bash script/approve-coin.sh 0xCOIN         fork test only, nothing sent
set -euo pipefail
cd "$(dirname "$0")/.."

SWAP=0x630B8f610abEAe77FD39f802136F57Dd2B2f4946   # NeuriioSwap (deployments/elysium-mainnet.json "swap")
HOOK=0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC   # Ascend's launchpad = the pools' hook
PM=0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1     # Uniswap v4 PoolManager (holds every quote token: funds the fork test)
WHYPE=0xba876237b0f021a6c6d852d6c26e107997cc5e81
SB=https://yviymgfgaepmtijgyyyo.supabase.co/rest/v1
SBKEY=sb_publishable_FegCC3kuFI9k3EsEP2TGYA_zucL2uoq  # public key: reads only
ALCHEMY=$(grep -E '^ALCHEMY_API_KEY=' app/.env.local | cut -d= -f2-)
RPC="https://elysium-mainnet.g.alchemy.com/v2/$ALCHEMY"
FORK=http://127.0.0.1:18710
TESTER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266              # anvil's public test account
TESTER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
KEYTYPE="(address,address,uint24,int24,address)"
lc() { echo "$1" | tr 'A-F' 'a-f'; }
num() { echo "$1" | awk '{print $1}'; }
# a fork transaction that must succeed: prints why if it doesn't, and fails the test
fsend() {
  local out
  out=$(cast send "$@" --gas-limit 8000000 --rpc-url $FORK --json 2>&1) || { echo "   fork step failed: ${out:0:200}"; return 1; }
  echo "$out" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("status") in ("0x1", 1, "1") else 1)' || { echo "   fork step reverted: $1 $2"; return 1; }
}

[ $# -ge 1 ] || { echo "usage: bash script/approve-coin.sh 0xCOIN [0xCOIN ...]"; exit 1; }
OWNER=$(cast call $SWAP "owner()(address)" --rpc-url "$RPC")

anvil_pid=""
cleanup() { [ -n "$anvil_pid" ] && kill "$anvil_pid" 2>/dev/null || true; }
trap cleanup EXIT

for COIN in "$@"; do
  COIN=$(cast to-check-sum-address "$COIN")
  echo "== $COIN"
  ROW=$(curl -s "$SB/ascend_tokens?address=eq.$(lc $COIN)&select=symbol,pool_id,quote,quote_symbol,quote_decimals" -H "apikey: $SBKEY")
  POOL_ID=$(echo "$ROW" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r[0]["pool_id"] if r else "")')
  [ -n "$POOL_ID" ] || { echo "   not an Ascend coin in our data: skipped"; continue; }
  read -r SYMBOL QUOTE QSYM QDEC <<<"$(echo "$ROW" | python3 -c 'import json,sys; r=json.load(sys.stdin)[0]; print(r["symbol"].strip().replace(" ","_"), r["quote"], r["quote_symbol"] or {"0xba876237b0f021a6c6d852d6c26e107997cc5e81": "WHYPE", "0xe45a355d9e9cad2ad85f2d03e3ee3102a036acf0": "KNTQ", "0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65": "USDC"}.get(r["quote"].lower(), "?"), r["quote_decimals"])')"
  if [[ "$(lc $COIN)" < "$(lc $QUOTE)" ]]; then C0=$COIN; C1=$QUOTE; else C0=$QUOTE; C1=$COIN; fi
  POOLKEY="($C0,$C1,8388608,200,$HOOK)"
  ID=$(cast keccak "$(cast abi-encode "f($KEYTYPE)" "$POOLKEY")")
  [ "$(lc $ID)" = "$(lc $POOL_ID)" ] || { echo "   pool key doesn't match the pool id on record ($ID vs $POOL_ID): skipped"; continue; }
  echo "   \$$SYMBOL, paired with $QSYM, pool $POOL_ID"

  if [ "${OFF:-0}" = "1" ]; then
    echo "   switching OFF on mainnet: enter the owner's private key at the prompt"
    cast send $SWAP "setPool($KEYTYPE,address,bool)" "$POOLKEY" $COIN false --interactive --rpc-url "$RPC"
    echo "   approved now: $(cast call $SWAP 'approved(address)(bool)' $COIN --rpc-url "$RPC")"
    continue
  fi
  if [ "$(cast call $SWAP 'approved(address)(bool)' $COIN --rpc-url "$RPC")" = "true" ]; then echo "   already tradable"; continue; fi

  # ---- fork test: approve as the owner, buy, sell everything back (a second try on a fresh fork before rejecting the coin)
  PASSED=0
  for attempt in 1 2; do
    anvil --fork-url "$RPC" --port 18710 --gas-price 0 --base-fee 0 --silent >/dev/null 2>&1 &
    anvil_pid=$!
    FAIL=0
    for _ in $(seq 1 60); do cast block-number --rpc-url $FORK >/dev/null 2>&1 && break; sleep 0.5; done
    cast code $SWAP --rpc-url $FORK >/dev/null 2>&1 || sleep 2  # the fork answers before it has fetched state: warm it up
    cast rpc anvil_impersonateAccount $OWNER --rpc-url $FORK >/dev/null
    cast rpc anvil_setBalance $OWNER 0x56BC75E2D63100000 --rpc-url $FORK >/dev/null
    fsend $SWAP "setPool($KEYTYPE,address,bool)" "$POOLKEY" $COIN true --from $OWNER --unlocked || FAIL=1
    DL=$(( $(date +%s) + 3600 ))
    if [ "$(lc $QUOTE)" = "$WHYPE" ] || [ "$QUOTE" = "0x0000000000000000000000000000000000000000" ]; then
      IN=10000000000000000   # 0.01 HYPE
      B0=$(cast balance $TESTER --rpc-url $FORK)
      fsend $SWAP "buy(address,uint256,uint256,address,uint256)" $COIN $IN 0 $TESTER $DL --value $IN --private-key $TESTER_KEY || FAIL=1
      GOT=$(num "$(cast call $COIN 'balanceOf(address)(uint256)' $TESTER --rpc-url $FORK)")
      fsend $COIN "approve(address,uint256)" $SWAP $GOT --private-key $TESTER_KEY || FAIL=1
      fsend $SWAP "sell(address,uint256,uint256,address,uint256)" $COIN $GOT 0 $TESTER $DL --private-key $TESTER_KEY || FAIL=1
      B1=$(cast balance $TESTER --rpc-url $FORK)
      BACK=$(python3 -c "print($B1 - $B0 + $IN)")
    else
      IN=$(python3 -c "print(5 * 10**$QDEC)")   # 5 KNTQ / 5 USDC
      cast rpc anvil_impersonateAccount $PM --rpc-url $FORK >/dev/null
      cast rpc anvil_setBalance $PM 0x56BC75E2D63100000 --rpc-url $FORK >/dev/null
      fsend $QUOTE "transfer(address,uint256)" $TESTER $IN --from $PM --unlocked || FAIL=1
      fsend $QUOTE "approve(address,uint256)" $SWAP $IN --private-key $TESTER_KEY || FAIL=1
      fsend $SWAP "buy(address,uint256,uint256,address,uint256)" $COIN $IN 0 $TESTER $DL --private-key $TESTER_KEY || FAIL=1
      GOT=$(num "$(cast call $COIN 'balanceOf(address)(uint256)' $TESTER --rpc-url $FORK)")
      fsend $COIN "approve(address,uint256)" $SWAP $GOT --private-key $TESTER_KEY || FAIL=1
      fsend $SWAP "sell(address,uint256,uint256,address,uint256)" $COIN $GOT 0 $TESTER $DL --private-key $TESTER_KEY || FAIL=1
      BACK=$(num "$(cast call $QUOTE 'balanceOf(address)(uint256)' $TESTER --rpc-url $FORK)")
    fi
    LEFT=$(num "$(cast call $COIN 'balanceOf(address)(uint256)' $TESTER --rpc-url $FORK)")
    kill "$anvil_pid" 2>/dev/null; wait "$anvil_pid" 2>/dev/null || true; anvil_pid=""
    PCT=$(python3 -c "print(round($BACK * 100 / $IN, 2))")
    echo "   fork test: bought $GOT, sold all back, got $PCT% of the money back (fees ~3% round trip), $LEFT left"
    if [ "$FAIL" = "1" ] || [ "$LEFT" != "0" ] || ! python3 -c "import sys; sys.exit(0 if $BACK * 100 >= $IN * 80 else 1)"; then
      if [ "$attempt" = "1" ]; then echo "   retrying on a fresh fork (a just-started fork can fail while it fetches mainnet state)"; continue; fi
      echo "   FAILED the round trip twice: NOT switched on"; continue 2
    fi
    PASSED=1; break
  done
  [ "$PASSED" = "1" ] || continue
  [ "${TEST_ONLY:-0}" = "1" ] && { echo "   test only: nothing sent"; continue; }

  # ---- the real switch
  echo "   switching ON on mainnet: enter the owner's private key ($OWNER) at the prompt"
  cast send $SWAP "setPool($KEYTYPE,address,bool)" "$POOLKEY" $COIN true --interactive --rpc-url "$RPC"
  echo "   tradable now: $(cast call $SWAP 'approved(address)(bool)' $COIN --rpc-url "$RPC")"
done
