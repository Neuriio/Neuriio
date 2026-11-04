#!/usr/bin/env bash
# Mainnet deploy rehearsal for the Ascend version, on a LOCAL fork of Elysium testnet (nothing is sent to a real chain):
#   1. a 2-of-3 Safe from Safe's canonical contracts (script/CreateSafe.s.sol)
#   2. stand-ins for USDC and Ascend (test/mocks/MockAscend.sol)
#   3. the real deploy: script/DeployAscend.s.sol (timelock, NeuriioLauncher, NeuriioTokenStaking), with its own checks
#   4. the adapter plugged in the mainnet way: the Safe schedules launcher.setAdapter on the timelock, the delay passes, the
#      Safe executes it (script/SafeTx.s.sol, owners approving on-chain)
#   5. a launch with a signed pass + first buy, staking, trades paying 1.5% with our 0.5% waiting in the token's escrow
#   6. the real fee router collecting it (settle + claimBuilder) and paying 40% to the stakers, 60% to the treasury
#   7. the stakers claiming after the 1-hour drip, and the identity gate refusing a second launch and a forged pass
# Keys are anvil's public test keys. Run: ./script/rehearse-ascend.sh   (needs anvil/forge/cast; FORK_URL to override)
set -euo pipefail
cd "$(dirname "$0")/.."

FORK_URL=${FORK_URL:-https://testnet-rpc.elysium.kinetiq.xyz}
PORT=${PORT:-8546}
RPC=http://127.0.0.1:$PORT
LOG=$(mktemp -d)

K=(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
  0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
  0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e 0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356
  0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6)
addr() { cast wallet address "$1"; }
DEPLOYER=${K[0]}
export LAUNCH_SIGNER SIGNER_PK=${K[4]} CREATOR_PK=${K[5]} STAKER_PK=${K[6]} TRADER_PK=${K[7]} FEE_WALLET_PK=${K[8]}
LAUNCH_SIGNER=$(addr "$SIGNER_PK")
export FEE_WALLET ASCEND_WALLET
FEE_WALLET=$(addr "$FEE_WALLET_PK")
ASCEND_WALLET=$(addr "${K[9]}")

step() { printf '\n== %s\n' "$*"; }
# forge script <file> [sig] -> its logs; stops the rehearsal on any failure
run() {
  local out
  if ! out=$(forge script "$@" --rpc-url "$RPC" --broadcast --slow 2>&1); then
    echo "$out" | tail -25
    exit 1
  fi
  echo "$out" | sed -n '/== Logs ==/,/^$/p' | sed '1d' | tee -a "$LOG/logs"
}
val() { grep -m1 -E "^[[:space:]]*$1" "$LOG/logs" | awk '{print $NF}'; }

step "local fork of Elysium testnet on port $PORT"
anvil --fork-url "$FORK_URL" --port "$PORT" --silent &
ANVIL=$!
trap '[ -n "${KEEP:-}" ] || kill $ANVIL 2>/dev/null; rm -rf "$LOG"' EXIT # KEEP=1 leaves the fork running to look into
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
echo "chain id $(cast chain-id --rpc-url "$RPC"), block $(cast block-number --rpc-url "$RPC")"

step "1. Safe, 2 of 3"
OWNERS=$(addr "${K[1]}"),$(addr "${K[2]}"),$(addr "${K[3]}") SALT_NONCE=$RANDOM run script/CreateSafe.s.sol --private-key "$DEPLOYER"
export SAFE
SAFE=$(val "Safe:")

step "2. stand-in USDC and Ascend"
run script/RehearseAscend.s.sol --sig "mocks()" --private-key "$DEPLOYER"
export USDC ASCEND
USDC=$(val "USDC:")
ASCEND=$(val "ASCEND:")

step "3. the real deploy (DeployAscend.s.sol), timelock delay 5 minutes"
ALLOW_TESTNET=true TIMELOCK_DELAY=300 run script/DeployAscend.s.sol --private-key "$DEPLOYER"
export TIMELOCK LAUNCHER STAKING
TIMELOCK=$(val "TimelockController:")
LAUNCHER=$(val "NeuriioLauncher:")
STAKING=$(val "NeuriioTokenStaking:")
echo "deploy checks passed (owner = timelock, Safe = guardian, no adapter yet, staking has no owner)"

step "4. adapter, plugged in through Safe -> timelock"
run script/RehearseAscend.s.sol --sig "adapter()" --private-key "$DEPLOYER"
export ADAPTER
ADAPTER=$(val "ADAPTER:")
safe_call() { # $1 = calldata for the timelock: two owners approve, anyone executes
  local h
  h=$(SAFE=$SAFE TO=$TIMELOCK DATA=$1 forge script script/SafeTx.s.sol --sig "hash()" --rpc-url "$RPC" 2>&1 | grep -A1 "hash:" | tail -1 | awk '{print $1}')
  for pk in "${K[1]}" "${K[2]}"; do cast send "$SAFE" "approveHash(bytes32)" "$h" --private-key "$pk" --rpc-url "$RPC" >/dev/null; done
  SAFE=$SAFE TO=$TIMELOCK DATA=$1 run script/SafeTx.s.sol --sig "exec()" --private-key "$DEPLOYER"
}
data() { forge script script/RehearseAscend.s.sol --sig "$1" --rpc-url "$RPC" 2>&1 | sed -n '/== Logs ==/{n;p;}' | awk '{print $1}'; }
safe_call "$(data "scheduleData()")"
echo "scheduled; adapter before the delay: $(cast call "$LAUNCHER" "adapter()(address)" --rpc-url "$RPC")"
cast rpc evm_increaseTime 301 --rpc-url "$RPC" >/dev/null && cast rpc evm_mine --rpc-url "$RPC" >/dev/null
safe_call "$(data "executeData()")"
GOT=$(cast call "$LAUNCHER" "adapter()(address)" --rpc-url "$RPC")
[ "$(echo "$GOT" | tr A-F a-f)" = "$(echo "$ADAPTER" | tr A-F a-f)" ] || { echo "adapter not set: $GOT"; exit 1; }
echo "adapter set after the delay: $GOT"

step "5. launch, stake, trade, fees"
FROM_BLOCK=$(cast block-number --rpc-url "$RPC")
run script/RehearseAscend.s.sol --sig "trade()" --private-key "$DEPLOYER"
export TOKEN FEES
TOKEN=$(val "TOKEN:")
FEES=$(val "builder fee waiting")

step "6. the real fee router: collect each token's builder fee from its escrow, pay 40% to its stakers, the rest to the treasury"
TREASURY=$(addr "${K[3]}")
TREASURY_BEFORE=$(cast call "$USDC" "balanceOf(address)(uint256)" "$TREASURY" --rpc-url "$RPC" | awk '{print $1}')
(cd keeper && RPC=$RPC KEY=$FEE_WALLET_PK USDC=$USDC STAKING=$STAKING LAUNCHER=$LAUNCHER ASCEND=$ASCEND TREASURY=$TREASURY \
  FROM_BLOCK=$FROM_BLOCK node rehearse-router.mjs)
TREASURY_GOT=$(( $(cast call "$USDC" "balanceOf(address)(uint256)" "$TREASURY" --rpc-url "$RPC" | awk '{print $1}') - TREASURY_BEFORE ))
LEFT=$(cast call "$USDC" "balanceOf(address)(uint256)" "$FEE_WALLET" --rpc-url "$RPC" | awk '{print $1}')
echo "treasury got $TREASURY_GOT of $FEES (60% = $(( FEES * 60 / 100 ))); left in the fee wallet: $LEFT"
[ "$LEFT" = 0 ] && [ $(( TREASURY_GOT - FEES * 60 / 100 )) -ge -1 ] && [ $(( TREASURY_GOT - FEES * 60 / 100 )) -le 1 ] || { echo "payout split is off"; exit 1; }

step "7. after the 1-hour drip: claim, and the identity gate"
cast rpc evm_increaseTime 3601 --rpc-url "$RPC" >/dev/null && cast rpc evm_mine --rpc-url "$RPC" >/dev/null
run script/RehearseAscend.s.sol --sig "claim()" --private-key "$DEPLOYER"
forge script script/RehearseAscend.s.sol --sig "gate()" --rpc-url "$RPC" 2>&1 | sed -n '/== Logs ==/,/^$/p' | sed '1d'

step "REHEARSAL PASSED"
echo "Safe $SAFE | timelock $TIMELOCK | launcher $LAUNCHER | staking $STAKING | adapter $ADAPTER | token $TOKEN"
