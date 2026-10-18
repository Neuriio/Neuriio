#!/usr/bin/env bash
# Verifies every contract of the current world on Elysium's Blockscout (the testnet explorer), so anyone can read the
# source (fine to run after a partial redeploy: unchanged contracts just report "already verified"). Contracts the
# deploy scripts created take their constructor args from their creation tx
# (--guess-constructor-args); contracts other contracts created ($NEURIIO by NeuriioStaking, each pool by the factory,
# each launched token by its NeuriioPad) get theirs from the chain. Blockscout matches identical pools from the first one
# verified. No key needed; safe to re-run (already-verified contracts just report so).
#   ./script/verify-world.sh
set -uo pipefail
cd "$(dirname "$0")/.."
D=${DEPLOYMENTS:-deployments/elysium-testnet.json}
RPC=${RPC:-https://testnet-rpc.elysium.kinetiq.xyz}
V=(--chain 99801 --verifier blockscout --verifier-url https://elysium.kinetiq.xyz/api/ --watch)
FAILED=0
j() { jq -r "$1" $D; }
call() { cast call "$@" --rpc-url $RPC | awk '{print $1}'; }
verify() { # address path:Contract profile [guess | constructor-args hex]
  echo "== $2 at $1"
  local extra=() out
  if [ "${4:-}" = "guess" ]; then extra=(--guess-constructor-args --rpc-url "$RPC")
  elif [ -n "${4:-}" ]; then extra=(--constructor-args "$4"); fi
  # a contract deployed by a script that also builds a NeuriioPad was compiled with the pad's "size" profile: try both
  local profiles=("$3"); [ "$3" = "default" ] && profiles=(default size)
  for prof in "${profiles[@]}"; do
    out=$(forge verify-contract "$1" "$2" "${V[@]}" --compilation-profile "$prof" ${extra[@]+"${extra[@]}"} 2>&1)
    if echo "$out" | grep -qE "Pass - Verified|already verified"; then echo "  verified ($prof)"; return 0; fi
  done
  echo "$out" | tail -3 >&2
  echo "!! $2 failed" >&2; FAILED=1
}

REG=$(j .launchRegistry); FACTORY=$(j .swapFactory); USDC=$(j .usdc)
OWNER=$(call $REG "owner()(address)")
verify $USDC src/testnet/TestUSDC.sol:TestUSDC default guess
verify $REG src/launch/NeuriioRegistry.sol:NeuriioRegistry default guess
verify $FACTORY src/swap/v2/UniswapV2Factory.sol:UniswapV2Factory default guess
ST=$(j .staking); M=$(j .minter); NEU=$(j .neuriio)
verify $ST src/stake/NeuriioStaking.sol:NeuriioStaking default "$(cast abi-encode "f(address,address,address)" $FACTORY $USDC $(call $NEU "owner()(address)"))"
verify $NEU src/stake/NeuriioPlatformToken.sol:NeuriioPlatformToken default "$(cast abi-encode "f(address)" $(call $NEU "owner()(address)"))"
verify $M src/stake/NeuriioMinter.sol:NeuriioMinter default "$(cast abi-encode "f(address,address,uint256,uint256,uint256)" \
  $(call $M "owner()(address)") $ST $(call $M "mintRate()(uint256)") $(call $M "flatUntil()(uint256)") $(call $M "decayScale()(uint256)"))"
verify $(j .feeVault) src/launch/NeuriioFees.sol:NeuriioFees default "$(cast abi-encode "f(address,address,address,address,address,address)" \
  $(call $(j .feeVault) "owner()(address)") $USDC $FACTORY $REG $ST $M)"
verify $(j .router) src/swap/NeuriioRouter.sol:NeuriioRouter default "$(cast abi-encode "f(address,address)" $REG $FACTORY)"
for pad in $(j '.launchpads[].address'); do verify $pad src/launch/NeuriioPad.sol:NeuriioPad size guess; done

# every launched token, and the first pool
PAIR_DONE=""
N=$(call $REG "allTokensLength()(uint256)")
for ((i = 0; i < N; i++)); do
  T=$(call $REG "allTokens(uint256)(address)" $i)
  NAME=$(cast call $T "name()(string)" --rpc-url $RPC); SYM=$(cast call $T "symbol()(string)" --rpc-url $RPC)
  verify $T src/launch/NeuriioToken.sol:NeuriioToken size \
    "$(cast abi-encode "f(string,string,uint256)" "${NAME//\"/}" "${SYM//\"/}" 1000000000000000000000000000)"
  P=$(call $FACTORY "getPair(address,address)(address)" $T $USDC)
  if [ -z "$PAIR_DONE" ] && [ "$P" != "0x0000000000000000000000000000000000000000" ]; then
    verify $P src/swap/v2/UniswapV2Pair.sol:UniswapV2Pair default
    PAIR_DONE=1
  fi
done
[ $FAILED = 0 ] && echo "== ALL VERIFIED" || { echo "== SOME VERIFICATIONS FAILED" >&2; exit 1; }
