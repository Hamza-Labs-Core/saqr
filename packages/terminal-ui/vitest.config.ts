import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@saqr/shared": path.resolve(__dirname, "../shared/src/index.ts"),
      "@saqr/cli/types/timeline": path.resolve(__dirname, "../cli/src/types/timeline.ts"),
      "@saqr/cli/normalization": path.resolve(__dirname, "../cli/src/normalization/index.ts"),
      "@saqr/cli/theme": path.resolve(__dirname, "../cli/src/theme/index.ts"),
      "@saqr/daemon": path.resolve(__dirname, "../daemon/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
