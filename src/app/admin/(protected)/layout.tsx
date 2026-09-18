import Link from "next/link";
import { LogoutButton } from "./LogoutButton";

export const metadata = { title: "Admin" };

// Auth is enforced in src/middleware.ts, which runs before this layout (or
// the page underneath it) executes at all — see the comment there for why
// a check here alone would NOT be sufficient to protect the page content.
export default function AdminProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-[200px_1fr]">
      <nav
        className="flex flex-row gap-1 overflow-x-auto md:flex-col"
        aria-label="Admin navigation"
      >
        <AdminNavLink href="/admin">Dashboard</AdminNavLink>
        <AdminNavLink href="/admin/sources">Sources</AdminNavLink>
        <AdminNavLink href="/admin/feed-health">Feed health</AdminNavLink>
        <AdminNavLink href="/admin/settings">Settings</AdminNavLink>
        <div className="mt-2 md:mt-4">
          <LogoutButton />
        </div>
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function AdminNavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium hover:bg-surface-muted"
    >
      {children}
    </Link>
  );
}
