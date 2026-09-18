import "dotenv/config";
import cron from "node-cron";
import { ingestAllDueSources } from "@/lib/ingest/ingestAll";
import { clusterRecentArticles } from "@/lib/clustering/cluster";

// How often the scheduler wakes up to check which sources are due. Actual
// per-source fetch cadence is controlled by each Source's
// fetchIntervalMinutes, so this can safely be more frequent than any one
// feed's interval without over-fetching it.
const TICK_CRON = process.env.WORKER_CRON || "*/5 * * * *";

let running = false;

async function tick() {
  if (running) {
    console.log("[worker] previous run still in progress, skipping this tick");
    return;
  }
  running = true;
  const started = Date.now();
  try {
    const results = await ingestAllDueSources();
    if (results.length > 0) {
      const newArticles = results.reduce((sum, r) => sum + r.itemsNew, 0);
      const failed = results.filter((r) => !r.success).length;
      console.log(
        `[worker] ingested ${results.length} sources (${newArticles} new articles, ${failed} failed)`,
      );
      const clusterResult = await clusterRecentArticles();
      console.log(
        `[worker] clustering: +${clusterResult.clustersCreated} new, ${clusterResult.clustersUpdated} updated`,
      );
    }
  } catch (err) {
    console.error("[worker] tick failed:", err);
  } finally {
    running = false;
    console.log(`[worker] tick finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

console.log(`[worker] starting, schedule="${TICK_CRON}"`);
cron.schedule(TICK_CRON, tick);

// Run once immediately on startup so a fresh install has content right away
// instead of waiting for the first cron tick.
tick();

process.on("SIGTERM", () => {
  console.log("[worker] SIGTERM received, shutting down");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[worker] SIGINT received, shutting down");
  process.exit(0);
});
