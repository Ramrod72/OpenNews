import { prisma } from "@/lib/db";
import { absoluteTime, relativeTime } from "@/lib/format";
import { CheckCircle2, XCircle } from "lucide-react";

// See src/app/admin/(protected)/sources/page.tsx's own comment on this
// directive — every admin page reading live data needs it.
export const dynamic = "force-dynamic";

export default async function FeedHealthPage() {
  const sources = await prisma.source.findMany({
    orderBy: { name: "asc" },
    include: {
      fetchLogs: { orderBy: { startedAt: "desc" }, take: 10 },
    },
  });

  return (
    <div>
      <h1 className="mb-2 text-2xl font-extrabold tracking-tight">Feed health</h1>
      <p className="mb-6 text-sm text-foreground-muted">
        The last 10 fetch attempts per source. A source failing repeatedly usually means its feed
        URL changed or it&apos;s blocking automated requests — check the error message and update
        the feed URL under Sources if needed.
      </p>

      <div className="flex flex-col gap-4">
        {sources.map((source) => (
          <div key={source.id} className="rounded-xl border border-border p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-bold">{source.name}</p>
              <span className="text-xs text-foreground-muted">
                {source.lastSuccessAt
                  ? `Last success ${relativeTime(source.lastSuccessAt)}`
                  : "Never succeeded"}
              </span>
            </div>
            {source.fetchLogs.length === 0 ? (
              <p className="text-sm text-foreground-muted">No fetch attempts recorded yet.</p>
            ) : (
              <ul className="space-y-1">
                {source.fetchLogs.map((log) => (
                  <li key={log.id} className="flex items-center gap-2 text-sm">
                    {log.success ? (
                      <CheckCircle2 size={14} className="shrink-0 text-success" />
                    ) : (
                      <XCircle size={14} className="shrink-0 text-breaking" />
                    )}
                    <span className="text-foreground-muted" title={absoluteTime(log.startedAt)}>
                      {relativeTime(log.startedAt)}
                    </span>
                    {log.success ? (
                      <span>
                        {log.itemsNew} new / {log.itemsFound} found
                      </span>
                    ) : (
                      <span className="truncate text-breaking">{log.errorMessage}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
