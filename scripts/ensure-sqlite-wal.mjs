#!/usr/bin/env node
// Phase 14B — M7: one-time database-file-level setup for the SQLite
// web+worker concurrency model.
//
// Investigation found: Prisma's SQLite connector already defaults
// busy_timeout to 5000ms with no configuration needed (confirmed by
// querying `PRAGMA busy_timeout;` against a freshly-migrated DB) — so a
// brief write from one process never immediately fails with
// "database is locked" for another; it waits, then retries, for up to 5s.
// But journal_mode defaults to SQLite's own default ("delete", the
// classic rollback journal) — NOT WAL — and, critically, a `?journal_mode=
// WAL` query parameter on DATABASE_URL has NO effect on Prisma's SQLite
// connector (verified empirically: the PRAGMA stays "delete" either way).
// journal_mode is a property of the DATABASE FILE ITSELF, set via a PRAGMA
// against an open connection, not a per-connection URL setting — so it
// must be set explicitly, once, this way.
//
// Why this matters for the web+worker topology (docker-compose.yml runs
// both against one shared file): in the default "delete" mode, a writer
// briefly needs an exclusive lock at commit time, which blocks any
// concurrent reader from EVEN STARTING a new read until that commit
// finishes (readers already mid-read block the writer's upgrade instead).
// WAL mode removes this entirely for the common case — readers and one
// writer can proceed fully concurrently — which is the standard,
// SQLite-recommended configuration for exactly this "multiple processes,
// one shared file" pattern. Busy_timeout already bounds the worst case in
// either mode, so this is a real improvement, not a fix for a bug that
// would otherwise cause failures.
//
// Idempotent and safe to run on every container/process start: if the
// file is already in WAL mode, this is a no-op. No-op entirely (and
// exits 0) when DATABASE_URL isn't a `file:` (SQLite) URL, so switching
// to PostgreSQL (see prisma/schema.prisma's own comment on that) needs no
// changes here.
import { PrismaClient } from "@prisma/client";

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl.startsWith("file:")) {
    console.log("[db-wal] DATABASE_URL is not a SQLite file: URL — nothing to do.");
    return;
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
    const [{ journal_mode: journalMode }] = await prisma.$queryRawUnsafe("PRAGMA journal_mode;");
    console.log(`[db-wal] SQLite journal_mode is now "${journalMode}" (busy_timeout=5000ms).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[db-wal] failed to set SQLite journal mode:", err);
  process.exit(1);
});
