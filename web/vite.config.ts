import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Frontend is served by the Node server on a single port (5555).
// Vite is only used for production builds (`npm run build`).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Optional local UI-only dev; API still expected on 5555.
    host: "0.0.0.0",
    port: 5556,
    strictPort: true,
    proxy: {
      "/admin/api": "http://127.0.0.1:5555",
      "/user/api": "http://127.0.0.1:5555",
      "/v1": "http://127.0.0.1:5555",
      "/coding": "http://127.0.0.1:5555",
      "/branding": "http://127.0.0.1:5555",
      "/health": "http://127.0.0.1:5555",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
