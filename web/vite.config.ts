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
    target: "es2022",
    cssCodeSplit: true,
    sourcemap: false,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("react-router")) {
            return "react-vendor";
          }
          if (id.includes("@tanstack") || id.includes("zustand") || id.includes("sonner") || id.includes("next-themes")) {
            return "app-vendor";
          }
          if (id.includes("lucide-react") || id.includes("@radix-ui")) {
            return "ui-vendor";
          }
        },
      },
    },
  },
});
