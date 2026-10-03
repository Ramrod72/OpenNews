import type { Metadata } from "next";

// page.tsx is a Client Component ("use client"), which can't export
// `metadata` itself — Next requires a Server Component (this layout) to
// carry it instead.
export const metadata: Metadata = {
  title: "Admin login",
  robots: { index: false, follow: false },
};

export default function AdminLoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
