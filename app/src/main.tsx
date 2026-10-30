import React from "react";
import { createRoot } from "react-dom/client";

// Site-wide pause: every page shows this and the app never loads, so visitors make no RPC, Privy or Supabase calls.
// Set to false to bring the app back.
const PAUSED = true;

if (PAUSED) {
  document.body.style.margin = "0";
  document.body.style.background = "#120c1d";
  createRoot(document.getElementById("root")!).render(
    <main
      style={{
        minHeight: "100dvh",
        boxSizing: "border-box",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "clamp(16px, 4vmin, 28px)",
        textAlign: "center",
        color: "#fff",
        fontFamily: "Manrope, system-ui, sans-serif",
      }}
    >
      <img src="/brand/logo.png" alt="Neuriio" style={{ width: "clamp(56px, 12vmin, 96px)", height: "auto" }} />
      <div>
        <h1 style={{ margin: 0, fontSize: "clamp(24px, 6vmin, 44px)", fontWeight: 600 }}>Under construction</h1>
        <p style={{ margin: "10px 0 0", fontSize: "clamp(14px, 2.6vmin, 18px)", color: "#b9aecb" }}>
          We're building a new integration. Back soon.
        </p>
      </div>
    </main>,
  );
} else {
  void import("./live");
}
