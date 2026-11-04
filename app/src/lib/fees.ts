// Creator fees on Ascend (user, 2026-11-04): the creator's share of Ascend's 1% fee builds up in each token's own CreatorEscrow
// on Ascend, paid to the creator (an FTF: to its seat, which splits it 4 ways). Below a $40k market cap most of it is held until
// the token qualifies (Ascend's docs, Creator fee release). Claiming happens on Ascend's escrow, not through us.
import { parseAbi, type Address } from "viem";
import { ASCEND } from "./config";
import { pub } from "./launch";
import { poolIdOf, poolKeyOf } from "./trade";

const factoryAbi = parseAbi(["function escrowOf(bytes32 poolId) view returns (address)"]);
const escrowAbi = parseAbi([
  "function recipient() view returns (address)",
  "function claimable(address account) view returns (uint256)",
  "function held() view returns (uint256)",
]);

/** A token's CreatorEscrow on Ascend. */
export async function escrowOf(token: Address): Promise<Address> {
  return pub.readContract({ address: ASCEND.escrowFactory, abi: factoryAbi, functionName: "escrowOf", args: [poolIdOf(poolKeyOf(token))] });
}

/** The creator fees a token has waiting (USDC base units): what its creator can claim now plus what's held until it qualifies.
 *  Not lifetime: claimed fees drop out (lifetime needs the escrow's Settled events, from the indexer). */
export async function tokenCreatorEarned(token: Address): Promise<bigint> {
  const escrow = await escrowOf(token);
  const recipient = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "recipient" });
  const [claimable, held] = await Promise.all([
    pub.readContract({ address: escrow, abi: escrowAbi, functionName: "claimable", args: [recipient] }),
    pub.readContract({ address: escrow, abi: escrowAbi, functionName: "held" }),
  ]);
  return claimable + held;
}
