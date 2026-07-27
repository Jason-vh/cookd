import { defineConfig } from "vite";

/**
 * `bun run dev` serves the client on 5273 and forwards the game socket to the
 * server on 5274, so online play works in development exactly as it does in
 * production — where one Bun process serves both.
 */
export default defineConfig({
  server: {
    port: 5273,
    proxy: {
      "/ws": { target: "ws://localhost:5274", ws: true, rewriteWsOrigin: true },
      "/health": { target: "http://localhost:5274" },
    },
  },
  build: { target: "es2022" },
});
