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
    // All test files share ONE SQLite file (see DATABASE_URL above). Under
    // vitest's default parallel-file execution, unrelated test files
    // running concurrently in separate worker threads compete for writes
    // against that single file — harmless on a fast, lightly-loaded
    // machine, but on a constrained CI runner this genuinely starves
    // unrelated files enough to blow past vitest's own hook/test timeouts
    // (a ceiling raising Prisma's own $transaction/connection timeouts
    // doesn't touch — see reserveUsage's own doc comment in
    // src/lib/entitlements.ts for that separate, already-addressed layer).
    // Running test files sequentially instead removes the contention
    // entirely rather than continuing to chase individual timeout values.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
