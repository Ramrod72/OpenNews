"use client";

import { useState } from "react";
import Link from "next/link";
import type { Category, Source } from "@prisma/client";
import { Plus, Trash2, Pause, Play, ExternalLink, Pencil } from "lucide-react";
import { CSRF_HEADER } from "@/lib/auth/csrf";

type SourceWithCount = Source & { _count: { articles: number } };

export function SourcesManager({
  initialSources,
  categories,
}: {
  initialSources: SourceWithCount[];
  categories: Category[];
}) {
  const [sources, setSources] = useState(initialSources);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    url: "",
    homepageUrl: "",
    categorySlug: categories[0]?.slug ?? "",
  });
  const [submitting, setSubmitting] = useState(false);

  async function addSource(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" },
        body: JSON.stringify({ ...form, homepageUrl: form.homepageUrl || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Could not add source");
        return;
      }
      setSources((prev) => [{ ...data.source, _count: { articles: 0 } }, ...prev]);
      setForm({ name: "", url: "", homepageUrl: "", categorySlug: categories[0]?.slug ?? "" });
    } finally {
      setSubmitting(false);
    }
  }

  async function updateSource(id: string, patch: Partial<Source>) {
    const res = await fetch(`/api/admin/sources/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = await res.json();
      setSources((prev) => prev.map((s) => (s.id === id ? { ...s, ...data.source } : s)));
    }
  }

  async function deleteSource(id: string) {
    if (!confirm("Remove this source and its association with existing articles?")) return;
    const res = await fetch(`/api/admin/sources/${id}`, {
      method: "DELETE",
      headers: { [CSRF_HEADER]: "1" },
    });
    if (res.ok) setSources((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <div className="flex flex-col gap-8">
      <form
        onSubmit={addSource}
        className="grid grid-cols-1 gap-3 rounded-xl border border-border p-4 sm:grid-cols-2"
      >
        <h2 className="col-span-full font-bold">Add a source</h2>
        <Field label="Name">
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Category">
          <select
            value={form.categorySlug}
            onChange={(e) => setForm({ ...form, categorySlug: e.target.value })}
            className="input"
          >
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Feed URL (RSS/Atom)">
          <input
            required
            type="url"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            className="input"
            placeholder="https://example.com/feed.xml"
          />
        </Field>
        <Field label="Homepage URL (optional)">
          <input
            type="url"
            value={form.homepageUrl}
            onChange={(e) => setForm({ ...form, homepageUrl: e.target.value })}
            className="input"
            placeholder="https://example.com"
          />
        </Field>
        {error && <p className="col-span-full text-sm text-breaking">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="col-span-full flex w-fit items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
        >
          <Plus size={15} /> Add source
        </button>
      </form>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-muted text-left text-xs tracking-wide text-foreground-muted uppercase">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Interval</th>
              <th className="px-3 py-2">Articles</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Last error</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id} className="border-t border-border">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5 font-medium">
                    {s.name}
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground-muted hover:text-accent"
                    >
                      <ExternalLink size={12} />
                    </a>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={s.categorySlug}
                    onChange={(e) => updateSource(s.id, { categorySlug: e.target.value })}
                    className="input"
                  >
                    {categories.map((c) => (
                      <option key={c.slug} value={c.slug}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    min={5}
                    max={1440}
                    defaultValue={s.fetchIntervalMinutes}
                    onBlur={(e) =>
                      updateSource(s.id, { fetchIntervalMinutes: Number(e.target.value) })
                    }
                    className="input w-20"
                  />{" "}
                  min
                </td>
                <td className="px-3 py-2">{s._count.articles}</td>
                <td className="px-3 py-2">
                  {s.consecutiveFailures > 0 ? (
                    <span className="text-breaking">{s.consecutiveFailures} failing</span>
                  ) : s.lastSuccessAt ? (
                    <span className="text-success">OK</span>
                  ) : (
                    <span className="text-foreground-muted">Not fetched yet</span>
                  )}
                </td>
                <td
                  className="max-w-[200px] truncate px-3 py-2 text-xs text-foreground-muted"
                  title={s.lastError ?? ""}
                >
                  {s.lastError ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Link
                      href={`/admin/sources/${s.id}`}
                      title="Edit profile & assessments"
                      className="rounded p-1.5 hover:bg-surface-muted"
                    >
                      <Pencil size={14} />
                    </Link>
                    <button
                      type="button"
                      title={s.active ? "Pause" : "Resume"}
                      onClick={() => updateSource(s.id, { active: !s.active })}
                      className="rounded p-1.5 hover:bg-surface-muted"
                    >
                      {s.active ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <button
                      type="button"
                      title="Delete"
                      onClick={() => deleteSource(s.id)}
                      className="rounded p-1.5 text-breaking hover:bg-surface-muted"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
    </label>
  );
}
