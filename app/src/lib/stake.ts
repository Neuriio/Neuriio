// Staking (src/stake/NeuriioStaking.sol), from the Explore stake card: X tokens (once graduated), whose stakers share 40%
// of that token's pool fees in USDC. Rewards drip in over an hour. Staking approves the staking contract once (unlimited,
// sent silently like the router's). Neuriio is a points ledger now, not a token (lib/points.ts), so nothing here reads it.
import { erc20Abi, maxUint256, parseAbi, type Address, type EIP1193Provider } from "viem";
import { deployment } from "./config";
import { pub } from "./launch";
import { confirmed, nonceAfter, walletClientFor } from "./tx";

export const STAKING = deployment.staking as Address;

const stakingAbi = parseAbi([
  "function stake(address token, uint256 amount)",
  "function unstake(address token, uint256 amount)",
  "function claim(address[] tokens, address to) returns (uint256 usdc, uint256 neuriio)",
  "function stakedOf(address user, address token) view returns (uint256)",
  "function totalStaked(address token) view returns (uint256)",
  "function earned(address user, address token) view returns (uint256 usdc, uint256 neuriio)",
  "function isStakeable(address token) view returns (bool)",
]);

/** One pool, for one wallet: what's in the wallet, staked, and earned so far (USDC base units). */
export type StakePosition = {
  open: boolean; // stakeable (an X token: graduated)
  wallet: bigint; // the token in the wallet
  staked: bigint;
  totalStaked: bigint;
  usdc: bigint;
  gas: bigint; // HYPE for gas
};

export async function stakePosition(user: Address, token: Address): Promise<StakePosition> {
  const s = { address: STAKING, abi: stakingAbi } as const;
  const [open, wallet, staked, totalStaked, [usdc], gas] = await Promise.all([
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
  if (/NotStakeable/i.test(message)) return "Staking opens after graduation.";
  if (/NothingToClaim/i.test(message)) return "Nothing to claim yet.";
  if (/InsufficientStake/i.test(message)) return "That's more than you have staked.";
  if (/insufficient funds/i.test(message)) return "Not enough HYPE for gas.";
  if (/exceeds balance|InsufficientBalance/i.test(message)) return "Not enough balance.";
  if (/rejected|denied/i.test(message)) return "Cancelled.";
  return message.split("\n")[0].slice(0, 140);
}
