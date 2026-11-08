// A creator's X profile picture (saved at launch / login), or their initial if there's none or it fails to load
// (an old X picture URL dies when they change it, until `register` refreshes it).
// Landing page: every token shows the Neuriio mark on a colour gradient (neighbouring Top 25 rows differ). `tone` forces
// the mark on that gradient anywhere (the feed's sample posters).
import { useState } from "react";
import { LANDING, landingTone } from "../lib/explore";

/** IPFS pictures (gateway.pinata.cloud, slow) go through our own CDN-cached /art/<cid> on the live site (api/art.ts). */
const fastPicture = (url: string) => {
  if (import.meta.env.DEV) return url; // dev has no /api routes
  const m = url.match(/^https:\/\/gateway\.pinata\.cloud\/ipfs\/([A-Za-z0-9]+)$/);
  return m ? `/art/${m[1]}` : url;
};

export function Avatar({
  handle,
  pfp,
  size,
  className = "",
  tone,
}: {
  handle: string;
  pfp: string | null;
  size: number;
  className?: string;
  tone?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (LANDING || tone)
    return <span className={`ex-avatar ex-avatar-mark tone-${tone ?? landingTone(handle)} ${className}`.trim()} style={{ width: size, height: size }} />;
  return (
    <span className={`ex-avatar ${className}`.trim()} style={{ width: size, height: size }}>
      {pfp && !broken ? (
        <img src={fastPicture(pfp)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        <span>{handle[0]?.toUpperCase()}</span>
      )}
    </span>
  );
}
