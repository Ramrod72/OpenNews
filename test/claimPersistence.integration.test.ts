import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  CLAIM_EXTRACTOR_VERSION,
  MAX_CLAIMS_PER_ARTICLE,
  clearStaleClaims,
  persistClaimsForArticle,
} from "@/lib/claims/persistClaims";

let categoryId: string;
let sourceId: string;
let articleCounter = 0;

beforeAll(async () => {
  const category = await prisma.category.create({
    data: { slug: "test-claim-persistence", name: "Test Claim Persistence", order: 999 },
  });
  categoryId = category.id;
  const source = await prisma.source.create({
    data: {
      name: "Test Claim Persistence Source",
      url: "https://claim-persistence-test.example.com/feed.xml",
      categorySlug: "test-claim-persistence",
    },
  });
  sourceId = source.id;
});

afterAll(async () => {
  await prisma.claim.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
  await prisma.source.delete({ where: { id: sourceId } });
  await prisma.category.delete({ where: { id: categoryId } });
});

afterEach(async () => {
  await prisma.claim.deleteMany({ where: { article: { categoryId } } });
  await prisma.article.deleteMany({ where: { categoryId } });
});

async function makeArticle(): Promise<string> {
  articleCounter += 1;
  const article = await prisma.article.create({
    data: {
      sourceId,
      url: `https://claim-persistence-test.example.com/a${articleCounter}`,
      urlHash: `hash-${articleCounter}-${Date.now()}`,
      title: `Test article ${articleCounter}`,
      titleNormalized: `test article ${articleCounter}`,
      publishedAt: new Date(),
      categoryId,
    },
  });
  return article.id;
}

describe("basic persistence and dedupe", () => {
  it("persists a numerical claim and is idempotent across repeated calls", async () => {
    const articleId = await makeArticle();
    const text = "Officials said 12 people were injured in the fire.";

    const first = await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    expect(first.persisted).toBe(1);

    // persisted counts successful upsert operations (mirroring
    // persistObservationsForArticle's own semantics exactly) — a rerun
    // against the same dedupeKey re-upserts (a no-op `update: {}`) rather
    // than inserting a new row, so the ROW COUNT is what proves idempotency,
    // not the persisted counter.
    await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });

    const rows = await prisma.claim.findMany({ where: { articleId } });
    expect(rows).toHaveLength(1);
  });

  it("does not dedupe two genuinely distinct claims at different offsets", async () => {
    const articleId = await makeArticle();
    const text = "5 people were killed in one incident. 12 people were injured in another.";
    const result = await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    expect(result.persisted).toBe(2);
  });
});

describe("MAX_CLAIMS_PER_ARTICLE cap", () => {
  it("caps total persisted claims at MAX_CLAIMS_PER_ARTICLE across multiple calls for the same article", async () => {
    const articleId = await makeArticle();
    // 30 distinct numerical claims across 30 sentences — well over the cap.
    const sentences = Array.from(
      { length: 30 },
      (_, i) => `${i + 1} people were injured in incident ${i}.`,
    ).join(" ");

    await persistClaimsForArticle(prisma, {
      articleId,
      text: sentences,
      extractionSource: "FEED_TEXT",
      observations: [],
    });

    const rows = await prisma.claim.findMany({ where: { articleId } });
    expect(rows.length).toBeLessThanOrEqual(MAX_CLAIMS_PER_ARTICLE);
  });

  it("prioritizes HIGH confidence claims over MEDIUM when the cap forces a choice", async () => {
    const articleId = await makeArticle();
    // 15 HIGH-confidence INJURIES claims + 15 MEDIUM-confidence bare PEOPLE claims = 30 candidates, cap is 20.
    const injuries = Array.from({ length: 15 }, (_, i) => `${i + 1} people were injured today.`);
    const bare = Array.from(
      { length: 15 },
      (_, i) => `About ${i + 100} people attended event ${i}.`,
    );
    const text = [...injuries, ...bare].join(" ");

    await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });

    const rows = await prisma.claim.findMany({ where: { articleId } });
    expect(rows.length).toBeLessThanOrEqual(MAX_CLAIMS_PER_ARTICLE);
    const highCount = rows.filter((r) => r.confidence === "HIGH").length;
    expect(highCount).toBe(15); // every HIGH candidate survives the cap
  });

  it("never drops previously-persisted rows when a later call is itself at/over the cap (idempotent re-upsert, not overwrite)", async () => {
    const articleId = await makeArticle();
    const firstBatch = Array.from(
      { length: 20 },
      (_, i) => `${i + 1} people were injured today.`,
    ).join(" ");
    await persistClaimsForArticle(prisma, {
      articleId,
      text: firstBatch,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    const afterFirst = await prisma.claim.count({ where: { articleId } });
    expect(afterFirst).toBe(20);

    // A second, different-text call (simulating TITLE) should be capped to zero new rows.
    const result = await persistClaimsForArticle(prisma, {
      articleId,
      text: "999 people were injured elsewhere.",
      extractionSource: "TITLE",
      observations: [],
    });
    expect(result.cappedByLimit).toBeGreaterThan(0);
    const afterSecond = await prisma.claim.count({ where: { articleId } });
    expect(afterSecond).toBe(20); // unchanged — the cap held, nothing was displaced
  });
});

describe("concurrency safety (the exact race Phase 8 previously had to fix)", () => {
  it("two concurrent persist calls for the SAME article/version never collectively exceed the cap", async () => {
    const articleId = await makeArticle();
    const textA = Array.from(
      { length: 15 },
      (_, i) => `${i + 1} people were injured in fire ${i}.`,
    ).join(" ");
    const textB = Array.from(
      { length: 15 },
      (_, i) => `${i + 50} people were injured in flood ${i}.`,
    ).join(" ");

    await Promise.all([
      persistClaimsForArticle(prisma, {
        articleId,
        text: textA,
        extractionSource: "FEED_TEXT",
        observations: [],
      }),
      persistClaimsForArticle(prisma, {
        articleId,
        text: textB,
        extractionSource: "TITLE",
        observations: [],
      }),
    ]);

    const rows = await prisma.claim.count({ where: { articleId } });
    expect(rows).toBeLessThanOrEqual(MAX_CLAIMS_PER_ARTICLE);
  });
});

describe("ADMIN_OVERRIDE preservation", () => {
  it("clearStaleClaims never deletes an ADMIN_OVERRIDE row regardless of its version", async () => {
    const articleId = await makeArticle();
    await persistClaimsForArticle(prisma, {
      articleId,
      text: "12 people were injured.",
      extractionSource: "FEED_TEXT",
      observations: [],
      claimExtractorVersion: "stale-version@0",
    });
    const claim = await prisma.claim.findFirstOrThrow({ where: { articleId } });
    await prisma.claim.update({ where: { id: claim.id }, data: { reviewState: "ADMIN_OVERRIDE" } });

    const deletedCount = await clearStaleClaims(prisma, articleId, CLAIM_EXTRACTOR_VERSION);
    expect(deletedCount).toBe(0);
    const stillThere = await prisma.claim.findUnique({ where: { id: claim.id } });
    expect(stillThere).not.toBeNull();
  });

  it("clearStaleClaims deletes a non-override row at a different version", async () => {
    const articleId = await makeArticle();
    await persistClaimsForArticle(prisma, {
      articleId,
      text: "12 people were injured.",
      extractionSource: "FEED_TEXT",
      observations: [],
      claimExtractorVersion: "stale-version@0",
    });
    const deletedCount = await clearStaleClaims(prisma, articleId, CLAIM_EXTRACTOR_VERSION);
    expect(deletedCount).toBe(1);
  });
});

describe("LOW confidence can never persist, even via a hostile caller-supplied observation", () => {
  it("discards an ATTRIBUTED_STATEMENT candidate whose confidence is the runtime string LOW, bypassing the TypeScript type entirely", async () => {
    const articleId = await makeArticle();
    const text = "Officials said the bridge would reopen next week.";
    // A real ProvenanceObservation.confidence column is a plain string, not
    // a database-enforced enum — if Phase 7's own filtering ever regressed,
    // or a row were hand-edited, a caller could hand this function an
    // observation whose confidence is literally "LOW". This attack found a
    // real defect during the final adversarial review: buildAttributedStatementClaims
    // copies obs.confidence straight through, and persistClaimsForArticle
    // had no independent runtime guard rejecting it before persistence.
    const hostileObservation = {
      entityId: null,
      startOffset: 0,
      endOffset: text.length,
      confidence: "LOW",
    } as unknown as {
      entityId: string | null;
      startOffset: number;
      endOffset: number;
      confidence: "HIGH" | "MEDIUM";
    };

    const result = await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [hostileObservation],
    });

    expect(result.discardedLow).toBe(1);
    expect(result.persisted).toBe(0);
    const rows = await prisma.claim.findMany({ where: { articleId } });
    expect(rows).toHaveLength(0);
    expect(rows.some((r) => r.confidence === "LOW")).toBe(false);
  });
});

describe("hostile/malformed text never crashes persistence", () => {
  it("persists safely against hostile HTML/Unicode text", async () => {
    const articleId = await makeArticle();
    await expect(
      persistClaimsForArticle(prisma, {
        articleId,
        text: '<script>alert(1)</script> 12 people were injured "quotes" & ‮RTL‬.',
        extractionSource: "FEED_TEXT",
        observations: [],
      }),
    ).resolves.toBeDefined();
  });

  it("bounds rawText/normalizedText length in the persisted row", async () => {
    const articleId = await makeArticle();
    const longSentence = `${"word ".repeat(300)}12 people were injured in the incident.`;
    await persistClaimsForArticle(prisma, {
      articleId,
      text: longSentence,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    const rows = await prisma.claim.findMany({ where: { articleId } });
    for (const row of rows) {
      expect(row.rawText.length).toBeLessThanOrEqual(201);
    }
  });
});

/**
 * Transaction-contention remediation (persistClaims.ts switched from one
 * sequential upsert() per candidate to a single findMany + one batched
 * createMany per call, both inside the same prisma.$transaction) — see
 * persistClaims.ts's own doc comments for the full rationale. These tests
 * target the specific new failure modes that rewrite introduced risk for.
 */

/** Wraps a real PrismaClient so every interactive transaction's tx.claim.{findMany,createMany} calls are counted, without changing their behavior. */
function withClaimTransactionSpy(basePrisma: typeof prisma) {
  const calls = { findMany: 0, createMany: 0 };
  const originalTransaction = basePrisma.$transaction.bind(basePrisma) as (
    fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => Promise<unknown>;
  const spied = {
    ...basePrisma,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      originalTransaction((tx) =>
        fn({
          ...tx,
          claim: {
            ...tx.claim,
            findMany: (...args: Parameters<typeof tx.claim.findMany>) => {
              calls.findMany += 1;
              return tx.claim.findMany(...args);
            },
            createMany: (...args: Parameters<typeof tx.claim.createMany>) => {
              calls.createMany += 1;
              return tx.claim.createMany(...args);
            },
          },
        }),
      ),
  } as unknown as typeof prisma;
  return { spied, calls };
}

/** Wraps a real PrismaClient so tx.claim.createMany always rejects inside the transaction, to test failure isolation without relying on a contrived real DB constraint violation. */
function withFailingClaimCreateMany(basePrisma: typeof prisma, error: Error) {
  const originalTransaction = basePrisma.$transaction.bind(basePrisma) as (
    fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => Promise<unknown>;
  return {
    ...basePrisma,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      originalTransaction((tx) =>
        fn({
          ...tx,
          claim: { ...tx.claim, createMany: () => Promise.reject(error) },
        }),
      ),
  } as unknown as typeof prisma;
}

describe("intra-batch duplicate dedupeKeys (collision within a SINGLE call's own candidates)", () => {
  it("collapses two bare-PEOPLE matches in the same sentence (identical sentence-widened offsets) to one row instead of throwing", async () => {
    const articleId = await makeArticle();
    // extractNumericalAssertions widens every match's offsets to the
    // CONTAINING SENTENCE's span (see extractNumericalAssertions.ts), not
    // the match's own span — so two distinct bare "N people" matches
    // inside the SAME sentence end up with identical
    // kind/startOffset/endOffset/unit/qualifier/entityId, and therefore an
    // identical dedupeKey, from a single extraction call. Neither "12
    // people" nor "15 people" here is adjacent to injured/hurt/killed/
    // arrested/about/at least etc., so both match ONLY the bare PEOPLE
    // rule (qualifier EXACT) and neither is suppressed as contained inside
    // a more specific pattern's span.
    const text = "12 people and 15 people gathered outside the courthouse today.";

    const result = await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });

    const rows = await prisma.claim.findMany({ where: { articleId } });
    expect(rows).toHaveLength(1); // the collision never produces two rows, and never throws
    // One candidate is genuinely written (createMany count); the other is
    // recognized as an intra-batch repeat of a key already queued for
    // creation (the `seenInBatch` branch) and counted as persisted without
    // a second write.
    expect(result.persisted).toBe(2);
    expect(result.cappedByLimit).toBe(0);
  });
});

describe("duplicate-heavy reruns never create duplicate rows", () => {
  it("rerunning the same 15-claim text three times in a row leaves exactly 15 rows with 15 distinct dedupeKeys", async () => {
    const articleId = await makeArticle();
    const text = Array.from(
      { length: 15 },
      (_, i) => `${i + 1} people were injured in incident ${i}.`,
    ).join(" ");

    for (let run = 0; run < 3; run++) {
      await persistClaimsForArticle(prisma, {
        articleId,
        text,
        extractionSource: "FEED_TEXT",
        observations: [],
      });
    }

    const rows = await prisma.claim.findMany({ where: { articleId } });
    expect(rows).toHaveLength(15);
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(15);
  });
});

describe("ADMIN_OVERRIDE dedupeKey collision", () => {
  it("never throws and never overwrites an ADMIN_OVERRIDE row whose dedupeKey matches a freshly re-extracted candidate", async () => {
    const articleId = await makeArticle();
    const text = "12 people were injured in the fire.";

    await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    const original = await prisma.claim.findFirstOrThrow({ where: { articleId } });

    // Simulate an admin manually correcting this exact row (same
    // dedupeKey — it is never recomputed on update — but different
    // content) and marking it ADMIN_OVERRIDE.
    await prisma.claim.update({
      where: { id: original.id },
      data: { reviewState: "ADMIN_OVERRIDE", rawText: "manually corrected by admin" },
    });

    // Re-extracting the SAME text produces a candidate with the exact same
    // dedupeKey as the now-overridden row. A plain createMany would throw
    // P2002 for the whole batch here if that candidate were ever handed to
    // it; existingKeys (built from EVERY row, override or not) must filter
    // it out before the write.
    const rerun = await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });

    const rows = await prisma.claim.findMany({ where: { articleId } });
    expect(rows).toHaveLength(1); // no duplicate row, no throw
    expect(rerun.persisted).toBe(1); // counted as already-persisted via the collision
    const stillOverridden = await prisma.claim.findUnique({ where: { id: original.id } });
    expect(stillOverridden?.reviewState).toBe("ADMIN_OVERRIDE");
    expect(stillOverridden?.rawText).toBe("manually corrected by admin"); // untouched
  });
});

describe("concurrency across DIFFERENT articles never shares or bleeds budget", () => {
  it("two concurrent persist calls for two different articles, each over the cap, independently cap at MAX_CLAIMS_PER_ARTICLE", async () => {
    const articleIdA = await makeArticle();
    const articleIdB = await makeArticle();
    const textA = Array.from(
      { length: 25 },
      (_, i) => `${i + 1} people were injured in fire ${i}.`,
    ).join(" ");
    const textB = Array.from(
      { length: 25 },
      (_, i) => `${i + 1} people were injured in flood ${i}.`,
    ).join(" ");

    const [resultA, resultB] = await Promise.all([
      persistClaimsForArticle(prisma, {
        articleId: articleIdA,
        text: textA,
        extractionSource: "FEED_TEXT",
        observations: [],
      }),
      persistClaimsForArticle(prisma, {
        articleId: articleIdB,
        text: textB,
        extractionSource: "FEED_TEXT",
        observations: [],
      }),
    ]);

    const rowsA = await prisma.claim.count({ where: { articleId: articleIdA } });
    const rowsB = await prisma.claim.count({ where: { articleId: articleIdB } });
    // Each article independently reaches the FULL cap — one article's
    // candidates never consume the other's budget.
    expect(rowsA).toBe(MAX_CLAIMS_PER_ARTICLE);
    expect(rowsB).toBe(MAX_CLAIMS_PER_ARTICLE);
    expect(resultA.cappedByLimit).toBe(5);
    expect(resultB.cappedByLimit).toBe(5);
  });
});

describe("createMany batch failure is isolated, logged, and leaves no partial/corrupted state", () => {
  it("a rejected createMany resolves without throwing, writes nothing, and a subsequent real call still persists cleanly", async () => {
    const articleId = await makeArticle();
    const text = "12 people were injured in the fire.";
    const failing = withFailingClaimCreateMany(prisma, new Error("simulated batch failure"));

    const result = await persistClaimsForArticle(failing, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    expect(result.persisted).toBe(0);
    const rowsAfterFailure = await prisma.claim.findMany({ where: { articleId } });
    expect(rowsAfterFailure).toHaveLength(0);

    // No corrupted dedupe state was left behind by the failed attempt — a
    // normal retry with the real client succeeds exactly as if the first
    // call had never happened.
    const retry = await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    expect(retry.persisted).toBe(1);
    const rowsAfterRetry = await prisma.claim.findMany({ where: { articleId } });
    expect(rowsAfterRetry).toHaveLength(1);
  });
});

describe("database round-trip count stays O(1) per invocation regardless of candidate count", () => {
  it("issues exactly one findMany and one createMany whether the call has 3 or 25 candidates", async () => {
    const articleIdFew = await makeArticle();
    const { spied: spiedFew, calls: callsFew } = withClaimTransactionSpy(prisma);
    const fewText = Array.from(
      { length: 3 },
      (_, i) => `${i + 1} people were injured in incident ${i}.`,
    ).join(" ");
    await persistClaimsForArticle(spiedFew, {
      articleId: articleIdFew,
      text: fewText,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    expect(callsFew.findMany).toBe(1);
    expect(callsFew.createMany).toBe(1);

    const articleIdMany = await makeArticle();
    const { spied: spiedMany, calls: callsMany } = withClaimTransactionSpy(prisma);
    const manyText = Array.from(
      { length: 25 },
      (_, i) => `${i + 1} people were injured in incident ${i}.`,
    ).join(" ");
    await persistClaimsForArticle(spiedMany, {
      articleId: articleIdMany,
      text: manyText,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    // Still exactly one round trip each, even though this call writes 20
    // rows (capped from 25 candidates) instead of 3 — this is what
    // collapses what used to be up to MAX_CLAIMS_PER_ARTICLE sequential
    // round trips into one.
    expect(callsMany.findMany).toBe(1);
    expect(callsMany.createMany).toBe(1);
  });

  it("issues zero createMany calls when every candidate already exists (no unnecessary writes on a no-op rerun)", async () => {
    const articleId = await makeArticle();
    const text = Array.from(
      { length: 5 },
      (_, i) => `${i + 1} people were injured in incident ${i}.`,
    ).join(" ");
    await persistClaimsForArticle(prisma, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });

    const { spied, calls } = withClaimTransactionSpy(prisma);
    await persistClaimsForArticle(spied, {
      articleId,
      text,
      extractionSource: "FEED_TEXT",
      observations: [],
    });
    expect(calls.findMany).toBe(1);
    expect(calls.createMany).toBe(0);
  });
});
