import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These admin routes are guarded by requireAdmin() -> getAdminSession() ->
 * next/headers's cookies(), which only works inside a real Next.js request.
 * Phases 2-5 treated that as untestable and fell back to structural
 * (regex-based) checks plus manual HTTP smoke testing. This file closes
 * that gap: it fakes next/headers's cookies() with an in-memory cookie
 * jar that iron-session can read/write like the real thing, so the actual
 * route handlers — requireAdmin, CSRF, Zod validation, and the Prisma
 * calls — all run for real, with a real (if synthetic) admin session.
 */
const state = vi.hoisted(() => ({
  jar: new Map<string, string>(),
}));

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
import { POST as createAssessment } from "@/app/api/admin/sources/[id]/assessments/route";
import {
  PATCH as patchAssessment,
  DELETE as deleteAssessment,
} from "@/app/api/admin/sources/[id]/assessments/[assessmentId]/route";
import { PATCH as patchSource } from "@/app/api/admin/sources/[id]/route";

async function signInAsAdmin() {
  const session = await getAdminSession();
  session.isAdmin = true;
  await session.save();
}

function signOut() {
  state.jar.clear();
}

function req(method: string, body?: unknown, extraHeaders?: Record<string, string>) {
  return new Request("http://localhost/api/admin/test", {
    method,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function authedReq(method: string, body?: unknown) {
  return req(method, body, { [CSRF_HEADER]: "1" });
}

let categoryId: string;
let sourceAId: string;
let sourceBId: string;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-source-admin", name: "Test Source Admin", order: 999 },
  });
  categoryId = category.id;

  const [a, b] = await Promise.all([
    prisma.source.create({
      data: {
        name: "Admin Test Source A",
        url: "https://admin-a.example.com/feed.xml",
        categorySlug: "test-source-admin",
      },
    }),
    prisma.source.create({
      data: {
        name: "Admin Test Source B",
        url: "https://admin-b.example.com/feed.xml",
        categorySlug: "test-source-admin",
      },
    }),
  ]);
  sourceAId = a.id;
  sourceBId = b.id;
});

afterAll(async () => {
  await prisma.externalAssessment.deleteMany({
    where: { sourceId: { in: [sourceAId, sourceBId] } },
  });
  await prisma.source.deleteMany({ where: { id: { in: [sourceAId, sourceBId] } } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  signOut();
});

const validAssessment = {
  provider: "Example Rating Institute (fictional test provider)",
  assessmentType: "political_lean",
  ratingValue: "Lean left",
};

describe("POST /api/admin/sources/[id]/assessments — authorization", () => {
  it("rejects an unauthenticated request with 401 and creates nothing", async () => {
    const before = await prisma.externalAssessment.count({ where: { sourceId: sourceAId } });
    const res = await createAssessment(authedReq("POST", validAssessment), {
      params: Promise.resolve({ id: sourceAId }),
    });
    expect(res.status).toBe(401);
    const after = await prisma.externalAssessment.count({ where: { sourceId: sourceAId } });
    expect(after).toBe(before);
  });

  it("rejects an authenticated request missing the CSRF header with 403", async () => {
    await signInAsAdmin();
    const res = await createAssessment(req("POST", validAssessment), {
      params: Promise.resolve({ id: sourceAId }),
    });
    expect(res.status).toBe(403);
  });

  it("succeeds with a valid session + CSRF header, and actually persists the row", async () => {
    await signInAsAdmin();
    const res = await createAssessment(authedReq("POST", validAssessment), {
      params: Promise.resolve({ id: sourceAId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const stored = await prisma.externalAssessment.findUnique({
      where: { id: body.assessment.id },
    });
    expect(stored?.sourceId).toBe(sourceAId);
    expect(stored?.provider).toBe(validAssessment.provider);
  });

  it("404s for a nonexistent source id and creates nothing", async () => {
    await signInAsAdmin();
    const res = await createAssessment(authedReq("POST", validAssessment), {
      params: Promise.resolve({ id: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects malformed JSON with 400, not a 500", async () => {
    await signInAsAdmin();
    const res = await createAssessment(
      new Request("http://localhost/api/admin/test", {
        method: "POST",
        headers: { [CSRF_HEADER]: "1", "content-type": "application/json" },
        body: "{not valid json",
      }),
      { params: Promise.resolve({ id: sourceAId }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("Cross-source assessment tampering", () => {
  let assessmentOnA: string;

  beforeEach(async () => {
    await signInAsAdmin();
    const res = await createAssessment(authedReq("POST", validAssessment), {
      params: Promise.resolve({ id: sourceAId }),
    });
    const body = await res.json();
    assessmentOnA = body.assessment.id;
  });

  it("PATCHing sourceA's assessment through sourceB's URL 404s and leaves the row untouched", async () => {
    const res = await patchAssessment(
      authedReq("PATCH", { ...validAssessment, ratingValue: "Lean right (tampered)" }),
      { params: Promise.resolve({ id: sourceBId, assessmentId: assessmentOnA }) },
    );
    expect(res.status).toBe(404);
    const stored = await prisma.externalAssessment.findUnique({ where: { id: assessmentOnA } });
    expect(stored?.ratingValue).toBe("Lean left");
  });

  it("DELETEing sourceA's assessment through sourceB's URL 404s and leaves the row in place", async () => {
    const res = await deleteAssessment(authedReq("DELETE"), {
      params: Promise.resolve({ id: sourceBId, assessmentId: assessmentOnA }),
    });
    expect(res.status).toBe(404);
    const stored = await prisma.externalAssessment.findUnique({ where: { id: assessmentOnA } });
    expect(stored).not.toBeNull();
  });

  it("PATCHing through the correct source id succeeds", async () => {
    const res = await patchAssessment(
      authedReq("PATCH", { ...validAssessment, ratingValue: "Center" }),
      {
        params: Promise.resolve({ id: sourceAId, assessmentId: assessmentOnA }),
      },
    );
    expect(res.status).toBe(200);
    const stored = await prisma.externalAssessment.findUnique({ where: { id: assessmentOnA } });
    expect(stored?.ratingValue).toBe("Center");
  });

  it("an unauthenticated DELETE through the correct source id is still rejected and the row survives", async () => {
    signOut();
    const res = await deleteAssessment(authedReq("DELETE"), {
      params: Promise.resolve({ id: sourceAId, assessmentId: assessmentOnA }),
    });
    expect(res.status).toBe(401);
    const stored = await prisma.externalAssessment.findUnique({ where: { id: assessmentOnA } });
    expect(stored).not.toBeNull();
  });
});

describe("PATCH /api/admin/sources/[id] — profile allowlist cannot smuggle ingestion-state changes", () => {
  it("extra fields not in the update schema (consecutiveFailures, lastError, id, createdAt) are silently ignored, not applied", async () => {
    await signInAsAdmin();
    const before = await prisma.source.findUniqueOrThrow({ where: { id: sourceAId } });

    const res = await patchSource(
      authedReq("PATCH", {
        description: "Legit profile edit",
        // Everything below is NOT part of updateSchema and must be dropped
        // by Zod before it ever reaches the Prisma `data` object.
        consecutiveFailures: 999999,
        lastError: "injected failure message",
        lastFetchedAt: "2099-01-01T00:00:00Z",
        id: "attacker-controlled-id",
        createdAt: "1970-01-01T00:00:00Z",
      }),
      { params: Promise.resolve({ id: sourceAId }) },
    );
    expect(res.status).toBe(200);

    const after = await prisma.source.findUniqueOrThrow({ where: { id: sourceAId } });
    expect(after.id).toBe(sourceAId);
    expect(after.consecutiveFailures).toBe(before.consecutiveFailures);
    expect(after.lastError).toBe(before.lastError);
    expect(after.lastFetchedAt).toEqual(before.lastFetchedAt);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.description).toBe("Legit profile edit");
  });

  it("an unauthenticated PATCH is rejected and nothing changes", async () => {
    const before = await prisma.source.findUniqueOrThrow({ where: { id: sourceAId } });
    const res = await patchSource(authedReq("PATCH", { description: "should not apply" }), {
      params: Promise.resolve({ id: sourceAId }),
    });
    expect(res.status).toBe(401);
    const after = await prisma.source.findUniqueOrThrow({ where: { id: sourceAId } });
    expect(after.description).toBe(before.description);
  });

  it("rejects an unsafe URL scheme for homepageUrl/logoUrl even from an authenticated admin", async () => {
    await signInAsAdmin();
    const res = await patchSource(authedReq("PATCH", { homepageUrl: "javascript:alert(1)" }), {
      params: Promise.resolve({ id: sourceAId }),
    });
    expect(res.status).toBe(400);
  });
});
