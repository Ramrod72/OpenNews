import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Regression coverage for the shared-entrypoint startup race fix: web and
 * worker previously ran `prisma migrate deploy` + `ensure-sqlite-wal.mjs`
 * + `npm run db:seed` on EVERY container start, which could race a
 * migration/write against the same SQLite file from two processes at once
 * ("database is locked"). Migrations/WAL setup/seeding now run exactly
 * once, from a dedicated one-shot `migrate` Compose service that web and
 * worker both depend on via `condition: service_completed_successfully` —
 * see docker-compose.yml, docker/migrate.sh, docker/entrypoint.sh.
 */

const repoRoot = join(__dirname, "..");

describe("docker/entrypoint.sh no longer performs DB initialization", () => {
  it("contains no migrate/WAL/seed steps — only the exec passthrough", () => {
    const content = readFileSync(join(repoRoot, "docker/entrypoint.sh"), "utf8");
    expect(content).not.toMatch(/migrate deploy/);
    expect(content).not.toMatch(/ensure-sqlite-wal/);
    expect(content).not.toMatch(/db:seed/);
    expect(content).toMatch(/exec "\$@"/);
  });
});

describe("docker/migrate.sh runs the full one-shot initialization sequence, in order", () => {
  it("contains migrate deploy, then ensure-sqlite-wal, then db:seed, in that order", () => {
    const content = readFileSync(join(repoRoot, "docker/migrate.sh"), "utf8");
    const migrateIndex = content.indexOf("npx prisma migrate deploy");
    const walIndex = content.indexOf("node scripts/ensure-sqlite-wal.mjs");
    const seedIndex = content.indexOf("npm run db:seed");
    expect(migrateIndex).toBeGreaterThan(-1);
    expect(walIndex).toBeGreaterThan(migrateIndex);
    expect(seedIndex).toBeGreaterThan(walIndex);
  });
});

describe("docker/migrate.sh end-to-end", () => {
  let dir: string;
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a migrated, WAL-mode, seeded database behind", async () => {
    dir = mkdtempSync(join(tmpdir(), "opennews-migrate-sh-verify-"));
    const dbPath = join(dir, "test.db");
    const databaseUrl = `file:${dbPath}`;

    execFileSync("sh", ["docker/migrate.sh"], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const [{ journal_mode: journalMode }] =
        await prisma.$queryRawUnsafe<[{ journal_mode: string }]>("PRAGMA journal_mode;");
      expect(journalMode).toBe("wal");

      const categoryCount = await prisma.category.count();
      const sourceCount = await prisma.source.count();
      expect(categoryCount).toBeGreaterThan(0);
      expect(sourceCount).toBeGreaterThan(0);
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);
});

interface ComposeService {
  restart?: string;
  entrypoint?: string[] | null;
  command?: string[];
  depends_on?: Record<string, { condition: string }>;
  environment?: Record<string, string>;
  volumes?: Array<{ source: string }>;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
}

describe("docker-compose.yml structural validation (via `docker compose config`)", () => {
  function tryGetComposeConfig(): ComposeConfig | null {
    try {
      const output = execFileSync("docker", ["compose", "config", "--format", "json"], {
        cwd: repoRoot,
        env: { ...process.env, SESSION_SECRET: "test-only-placeholder-not-a-real-secret" },
      }).toString();
      return JSON.parse(output) as ComposeConfig;
    } catch {
      return null; // docker/compose not available in this environment — skip gracefully below
    }
  }

  const config = tryGetComposeConfig();
  const maybeIt = config ? it : it.skip;

  maybeIt("defines a one-shot `migrate` service that web and worker both depend on", () => {
    const services = config!.services;
    expect(services.migrate).toBeDefined();
    expect(services.migrate!.restart).toBe("no");
    expect(services.migrate!.entrypoint).toEqual(["./docker/migrate.sh"]);

    expect(services.web!.depends_on!.migrate!.condition).toBe("service_completed_successfully");
    expect(services.worker!.depends_on!.migrate!.condition).toBe("service_completed_successfully");

    // Worker's pre-existing dependency on web's own health is preserved —
    // not replaced by the new migrate dependency, added alongside it.
    expect(services.worker!.depends_on!.web!.condition).toBe("service_healthy");
  });

  maybeIt("leaves web and worker's own entrypoint/command untouched (no DB-init override)", () => {
    const services = config!.services;
    // Neither service overrides the image's own ENTRYPOINT — both still
    // go through docker/entrypoint.sh (now a pure passthrough), never
    // running migrate/WAL/seed themselves.
    expect(services.web!.entrypoint ?? null).toBeNull();
    expect(services.worker!.entrypoint ?? null).toBeNull();
    expect(services.worker!.command).toEqual(["npx", "tsx", "worker/index.ts"]);
  });

  maybeIt(
    "preserves restart: unless-stopped on web and worker, so a crash-restart never re-runs migrate.sh",
    () => {
      const services = config!.services;
      expect(services.web!.restart).toBe("unless-stopped");
      expect(services.worker!.restart).toBe("unless-stopped");
      // The one-shot init container is explicitly NOT auto-restarted — it is
      // meant to exit 0 and stay stopped, never re-racing web/worker.
      expect(services.migrate!.restart).toBe("no");
    },
  );

  maybeIt(
    "keeps the same DATABASE_URL and the same opennews-data volume on every service, unchanged",
    () => {
      const services = config!.services;
      for (const name of ["migrate", "web", "worker"]) {
        expect(services[name]!.environment?.DATABASE_URL).toBe("file:/data/opennews.db");
        const volumeNames = (services[name]!.volumes ?? []).map((v) => v.source);
        expect(volumeNames).toContain("opennews-data");
      }
      expect(config!.volumes["opennews-data"]).toBeDefined();
    },
  );

  if (!config) {
    it.skip("docker compose is not available in this environment — structural checks skipped", () => {});
  }
});
