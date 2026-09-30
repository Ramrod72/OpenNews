import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Phase 14B — M7: scripts/ensure-sqlite-wal.mjs is the one-time,
 * idempotent database-file-level fix for the web+worker SQLite
 * concurrency model (see that script's own extensive doc comment for the
 * full investigation/reasoning — busy_timeout was already 5000ms by
 * Prisma's own default; journal_mode was not WAL, and a `?journal_mode=`
 * query parameter on DATABASE_URL has no effect on Prisma's SQLite
 * connector, so this must be set via an explicit PRAGMA against an open
 * connection instead).
 */
let dir: string;

afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

async function readJournalMode(databaseUrl: string): Promise<string> {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const [{ journal_mode: mode }] =
      await prisma.$queryRawUnsafe<[{ journal_mode: string }]>("PRAGMA journal_mode;");
    return mode;
  } finally {
    await prisma.$disconnect();
  }
}

describe("ensure-sqlite-wal.mjs", () => {
  it("switches a fresh SQLite file to WAL mode, and it persists across a new connection", async () => {
    dir = mkdtempSync(join(tmpdir(), "opennews-wal-test-"));
    const dbPath = join(dir, "test.db");
    const databaseUrl = `file:${dbPath}`;

    expect(await readJournalMode(databaseUrl)).toBe("delete"); // SQLite's own default

    execFileSync("node", ["scripts/ensure-sqlite-wal.mjs"], {
      cwd: join(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    expect(await readJournalMode(databaseUrl)).toBe("wal");
  }, 20_000);

  it("is idempotent — running it a second time against an already-WAL file succeeds and stays WAL", async () => {
    dir = mkdtempSync(join(tmpdir(), "opennews-wal-test-"));
    const dbPath = join(dir, "test.db");
    const databaseUrl = `file:${dbPath}`;

    const run = () =>
      execFileSync("node", ["scripts/ensure-sqlite-wal.mjs"], {
        cwd: join(__dirname, ".."),
        env: { ...process.env, DATABASE_URL: databaseUrl },
      });

    run();
    expect(() => run()).not.toThrow();
    expect(await readJournalMode(databaseUrl)).toBe("wal");
  }, 20_000);

  it("no-ops safely for a non-SQLite DATABASE_URL (e.g. PostgreSQL)", () => {
    const output = execFileSync("node", ["scripts/ensure-sqlite-wal.mjs"], {
      cwd: join(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: "postgresql://user:pass@localhost:5432/db" },
    }).toString();
    expect(output).toContain("nothing to do");
  }, 20_000);
});

describe("adversarial: simultaneous web+worker-style writes against a WAL-mode file", () => {
  it("two separate Prisma clients (simulating the web and worker processes) writing concurrently never corrupt data or hang past busy_timeout", async () => {
    dir = mkdtempSync(join(tmpdir(), "opennews-wal-concurrency-"));
    const dbPath = join(dir, "test.db");
    const databaseUrl = `file:${dbPath}`;

    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: join(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    execFileSync("node", ["scripts/ensure-sqlite-wal.mjs"], {
      cwd: join(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    const webClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const workerClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    try {
      await webClient.category.create({
        data: { slug: "wal-stress-test", name: "WAL Stress Test", order: 999 },
      });

      // 30 "web" writes (e.g. admin edits) interleaved with 30 "worker"
      // writes (e.g. ingestion) against overlapping rows, fired
      // concurrently rather than awaited one at a time — this is what
      // would produce SQLITE_BUSY errors under naive non-WAL,
      // no-busy-timeout SQLite usage.
      const webWrites = Array.from({ length: 30 }, (_, i) =>
        webClient.source.create({
          data: {
            name: `WAL web source ${i}`,
            url: `https://wal-stress-test.example.com/web-${i}.xml`,
            categorySlug: "wal-stress-test",
          },
        }),
      );
      const workerWrites = Array.from({ length: 30 }, (_, i) =>
        workerClient.source.create({
          data: {
            name: `WAL worker source ${i}`,
            url: `https://wal-stress-test.example.com/worker-${i}.xml`,
            categorySlug: "wal-stress-test",
          },
        }),
      );

      const results = await Promise.allSettled([...webWrites, ...workerWrites]);
      const failures = results.filter((r) => r.status === "rejected");
      expect(failures).toHaveLength(0);

      const count = await webClient.source.count({ where: { categorySlug: "wal-stress-test" } });
      expect(count).toBe(60); // every single write landed — none silently lost
    } finally {
      await webClient.$disconnect();
      await workerClient.$disconnect();
    }
  }, 30_000);
});
