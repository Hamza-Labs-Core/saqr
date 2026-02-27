import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@saqr/terminal-ui": path.resolve(__dirname, "../../terminal-ui/src/index.ts"),
      "@saqr/cli/types/timeline": path.resolve(__dirname, "../../cli/src/types/timeline.ts"),
      "@saqr/cli/theme": path.resolve(__dirname, "../../cli/src/theme/index.ts"),
      "@saqr/shared": path.resolve(__dirname, "../../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
