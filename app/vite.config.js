import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// keeper/src is browser-safe: the app imports the one-click + trade hub code straight from it.
export default defineConfig({
  plugins: [react()],
  // one copy of React (and viem/HL SDK) no matter who imports it
  resolve: { dedupe: ["react", "react-dom", "viem", "@nktkas/hyperliquid"] },
  // pre-bundle these up front so Vite never re-optimizes mid-session (that split React into two
  // copies and blanked the page on 2026-09-26)
  optimizeDeps: {
    include: ["react", "react-dom", "react-dom/client", "motion/react", "react-use-measure", "lucide-react", "@privy-io/react-auth"],
  },
  server: { port: 5173, strictPort: true, fs: { allow: [".."] } },
});
