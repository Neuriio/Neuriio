import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { PrivyCheck } from "./PrivyCheck.jsx";
import { elysiumTestnet } from "./chain.js";

const appId = import.meta.env.VITE_PRIVY_APP_ID;

createRoot(document.getElementById("root")).render(
  appId ? (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["twitter", "wallet"],
        // every user gets a Neuriio wallet, including those who sign in with Rabby / Coinbase Wallet
        embeddedWallets: { ethereum: { createOnLogin: "all-users" }, showWalletUIs: false },
        defaultChain: elysiumTestnet,
        supportedChains: [elysiumTestnet],
      }}
    >
      <PrivyCheck />
    </PrivyProvider>
  ) : (
    <p style={{ fontFamily: "system-ui", padding: 24 }}>Set VITE_PRIVY_APP_ID in app/.env.local, then restart.</p>
  ),
);
