import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@polli-labs/calyx-sdk": resolve(__dirname, "packages/sdk/src/index.ts"),
      "@polli-labs/calyx-core": resolve(__dirname, "packages/core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts"]
  }
});
