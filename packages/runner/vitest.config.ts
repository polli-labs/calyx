import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@polli-labs/calyx-runner": resolve(__dirname, "src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
