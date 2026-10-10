// Phone layout switch: matches the CSS breakpoint (max-width: 860px) so JS-built mobile layouts and the
// stylesheet agree. Re-renders when the window crosses it.
import { useEffect, useState } from "react";

const PHONE = "(max-width: 860px)";

export function useIsMobile() {
  const [mobile, setMobile] = useState(() => matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = matchMedia(PHONE);
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}
