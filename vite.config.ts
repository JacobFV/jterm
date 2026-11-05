import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Tauri prints its own build output over the top of Vite's otherwise.
  clearScreen: false,
  // ES2022 rather than Vite's ES2020 default, for one feature: top-level
  // `await`, which noVNC uses to probe for H.264 decoding as it loads and
  // which cannot be compiled away. Safari 15 is the oldest WebKit with it, and
  // the oldest macOS jterm supports (10.15) can run Safari 15 — the webview is
  // the system's WebKit, so a Mac whose Safari is current has it.
  build: { target: ["es2022", "safari15", "chrome89", "firefox89", "edge89"] },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
