// Staking (src/stake/NeuriioTokenStaking.sol), from the Explore stake card: any token launched through Neuriio, from launch.
// Its stakers share 40% of our 0.5% fee on that token's trades, in USDC, paid in by the fee router; rewards drip in over an
// hour. Staking approves the staking contract once (unlimited, sent silently). Neuriio is a tally (lib/neuriio.ts), not here.
import { erc20Abi, maxUint256, parseAbi, type Address, type EIP1193Provider } from "viem";
import { STAKING as STAKING_ADDRESS } from "./config";
import { pub } from "./launch";
import { confirmed, nonceAfter, walletClientFor } from "./tx";

export const STAKING = STAKING_ADDRESS;

const stakingAbi = parseAbi([
  "function stake(address token, uint256 amount)",
  "function unstake(address token, uint256 amount)",
  "function claim(address[] tokens, address to) returns (uint256 usdc)",
  "function stakedOf(address user, address token) view returns (uint256)",
  "function totalStaked(address token) view returns (uint256)",
  "function earned(address user, address token) view returns (uint256)",
  "function isStakeable(address token) view returns (bool)",
]);

/** One pool, for one wallet: what's in the wallet, staked, and earned so far (USDC base units). */
export type StakePosition = {
  open: boolean; // stakeable (launched through Neuriio)
  wallet: bigint; // the token in the wallet
  staked: bigint;
  totalStaked: bigint;
  usdc: bigint;
  gas: bigint; // HYPE for gas
};

export async function stakePosition(user: Address, token: Address): Promise<StakePosition> {
  const s = { address: STAKING, abi: stakingAbi } as const;
  const [open, wallet, staked, totalStaked, usdc, gas] = await Promise.all([
    pub.readContract({ ...s, functionName: "isStakeable", args: [token] }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
    pub.readContract({ ...s, functionName: "stakedOf", args: [user, token] }),
    pub.readContract({ ...s, functionName: "totalStaked", args: [token] }),
    pub.readContract({ ...s, functionName: "earned", args: [user, token] }),
    pub.getBalance({ address: user }),
  ]);
  return { open, wallet, staked, totalStaked, usdc, gas };
}

/** Stakes `amount` of `token` (approving the staking contract first if it still needs it). */
export async function stake(provider: EIP1193Provider, account: Address, token: Address, amount: bigint, onApproving?: () => void) {
  const w = walletClientFor(provider, account);
  let nonce: number | undefined;
  const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, STAKING] });
  if (allowance < amount) {
    onApproving?.();
    const hash = await w.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [STAKING, maxUint256] });
    await confirmed(hash);
    nonce = await nonceAfter(hash);
  }
  await confirmed(await w.writeContract({ address: STAKING, abi: stakingAbi, functionName: "stake", args: [token, amount], nonce }));
}

export async function unstake(provider: EIP1193Provider, account: Address, token: Address, amount: bigint) {
  await confirmed(await walletClientFor(provider, account).writeContract({ address: STAKING, abi: stakingAbi, functionName: "unstake", args: [token, amount] }));
}

/** Claims `tokens`' pools: USDC to the wallet. */
export async function claimStaking(provider: EIP1193Provider, account: Address, tokens: Address[]) {
  await confirmed(await walletClientFor(provider, account).writeContract({ address: STAKING, abi: stakingAbi, functionName: "claim", args: [tokens, account] }));
}

/** Readable errors for staking. */
export function friendlyStakeError(message: string) {
  if (/NotStakeable/i.test(message)) return "Only tokens launched through Neuriio can be staked.";
  if (/NothingToClaim/i.test(message)) return "Nothing to claim yet.";
  if (/InsufficientStake/i.test(message)) return "That's more than you have staked.";
  if (/insufficient funds/i.test(message)) return "Not enough HYPE for gas.";
  if (/exceeds balance|InsufficientBalance/i.test(message)) return "Not enough balance.";
  if (/rejected|denied/i.test(message)) return "Cancelled.";
  return message.split("\n")[0].slice(0, 140);
}
