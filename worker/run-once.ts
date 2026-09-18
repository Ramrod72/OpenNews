import "dotenv/config";
import { ingestAllDueSources } from "@/lib/ingest/ingestAll";
import { clusterRecentArticles } from "@/lib/clustering/cluster";
import { prisma } from "@/lib/db";

/** Run a single ingest + cluster pass and exit. Useful for cron/CI or manual `npm run ingest`. */
async function main() {
  const started = Date.now();
  const results = await ingestAllDueSources({ force: process.argv.includes("--force") });
  const newArticles = results.reduce((sum, r) => sum + r.itemsNew, 0);
  console.log(`[ingest] fetched ${results.length} sources, ${newArticles} new articles`);

  const clusterResult = await clusterRecentArticles();
  console.log(
    `[cluster] created ${clusterResult.clustersCreated}, updated ${clusterResult.clustersUpdated} clusters`,
  );
  console.log(`[run-once] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .catch((err) => {
    console.error("[run-once] fatal error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
