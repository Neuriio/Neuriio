// Staking (src/stake/NeuriioStaking.sol), from the Explore stake card and the Account panel.
//   X tokens (once graduated): stakers share 40% of that token's pool fees in USDC, and every $1 they earn mints
//   Neuriio (100 at first), which claiming stakes for them.
//   Neuriio: stakers share 80% of every curve fee and 40% of every pool fee, in USDC.
// Rewards drip in over an hour. Staking an X token approves the staking contract once (unlimited, sent silently like
// the router's); Neuriio needs no approval (the staking contract may always move it) and can't be sent anywhere else.
import { erc20Abi, maxUint256, parseAbi, type Address, type EIP1193Provider } from "viem";
import { deployment } from "./config";
import { pub } from "./launch";
import { confirmed, walletClientFor } from "./tx";

export const STAKING = deployment.staking as Address;
export const NEURIIO = deployment.neuriio as Address;

const stakingAbi = parseAbi([
  "function stake(address token, uint256 amount)",
  "function unstake(address token, uint256 amount)",
  "function claim(address[] tokens, address to) returns (uint256 usdc, uint256 neuriio)",
  "function stakedOf(address user, address token) view returns (uint256)",
  "function totalStaked(address token) view returns (uint256)",
  "function earned(address user, address token) view returns (uint256 usdc, uint256 neuriio)",
  "function isStakeable(address token) view returns (bool)",
]);

/** One pool, for one wallet: what's in the wallet, staked, and earned so far (USDC base units, Neuriio wei). */
export type StakePosition = {
  open: boolean; // stakeable (an X token: graduated)
  wallet: bigint; // the token in the wallet
  staked: bigint;
  totalStaked: bigint;
  usdc: bigint;
  neuriio: bigint;
  gas: bigint; // HYPE for gas
};

export async function stakePosition(user: Address, token: Address): Promise<StakePosition> {
  const s = { address: STAKING, abi: stakingAbi } as const;
  const [open, wallet, staked, totalStaked, [usdc, neuriio], gas] = await Promise.all([
    pub.readContract({ ...s, functionName: "isStakeable", args: [token] }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [user] }),
    pub.readContract({ ...s, functionName: "stakedOf", args: [user, token] }),
    pub.readContract({ ...s, functionName: "totalStaked", args: [token] }),
    pub.readContract({ ...s, functionName: "earned", args: [user, token] }),
    pub.getBalance({ address: user }),
  ]);
  return { open, wallet, staked, totalStaked, usdc, neuriio, gas };
}

/** Stakes `amount` of `token` (approving the staking contract first if an X token still needs it). */
export async function stake(provider: EIP1193Provider, account: Address, token: Address, amount: bigint, onApproving?: () => void) {
  const w = walletClientFor(provider, account);
  if (token.toLowerCase() !== NEURIIO.toLowerCase()) {
    const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, STAKING] });
    if (allowance < amount) {
      onApproving?.();
      await confirmed(await w.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [STAKING, maxUint256] }));
    }
  }
  await confirmed(await w.writeContract({ address: STAKING, abi: stakingAbi, functionName: "stake", args: [token, amount] }));
}

export async function unstake(provider: EIP1193Provider, account: Address, token: Address, amount: bigint) {
  await confirmed(await walletClientFor(provider, account).writeContract({ address: STAKING, abi: stakingAbi, functionName: "unstake", args: [token, amount] }));
}

/** Claims `tokens`' pools: USDC to the wallet, Neuriio staked for it. */
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
