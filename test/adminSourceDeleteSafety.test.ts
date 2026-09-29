import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ROOT = join(__dirname, "..");

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
import { DELETE as deleteSource } from "@/app/api/admin/sources/[id]/route";

describe("54: the confirm dialog clearly states cascade deletion of article/intelligence data", () => {
  it("mentions articles AND cascading derived data, not just 'association'", () => {
    const source = readFileSync(
      join(ROOT, "src/app/admin/(protected)/sources/SourcesManager.tsx"),
      "utf8",
    );
    const confirmMatch = source.match(/confirm\(\s*([\s\S]*?)\)\s*\)/);
    expect(confirmMatch).not.toBeNull();
    const confirmText = confirmMatch![1];
    expect(confirmText).toMatch(/permanently/i);
    expect(confirmText).toMatch(/articles?/i);
    expect(confirmText).toMatch(/provenance|claim|keyword/i);
    expect(confirmText).not.toMatch(/its association with existing articles/i); // the old, understating wording is gone
  });
});

describe("56: no archive behavior was introduced", () => {
  it("the DELETE route still performs a real prisma.source.delete, never a soft-delete/archive update", () => {
    const source = readFileSync(join(ROOT, "src/app/api/admin/sources/[id]/route.ts"), "utf8");
    expect(source).toMatch(/prisma\.source\.delete/);
    expect(source).not.toMatch(/archived|isArchived|archivedAt/i);
  });

  it("the Source model gained no archive-related column in this phase's schema", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    const sourceModelMatch = schema.match(/model Source \{[\s\S]*?\n\}/);
    expect(sourceModelMatch).not.toBeNull();
    expect(sourceModelMatch![0]).not.toMatch(/archived|isArchived|archivedAt/i);
  });
});

describe("55: actual cascade semantics are unchanged — deleting a source still cascades to its articles and derived data", () => {
  let categoryId: string;
  const disposableSourceIds: string[] = [];

  beforeAll(async () => {
    const category = await prisma.category.create({
      data: { slug: "test-source-delete-cascade", name: "Test Source Delete Cascade", order: 999 },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await prisma.source.deleteMany({ where: { id: { in: disposableSourceIds } } });
    await prisma.category.delete({ where: { id: categoryId } });
  });

  afterEach(() => {
    state.jar.clear();
  });

  it("deleting a source deletes its articles too (existing cascade, unchanged)", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Cascade Test Source",
        url: `https://cascade-test-${Date.now()}.example.com/feed.xml`,
        categorySlug: "test-source-delete-cascade",
      },
    });
    const article = await prisma.article.create({
      data: {
        sourceId: source.id,
        url: `https://cascade-test-${Date.now()}.example.com/article-1`,
        urlHash: `hash-${Date.now()}-${Math.random()}`,
        title: "Cascade test article",
        titleNormalized: "cascade test article",
        publishedAt: new Date(),
      },
    });

    const session = await getAdminSession();
    session.isAdmin = true;
    await session.save();

    const res = await deleteSource(
      new Request(`http://localhost/api/admin/sources/${source.id}`, {
        method: "DELETE",
        headers: { [CSRF_HEADER]: "1" },
      }),
      { params: Promise.resolve({ id: source.id }) },
    );
    expect(res.status).toBe(200);

    const survivingArticle = await prisma.article.findUnique({ where: { id: article.id } });
    expect(survivingArticle).toBeNull(); // cascaded, exactly as before this phase
  });
});
