import { defineConfig } from "vite";

export default defineConfig({
  root: "frontend",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
