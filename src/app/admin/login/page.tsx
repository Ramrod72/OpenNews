"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { CSRF_HEADER } from "@/lib/auth/csrf";

export default function AdminLoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Login failed");
        return;
      }
      router.push("/admin");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col items-center pt-12">
      <ShieldCheck size={28} className="mb-3 text-accent" />
      <h1 className="mb-6 text-xl font-extrabold">Admin sign in</h1>
      <form onSubmit={handleSubmit} className="w-full space-y-3">
        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </div>
        {error && <p className="text-sm text-breaking">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="mt-4 text-center text-xs text-foreground-muted">
        Set <code className="rounded bg-surface-muted px-1">ADMIN_PASSWORD_HASH</code> (or{" "}
        <code className="rounded bg-surface-muted px-1">ADMIN_PASSWORD</code> for local dev) in your
        environment to enable admin access.
      </p>
    </div>
  );
}
