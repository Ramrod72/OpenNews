"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { CSRF_HEADER } from "@/lib/auth/csrf";

export function RunIngestButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setSummary(null);
    try {
      const res = await fetch("/api/admin/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      const results = data.results as Array<{ success: boolean; itemsNew: number }>;
      const newArticles = results.reduce((sum, r) => sum + r.itemsNew, 0);
      const failed = results.filter((r) => !r.success).length;
      setSummary(
        `Fetched ${results.length} sources — ${newArticles} new articles, ${failed} failed.`,
      );
      router.refresh();
    } catch {
      setSummary("Ingestion run failed unexpectedly. Check server logs.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
      >
        <RefreshCw size={15} className={running ? "animate-spin" : ""} />
        {running ? "Running…" : "Run ingestion now"}
      </button>
      {summary && <p className="mt-2 text-sm text-foreground-muted">{summary}</p>}
    </div>
  );
}
