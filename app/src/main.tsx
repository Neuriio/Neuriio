import React from "react";
import { createRoot } from "react-dom/client";
import { Paused } from "./Paused";

// Site-wide pause: every page shows this and the app never loads, so visitors make no RPC, Privy or Supabase calls.
// Set to false to bring the app back.
const PAUSED = true;

if (PAUSED) {
  document.body.style.margin = "0";
  document.body.style.background = "#120c1d";
  createRoot(document.getElementById("root")!).render(<Paused />);
} else {
  void import("./live");
}
