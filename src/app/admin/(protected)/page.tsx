import { prisma } from "@/lib/db";
import { RunIngestButton } from "./RunIngestButton";

export default async function AdminDashboardPage() {
  const [
    sourceCount,
    activeSourceCount,
    articleCount,
    clusterCount,
    breakingCount,
    recentFailures,
  ] = await Promise.all([
    prisma.source.count(),
    prisma.source.count({ where: { active: true } }),
    prisma.article.count(),
    prisma.storyCluster.count(),
    prisma.storyCluster.count({ where: { breaking: true } }),
    prisma.feedFetchLog.findMany({
      where: { success: false },
      orderBy: { startedAt: "desc" },
      take: 5,
      include: { source: { select: { name: true } } },
    }),
  ]);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight">Dashboard</h1>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Sources" value={`${activeSourceCount}/${sourceCount}`} hint="active/total" />
        <Stat label="Articles" value={articleCount.toLocaleString()} />
        <Stat label="Story clusters" value={clusterCount.toLocaleString()} />
        <Stat label="Breaking now" value={breakingCount.toLocaleString()} />
      </div>

      <div className="mb-8 rounded-xl border border-border p-4">
        <p className="mb-2 font-bold">Manual ingestion</p>
        <p className="mb-3 text-sm text-foreground-muted">
          The worker process fetches feeds automatically on a schedule. Trigger an immediate run
          here (e.g. right after adding a source).
        </p>
        <RunIngestButton />
      </div>

      {recentFailures.length > 0 && (
        <div className="rounded-xl border border-border p-4">
          <p className="mb-2 font-bold">Recent feed failures</p>
          <ul className="space-y-1.5 text-sm">
            {recentFailures.map((log) => (
              <li key={log.id} className="flex items-center justify-between gap-3">
                <span className="font-medium">{log.source.name}</span>
                <span className="truncate text-xs text-foreground-muted">{log.errorMessage}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="text-2xl font-extrabold">{value}</p>
      <p className="text-xs text-foreground-muted">
        {label}
        {hint && <span className="opacity-70"> ({hint})</span>}
      </p>
    </div>
  );
}
