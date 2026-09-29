"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import type { AdSettings, AiConfig } from "./types";

const SLOT_META: Array<{ key: keyof AdSettings["slots"]; label: string; hint: string }> = [
  {
    key: "homepageFeed",
    label: "Homepage feed",
    hint: "Inline placement between the top-stories and latest sections.",
  },
  { key: "sidebar", label: "Sidebar", hint: "Desktop sidebar on the homepage and story pages." },
  {
    key: "betweenStories",
    label: "Between stories",
    hint: "Full-width banner between story groups on category pages.",
  },
  { key: "articlePage", label: "Article page", hint: "Below the fold on individual story pages." },
  { key: "mobileFeed", label: "Mobile feed", hint: "In-feed placement on small screens." },
];

export function SettingsForm({
  initialAds,
  initialAi,
}: {
  initialAds: AdSettings;
  initialAi: AiConfig;
}) {
  const [ads, setAds] = useState(initialAds);
  const [ai, setAi] = useState(initialAi);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" },
        body: JSON.stringify({ ads, ai }),
      });
      setStatus(res.ok ? "Saved." : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-xl border border-border p-4">
        <h2 className="mb-1 font-bold">Advertising</h2>
        <p className="mb-4 text-sm text-foreground-muted">
          Veriqen doesn&apos;t bundle any ad network. Paste the snippet your provider gives you
          (e.g. an AdSense unit) into a slot below and enable it. Ads are always labeled and
          visually separated from editorial content.
        </p>
        <p className="mb-4 rounded-lg bg-surface-muted p-3 text-xs text-foreground-muted">
          The default Content-Security-Policy in <code>next.config.ts</code> only allows
          scripts/frames from this site&apos;s own origin. Most ad networks load a script from their
          own domain, so you&apos;ll need to add that domain to <code>script-src</code> (and{" "}
          <code>frame-src</code> /<code>connect-src</code> as needed) there before an external
          network snippet will actually load.
        </p>

        <label className="mb-4 flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={ads.enabled}
            onChange={(e) => setAds({ ...ads, enabled: e.target.checked })}
          />
          Enable advertising site-wide
        </label>

        <label className="mb-4 block text-sm">
          <span className="mb-1 block font-medium">
            Head snippet (optional network loader script)
          </span>
          <textarea
            value={ads.headSnippet}
            onChange={(e) => setAds({ ...ads, headSnippet: e.target.value })}
            rows={3}
            className="input font-mono text-xs"
            placeholder="Ad network loader script tag"
          />
        </label>

        <div className="flex flex-col gap-4">
          {SLOT_META.map(({ key, label, hint }) => (
            <div key={key} className="rounded-lg border border-border p-3">
              <div className="mb-1 flex items-center justify-between">
                <p className="text-sm font-semibold">{label}</p>
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={ads.slots[key].enabled}
                    onChange={(e) =>
                      setAds({
                        ...ads,
                        slots: {
                          ...ads.slots,
                          [key]: { ...ads.slots[key], enabled: e.target.checked },
                        },
                      })
                    }
                  />
                  Enabled
                </label>
              </div>
              <p className="mb-2 text-xs text-foreground-muted">{hint}</p>
              <textarea
                value={ads.slots[key].code}
                onChange={(e) =>
                  setAds({
                    ...ads,
                    slots: { ...ads.slots, [key]: { ...ads.slots[key], code: e.target.value } },
                  })
                }
                rows={3}
                className="input font-mono text-xs"
                placeholder="Ad unit HTML/JS snippet"
              />
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border p-4">
        <h2 className="mb-1 font-bold">AI (optional)</h2>
        <p className="mb-4 text-sm text-foreground-muted">
          Story summaries work without any AI configured (extractive summaries from collected
          excerpts). Optionally point Veriqen at a self-hosted, Ollama-compatible endpoint for
          higher-quality summaries — no API key or paid service required.
        </p>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block font-medium">Provider</span>
          <select
            value={ai.provider}
            onChange={(e) => setAi({ ...ai, provider: e.target.value as AiConfig["provider"] })}
            className="input"
          >
            <option value="none">None (extractive summaries only)</option>
            <option value="ollama">Ollama-compatible</option>
          </select>
        </label>

        {ai.provider === "ollama" && (
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Base URL</span>
              <input
                value={ai.baseUrl}
                onChange={(e) => setAi({ ...ai, baseUrl: e.target.value })}
                className="input"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Model</span>
              <input
                value={ai.model}
                onChange={(e) => setAi({ ...ai, model: e.target.value })}
                className="input"
              />
            </label>
          </div>
        )}

        <div className="rounded-lg border border-border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={ai.storyBriefEnabled}
              onChange={(e) => setAi({ ...ai, storyBriefEnabled: e.target.checked })}
            />
            AI Story Brief — operational kill switch
          </label>
          <p className="mt-1 text-xs text-foreground-muted">
            Turns AI Story Brief generation off immediately, without a redeploy. While off, no new
            Story Brief is generated and any previously cached Story Brief is also not shown — this
            is a full kill switch, not just a pause on new generation.
          </p>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
        >
          <Save size={15} /> {saving ? "Saving…" : "Save settings"}
        </button>
        {status && <span className="text-sm text-foreground-muted">{status}</span>}
      </div>
    </div>
  );
}
