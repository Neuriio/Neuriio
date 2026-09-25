import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// keeper/src is browser-safe: the app imports the one-click + trade hub code straight from it.
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["viem", "@nktkas/hyperliquid"] },
  server: { port: 5173, strictPort: true, fs: { allow: [".."] } },
});
