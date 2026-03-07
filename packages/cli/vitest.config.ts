import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@saqr/shared": path.resolve(__dirname, "../shared/src/index.ts"),
      "@saqr/sync-client": path.resolve(__dirname, "../sync-client/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    environment: "node",
    globals: false,
    typecheck: {
      enabled: false,
    },
  },
});
