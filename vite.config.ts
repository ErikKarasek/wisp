import { defineConfig } from "vite";

// Tauri serves the built files itself; in dev it opens this port.
export default defineConfig({
  clearScreen: false,
  server: { port: 1430, strictPort: true, host: "127.0.0.1" },
  build: { target: "safari16", outDir: "dist" },
});
