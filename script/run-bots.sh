#!/usr/bin/env bash
# Starts the testnet bots against deployments/elysium-testnet.json.
#   TOPUP_FROM=0xTreasury ./script/run-bots.sh [account]     (default: burner)   Ctrl-C stops everything.
#   TOPUP_FROM: wallets that fund the HyperCore inventory account (their transfers are top-ups,
#               not user withdrawals). Comma-separated.
#
# The key is unlocked from the Foundry keystore once, kept in memory only (never written to
# disk or printed), and handed to each bot through its environment.
#
#   feeder  live       HyperCore mainnet HYPE/USDC (107) + KNTQ/USDC (334) prices -> oracle about every 1.5s
#   hedger  simulated  the pool prices off mainnet HYPE; testnet HYPE is a different market,
#                      so fills are simulated at the live mainnet price
#   relayer live       bridge credit follows the account's HyperCore *testnet* USDC balance
#                      (0 until funded, so deposits are safely rejected); the sponsor kicks it
#                      on 127.0.0.1:8790 right after a one-click deposit
#   sponsor optional   one-click gas sponsor on :8787, only if SPONSOR_ACCOUNT is set: a SEPARATE
#                      keystore account holding a little HYPE (sharing the feeder's key clashes nonces)
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT=${1:-burner}
D=deployments/elysium-testnet.json
# official RPC first, third-party backup second (bots fail over on errors / rate limits)
RPC=https://testnet-rpc.elysium.kinetiq.xyz,https://elysium-testnet-rpc.hypedexer.com/
mkdir -p logs

echo "Unlocking keystore '$ACCOUNT' (key stays in memory only)"
KEY=$(cast wallet decrypt-keystore "$ACCOUNT" | awk '{print $NF}')
if [[ ! $KEY =~ ^0x[0-9a-fA-F]{64}$ ]]; then echo "could not unlock keystore" >&2; exit 1; fi

MID=$(curl -s -X POST https://api.hyperliquid.xyz/info -H 'content-type: application/json' -d '{"type":"allMids"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['HYPE'])")

PIDS=()
trap 'echo; echo "stopping bots"; kill "${PIDS[@]}" 2>/dev/null || true' INT TERM EXIT

HL_API=https://api.hyperliquid.xyz/info RPC_URL=$RPC ORACLE=$(jq -r .oracle $D) PRIVATE_KEY=$KEY MARKETS=107,334 \
  node keeper/feed-bbo.mjs --loop 1000 >logs/feeder.log 2>&1 &
PIDS+=($!)
sleep 4 # let the first price land before the hedger reads the pool

SIM=1 SIM_MID=$MID RPC_URL=$RPC POOL=$(jq -r .propAMM $D) QUOTER_KEY=$KEY \
  INTERVAL_MS=5000 node keeper/hedger.mjs >logs/hedger.log 2>&1 &
PIDS+=($!)

TOPUP_FROM=${TOPUP_FROM:-} RPC_URL=$RPC BRIDGE=$(jq -r .fastBridge $D) RELAYER_KEY=$KEY HL_MAIN_KEY=$KEY HL_TESTNET=1 \
  STATE_FILE=logs/relayer-state.json TICK_MS=2000 KICK_PORT=8790 node keeper/relayer.mjs >logs/relayer.log 2>&1 &
PIDS+=($!)
unset KEY

if [ -n "${SPONSOR_ACCOUNT:-}" ]; then
  echo "Unlocking sponsor keystore '$SPONSOR_ACCOUNT'"
  SKEY=$(cast wallet decrypt-keystore "$SPONSOR_ACCOUNT" | awk '{print $NF}')
  RPC_URL=$RPC DELEGATE=$(jq -r .neuriioAccount $D) SPONSOR_KEY=$SKEY RELAYER_KICK_URL=http://127.0.0.1:8790/kick node keeper/sponsor.mjs >logs/sponsor.log 2>&1 &
  PIDS+=($!)
  unset SKEY
fi

echo "bots running: feeder, hedger (simulated), relayer${SPONSOR_ACCOUNT:+, sponsor}  |  logs in ./logs  |  Ctrl-C to stop"
tail -n +1 -f logs/feeder.log logs/hedger.log logs/relayer.log ${SPONSOR_ACCOUNT:+logs/sponsor.log}
