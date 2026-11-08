import React from "react";
import { createRoot } from "react-dom/client";
import { Paused } from "./Paused";

// Site-wide pause: every page shows this and the app never loads, so visitors make no RPC, Privy or Supabase calls.
// Local dev always loads the app. Set to false to bring the app back in production.
// Except /safe (user, 2026-11-05): the Safe owners' approval page stays reachable on their own devices while the site is closed.
// And /art (user, 2026-11-08): creators set their coin's art on Ascend, whose security check only works on app.neuriio.xyz.
const OPEN_PAGES = ["/safe", "/art"];
const SAFE_PAGE = OPEN_PAGES.includes(location.pathname.replace(/\/+$/, ""));
// Unpaused 2026-11-08 (user: "remove the pause screen"). Set back to `!import.meta.env.DEV && !SAFE_PAGE` to pause again.
const PAUSED = false && !import.meta.env.DEV && !SAFE_PAGE;

if (PAUSED) {
  document.body.style.margin = "0";
  document.body.style.background = "#120c1d";
  createRoot(document.getElementById("root")!).render(<Paused />);
} else {
  void import("./live");
}
