import type { User } from "@privy-io/react-auth";

export type Profile = { name: string; avatar: string | null; initial: string };

/** Display name + picture from whichever social account the user logged in with. */
export function profileOf(user: User | null): Profile {
  // top-level fields first, then the linked accounts list (same data, present in every Privy version)
  const linked = user?.linkedAccounts ?? [];
  const x = user?.twitter ?? linked.find((a) => a.type === "twitter_oauth");
  const tg = user?.telegram ?? linked.find((a) => a.type === "telegram");
  const g = user?.google ?? linked.find((a) => a.type === "google_oauth");
  if (import.meta.env.DEV && user) {
    console.info("[neuriio] login accounts:", linked.map((a) => a.type).join(", "), "| x:", x?.username ?? "none");
  }
  const name =
    (x?.username && `@${x.username}`) ||
    (tg?.username && `@${tg.username}`) ||
    tg?.firstName ||
    g?.name ||
    g?.email?.split("@")[0] ||
    "Account";
  // X gives a small "_normal" (48px) picture; ask for the 200px one
  const avatar = x?.profilePictureUrl?.replace("_normal.", "_200x200.") ?? tg?.photoUrl ?? null; // Google: none
  return { name, avatar, initial: name.replace("@", "").charAt(0).toUpperCase() || "?" };
}
