import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// keeper/src is browser-safe: the app imports the one-click + trade hub code straight from it.
export default defineConfig(({ mode }) => ({
  // `npm run dev:phone`: HTTPS on the Wi-Fi address so a phone can open it (Privy refuses plain http)
  plugins: mode === "phone" ? [react(), basicSsl()] : [react()],
  // one copy of React (and viem/HL SDK) no matter who imports it
  resolve: { dedupe: ["react", "react-dom", "viem", "@nktkas/hyperliquid"] },
  // pre-bundle these up front so Vite never re-optimizes mid-session (that split React into two
  // copies and blanked the page on 2026-09-26)
  optimizeDeps: {
    include: ["react", "react-dom", "react-dom/client", "motion/react", "react-use-measure", "lucide-react", "@privy-io/react-auth"],
  },
  // 127.0.0.1 explicitly: plain "localhost" bound only IPv6 (::1) on this Mac, so browsers trying IPv4 got nothing
  server: { host: "127.0.0.1", port: 5173, strictPort: true, fs: { allow: [".."] } },
}));
