import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Regression coverage for two SQLite startup races, fixed in sequence:
 *
 * 1. web and worker previously ran `prisma migrate deploy` +
 *    `ensure-sqlite-wal.mjs` + `npm run db:seed` on EVERY container start,
 *    which could race a migration/write against the same SQLite file from
 *    two processes at once ("database is locked"). Fixed by moving all
 *    three steps into a dedicated one-shot `migrate` Compose service.
 * 2. Wiring that `migrate` service in as a `depends_on` of web/worker
 *    (`condition: service_completed_successfully`) reintroduced the SAME
 *    race one level up: Compose re-evaluates that condition every time a
 *    dependent is brought up, so `docker compose up -d --force-recreate
 *    worker` — run on its own, after the original migrate container was
 *    gone — re-ran migrate concurrently with an already-live `web` and hit
 *    "database is locked" again. Fixed by removing `migrate` from both
 *    services' `depends_on` entirely and gating it behind
 *    `profiles: ["init"]` instead, so it is structurally excluded from any
 *    `docker compose up` that doesn't explicitly pass `--profile init` —
 *    see docker-compose.yml, docker/migrate.sh, docker/entrypoint.sh,
 *    DEPLOYMENT.md's explicit two-step deploy procedure.
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
  profiles?: string[];
  depends_on?: Record<string, { condition: string }>;
  environment?: Record<string, string>;
  volumes?: Array<{ source: string }>;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
}

describe("docker-compose.yml structural validation (via `docker compose config`)", () => {
  function tryGetComposeConfig(extraArgs: string[] = []): ComposeConfig | null {
    try {
      const output = execFileSync(
        "docker",
        ["compose", ...extraArgs, "config", "--format", "json"],
        {
          cwd: repoRoot,
          env: { ...process.env, SESSION_SECRET: "test-only-placeholder-not-a-real-secret" },
        },
      ).toString();
      return JSON.parse(output) as ComposeConfig;
    } catch {
      return null; // docker/compose not available in this environment — skip gracefully below
    }
  }

  // Default resolution — exactly what `docker compose up` (no service
  // names, no --profile) would see. This is the config that must NEVER
  // include `migrate`.
  const defaultConfig = tryGetComposeConfig();
  // Explicit `--profile init` resolution — what the documented deploy
  // step (`docker compose --profile init run --rm migrate`) sees.
  const initConfig = tryGetComposeConfig(["--profile", "init"]);
  const maybeIt = defaultConfig && initConfig ? it : it.skip;

  maybeIt(
    "excludes `migrate` from the default resolution entirely — a bare `docker compose up` cannot start it",
    () => {
      expect(defaultConfig!.services.migrate).toBeUndefined();
      expect(Object.keys(defaultConfig!.services).sort()).toEqual(["web", "worker"]);
    },
  );

  maybeIt(
    "worker has NO dependency on `migrate` — recreating/restarting it independently cannot invoke migrate",
    () => {
      // Checked against BOTH resolutions: worker's own depends_on must
      // never name migrate, whether or not the init profile happens to be
      // active for an unrelated reason.
      for (const config of [defaultConfig!, initConfig!]) {
        expect(config.services.worker!.depends_on?.migrate).toBeUndefined();
        expect(config.services.web!.depends_on?.migrate).toBeUndefined();
      }
    },
  );

  maybeIt(
    "worker still waits for web's own health, unaffected by the migrate dependency removal",
    () => {
      expect(defaultConfig!.services.worker!.depends_on!.web!.condition).toBe("service_healthy");
    },
  );

  maybeIt(
    "defines `migrate` as an explicit, profile-gated one-shot service only visible with --profile init",
    () => {
      const migrate = initConfig!.services.migrate;
      expect(migrate).toBeDefined();
      expect(migrate!.profiles).toEqual(["init"]);
      expect(migrate!.restart).toBe("no");
      expect(migrate!.entrypoint).toEqual(["./docker/migrate.sh"]);
    },
  );

  maybeIt("leaves web and worker's own entrypoint/command untouched (no DB-init override)", () => {
    const services = defaultConfig!.services;
    // Neither service overrides the image's own ENTRYPOINT — both still
    // go through docker/entrypoint.sh (a pure passthrough), never running
    // migrate/WAL/seed themselves.
    expect(services.web!.entrypoint ?? null).toBeNull();
    expect(services.worker!.entrypoint ?? null).toBeNull();
    expect(services.worker!.command).toEqual(["npx", "tsx", "worker/index.ts"]);
  });

  maybeIt(
    "preserves restart: unless-stopped on web and worker, and restart: 'no' on migrate",
    () => {
      const services = defaultConfig!.services;
      expect(services.web!.restart).toBe("unless-stopped");
      expect(services.worker!.restart).toBe("unless-stopped");
      // The one-shot init container is explicitly NOT auto-restarted — it
      // is meant to exit 0 and stay stopped, never re-racing web/worker.
      expect(initConfig!.services.migrate!.restart).toBe("no");
    },
  );

  maybeIt(
    "keeps the same DATABASE_URL and the same opennews-data volume on every service, unchanged",
    () => {
      for (const name of ["migrate", "web", "worker"]) {
        const service = initConfig!.services[name]!;
        expect(service.environment?.DATABASE_URL).toBe("file:/data/opennews.db");
        const volumeNames = (service.volumes ?? []).map((v) => v.source);
        expect(volumeNames).toContain("opennews-data");
      }
      expect(initConfig!.volumes["opennews-data"]).toBeDefined();
    },
  );

  if (!defaultConfig || !initConfig) {
    it.skip("docker compose is not available in this environment — structural checks skipped", () => {});
  }
});
