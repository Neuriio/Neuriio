import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { PrivyCheck } from "./PrivyCheck.jsx";
import { App } from "./App";
import { elysiumTestnet } from "./chain";

const appId = import.meta.env.VITE_PRIVY_APP_ID;

createRoot(document.getElementById("root")!).render(
  appId ? (
    <PrivyProvider
      appId={appId}
      config={{
        // X only ("Tokenize Yourself": your X account is your identity + your one token); we create the
        // Neuriio wallet for everyone, no wallet needed to sign in
        loginMethods: ["twitter"],
        // Privy's login / export pop-ups in our colors (lavender accent keeps white button text readable)
        appearance: {
          theme: "#120c1d",
          accentColor: "#7f72a0",
          logo: `${location.origin}/brand/logo.png`,
          landingHeader: "Log in to Neuriio",
          loginMessage: "Log in with X. We create your Neuriio wallet for you.",
        },
        embeddedWallets: { ethereum: { createOnLogin: "all-users" }, showWalletUIs: false },
        defaultChain: elysiumTestnet,
        supportedChains: [elysiumTestnet],
      }}
    >
      {/* ?check keeps the testnet check page reachable while the real app is built */}
      {new URLSearchParams(location.search).has("check") ? <PrivyCheck /> : <App />}
    </PrivyProvider>
  ) : (
    <p style={{ fontFamily: "system-ui", padding: 24 }}>Set VITE_PRIVY_APP_ID in app/.env.local, then restart.</p>
  ),
);
