// A creator's X profile picture (saved at launch / login), or their initial if there's none or it fails to load
// (an old X picture URL dies when they change it, until `register` refreshes it).
// Landing page: every token shows the Neuriio mark on a colour gradient (neighbouring Top 25 rows differ).
import { useState } from "react";
import { LANDING, landingTone } from "../lib/explore";

export function Avatar({ handle, pfp, size, className = "" }: { handle: string; pfp: string | null; size: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (LANDING)
    return <span className={`ex-avatar ex-avatar-mark tone-${landingTone(handle)} ${className}`.trim()} style={{ width: size, height: size }} />;
  return (
    <span className={`ex-avatar ${className}`.trim()} style={{ width: size, height: size }}>
      {pfp && !broken ? (
        <img src={pfp} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        <span>{handle[0]?.toUpperCase()}</span>
      )}
    </span>
  );
}
