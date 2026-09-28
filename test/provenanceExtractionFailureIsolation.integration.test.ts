import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { hashUrl, normalizeUrl } from "@/lib/ingest/normalize";

// Mocked BEFORE importing ingestSource.ts, which imports this module —
// simulates an unexpected (not just a per-observation DB write) failure
// inside provenance extraction/persistence, to prove it can never block
// Article creation itself (see src/lib/ingest/ingestSource.ts's
// extractAndPersistProvenance, which wraps this call in its own try/catch).
vi.mock("@/lib/provenance/persistObservations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provenance/persistObservations")>();
  return {
    ...actual,
    persistObservationsForArticle: vi
      .fn()
      .mockRejectedValue(new Error("simulated extraction failure")),
  };
});

const { persistItems } = await import("@/lib/ingest/ingestSource");

let categoryId: string;
let sourceId: string;
let source: Awaited<ReturnType<typeof prisma.source.create>>;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-provenance-failure-isolation", name: "Test Failure Isolation", order: 999 },
  });
  categoryId = category.id;

  source = await prisma.source.create({
    data: {
      name: "Test Failure Isolation Source",
      url: "https://provenance-failure-test.example.com/feed.xml",
      categorySlug: "test-provenance-failure-isolation",
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.$disconnect();
});

describe("50. extraction failure never blocks Article creation", () => {
  it("creates the Article row and counts it as new even when provenance extraction throws unexpectedly", async () => {
    const link = "https://provenance-failure-test.example.com/articles/1";
    const result = await persistItems(source, [
      {
        link,
        title: "A headline while extraction is broken",
        isoDate: new Date().toISOString(),
      } as never,
    ]);

    expect(result.itemsNew).toBe(1);

    const article = await prisma.article.findUnique({
      where: { urlHash: hashUrl(normalizeUrl(link)) },
    });
    expect(article).not.toBeNull();
    expect(article!.title).toBe("A headline while extraction is broken");
  });
});
