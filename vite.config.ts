import { defineConfig } from "vite";

// Local same-origin stack: `npm run dev` / `npm run preview` forward /api and /ws to a local room server, the way Nginx does
// in production (docs/online-server.md). Without a running server those paths simply fail; the static game is unaffected.
const backend = process.env.SLOTRUSH_BACKEND ?? "http://127.0.0.1:8787";
const proxy = {
  "/api": { target: backend, changeOrigin: false },
  "/ws": { target: backend.replace(/^http/, "ws"), ws: true, changeOrigin: false },
};

export default defineConfig({ base: "./", build: { target: "es2022", sourcemap: false }, server: { proxy }, preview: { proxy } });
