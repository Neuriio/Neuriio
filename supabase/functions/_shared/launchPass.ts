// Pure launch-pass logic (no I/O): category mapping, profile validation + canonical form, EIP-712 types.
// Must match src/launch/Launchpad.sol (LaunchPass struct, Category enum, EIP712 domain).

import { keccak256, toBytes } from "npm:viem@2";

export const CATEGORIES = ["trader", "meme_trader", "researcher", "influencer", "builder", "creator"] as const;
export type Category = (typeof CATEGORIES)[number];

export const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

export const PASS_TTL_SECONDS = 15 * 60;

export const launchPassTypes = {
  LaunchPass: [
    { name: "creator", type: "address" },
    { name: "xUserId", type: "uint64" },
    { name: "handle", type: "string" },
    { name: "category", type: "uint8" },
    { name: "profileHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function launchpadDomain(chainId: number, launchpad: `0x${string}`) {
  return { name: "Neuriio Launchpad", version: "1", chainId, verifyingContract: launchpad } as const;
}

export type Link = { label: string; url: string };
export type ProfileInput = { about: string; links?: Link[] };

/**
 * Validates a creator profile and returns the exact string that gets hashed (key order fixed, trimmed).
 * A profile says who the creator is and links to their work. It is not an investment pitch: tokens are memes.
 */
export function canonicalProfile(
  input: ProfileInput,
  who: { xUserId: string; handle: string; category: Category },
): { content: string; hash: `0x${string}` } {
  const about = typeof input?.about === "string" ? input.about.trim() : "";
  if (about.length < 50) throw new Error("About must be at least 50 characters");
  if (about.length > 5000) throw new Error("About must be at most 5,000 characters");
  const rawLinks = input.links ?? [];
  if (!Array.isArray(rawLinks)) throw new Error("Links must be a list");
  if (rawLinks.length > 10) throw new Error("At most 10 links"); // checked before doing any work per link
  const links = rawLinks.map((p) => {
    const label = typeof p?.label === "string" ? p.label.trim() : "";
    const url = typeof p?.url === "string" ? p.url.trim() : "";
    if (!label || label.length > 80) throw new Error("Each link needs a label (max 80 characters)");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`Invalid link: ${url}`);
    }
    if (u.protocol !== "https:" || url.length > 500) throw new Error(`Links must be https (max 500 chars): ${url}`);
    return { label, url: u.toString() };
  });
  const content = JSON.stringify({
    v: 1,
    xUserId: who.xUserId,
    handle: who.handle,
    category: who.category,
    about,
    links,
  });
  return { content, hash: keccak256(toBytes(content)) };
}
