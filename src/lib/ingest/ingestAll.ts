import { prisma } from "@/lib/db";
import { mapWithConcurrency } from "@/lib/concurrency";
import { ingestSource, type IngestResult } from "./ingestSource";

const CONCURRENT_FETCHES = 4;

/**
 * Ingest every active source whose fetch interval has elapsed (or all of
 * them, with `force`). Failures are isolated per-source — one broken feed
 * never prevents the others from being fetched.
 */
export async function ingestAllDueSources(
  options: { force?: boolean } = {},
): Promise<IngestResult[]> {
  const sources = await prisma.source.findMany({ where: { active: true } });
  const now = Date.now();

  const due = options.force
    ? sources
    : sources.filter((s) => {
        if (!s.lastFetchedAt) return true;
        const elapsedMinutes = (now - s.lastFetchedAt.getTime()) / 60_000;
        return elapsedMinutes >= s.fetchIntervalMinutes;
      });

  if (due.length === 0) return [];

  console.log(`[ingest] fetching ${due.length}/${sources.length} due sources...`);
  const results = await mapWithConcurrency(due, CONCURRENT_FETCHES, async (source) => {
    const result = await ingestSource(source);
    if (result.success) {
      console.log(`[ingest] ${source.name}: ${result.itemsNew} new / ${result.itemsFound} found`);
    } else {
      console.warn(`[ingest] ${source.name} failed: ${result.error}`);
    }
    return result;
  });

  return results;
}
