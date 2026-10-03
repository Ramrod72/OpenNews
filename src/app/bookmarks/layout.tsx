import type { Metadata } from "next";

// page.tsx is a Client Component ("use client"), which can't export
// `metadata` itself — Next requires a Server Component (this layout) to
// carry it instead. Bookmarks are per-browser localStorage data (see
// src/lib/hooks/usePersonalization.ts) — never the same for two crawls —
// so there's nothing generically indexable here regardless of who's
// viewing it.
export const metadata: Metadata = {
  title: "Bookmarks",
  robots: { index: false, follow: false },
};

export default function BookmarksLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
