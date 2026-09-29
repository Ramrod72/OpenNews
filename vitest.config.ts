import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "worker/**/*.test.ts", "test/**/*.test.ts"],
    env: {
      DATABASE_URL: `file:${path.resolve(__dirname, "test/.tmp-test.db")}?socket_timeout=30&connection_limit=1`,
    },
    globalSetup: ["./test/global-setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
