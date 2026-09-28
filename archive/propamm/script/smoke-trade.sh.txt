#!/usr/bin/env bash
# Live test trade against the testnet PropAMM from a throwaway trader wallet.
#   ./script/smoke-trade.sh [funder-account]   (default: burner; asks its keystore password once)
#
# The trader key is generated in memory for this run only and never printed. The funder sends it
# 0.01 HYPE for gas; the trader mints its own test tokens, buys HYPE with 100 tUSDC, then sells 1 tHYPE.
set -euo pipefail
cd "$(dirname "$0")/.."
FUNDER=${1:-burner}
D=deployments/elysium-testnet.json
RPC=https://testnet-rpc.elysium.kinetiq.xyz
P=$(jq -r .propAMM $D); H=$(jq -r .tHYPE $D); U=$(jq -r .tUSDC $D)

TRADER_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
TRADER=$(cast wallet address --private-key "$TRADER_KEY")
as_trader() { cast send "$@" --private-key "$TRADER_KEY" --rpc-url $RPC --json | jq -r '"   tx \(.transactionHash) status \(.status) gas \(.gasUsed)"'; }

echo "== Trader wallet (throwaway): $TRADER"
echo "== Funding it with 0.01 HYPE from '$FUNDER' (enter keystore password)"
# Unlock first, then send immediately: the feeder signs with the same account every few seconds,
# so a nonce picked before a password prompt is almost always stale. Retry if the feeder still wins.
FUNDER_KEY=$(cast wallet decrypt-keystore "$FUNDER" | awk '{print $NF}')
for try in 1 2 3 4 5; do
  if out=$(cast send "$TRADER" --value 0.01ether --private-key "$FUNDER_KEY" --rpc-url $RPC --json 2>&1); then
    echo "$out" | jq -r '"   tx \(.transactionHash) status \(.status)"'; break
  fi
  if echo "$out" | grep -q "nonce too low" && [ $try -lt 5 ]; then echo "   feeder took the nonce, retrying ($try)"; sleep 0.3; continue; fi
  unset FUNDER_KEY; echo "$out" >&2; exit 1
done
unset FUNDER_KEY

echo "== Trader mints test tokens and approves the pool"
as_trader "$U" 'mint(address,uint256)' "$TRADER" 1000000000
as_trader "$H" 'mint(address,uint256)' "$TRADER" 10000000000000000000
as_trader "$U" 'approve(address,uint256)' "$P" 115792089237316195423570985008687907853269984665640564039457584007913129639935
as_trader "$H" 'approve(address,uint256)' "$P" 115792089237316195423570985008687907853269984665640564039457584007913129639935

mid() { curl -s -X POST https://api.hyperliquid.xyz/info -H 'content-type: application/json' -d '{"type":"l2Book","coin":"@107"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print((float(d['levels'][0][0]['px'])+float(d['levels'][1][0]['px']))/2)"; }
reserves() { echo "   pool now: $(cast call $P 'baseReserve()(uint128)' --rpc-url $RPC | awk '{printf "%.4f", $1/1e18}') tHYPE + $(cast call $P 'quoteReserve()(uint128)' --rpc-url $RPC | awk '{printf "%.2f", $1/1e6}') tUSDC"; }

# retries only on a stale-price revert (the pool refusing an old oracle price), never on slippage
swap() {
  local fn=$1 amt=$2 preview=$3 dec=$4 unit=$5
  for try in 1 2 3; do
    local out; out=$(cast call $P "$preview(uint256)(uint256,uint256)" $amt --rpc-url $RPC 2>&1) || { echo "   stale quote, retrying ($try)"; sleep 1.5; continue; }
    local exp; exp=$(echo "$out" | head -1 | awk '{print $1}')
    local min; min=$(python3 -c "print($exp * 99 // 100)")
    if as_trader $P "$fn(uint256,uint256,address,uint256)" $amt $min "$TRADER" $(( $(date +%s) + 120 )); then
      python3 -c "print(f'   got {$exp/10**$dec:.6f} $unit | HyperCore mid now \${$(mid):.4f}')"
      return 0
    fi
    echo "   reverted, retrying ($try)"; sleep 1.5
  done
  echo "   gave up after 3 tries" >&2; return 1
}

echo "== BUY: 100 tUSDC -> tHYPE"
swap buyBase 100000000 previewBuyBase 18 tHYPE
reserves
echo "== SELL: 1 tHYPE -> tUSDC"
swap sellBase 1000000000000000000 previewSellBase 6 tUSDC
reserves

echo "== Hedger reaction (simulated HyperCore), last lines of logs/hedger.log:"
sleep 4
tail -n 3 logs/hedger.log | python3 -c "
import json,sys
for l in sys.stdin:
  e=json.loads(l)
  if e.get('ev')=='hedge_order': print(f\"   pool HYPE {e['poolBase']:.4f} | perp was {e['perpPosition']:+.2f} -> {'BUY ' if e['isBuy'] else 'SELL'} {e['sz']} filled {e['filledSz']}\")"
unset TRADER_KEY
echo "== Done"
