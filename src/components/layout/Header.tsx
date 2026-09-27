import Link from "next/link";
import { Suspense } from "react";
import { Flame, Bookmark, Newspaper, Tag, UserCircle } from "lucide-react";
import { listCategories } from "@/lib/stories";
import { SearchBar } from "./SearchBar";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { MobileNav } from "./MobileNav";

export async function Header() {
  const categories = await listCategories();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-1.5 text-lg font-extrabold tracking-tight">
          <Newspaper size={20} className="text-accent" aria-hidden />
          Veriqen
        </Link>

        <Suspense fallback={<div className="hidden flex-1 md:block" />}>
          <SearchBar className="hidden max-w-md flex-1 md:block" />
        </Suspense>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/pricing"
            className="hidden items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium text-foreground-muted hover:bg-surface-muted hover:text-foreground md:flex"
          >
            <Tag size={15} /> Pricing
          </Link>
          <Link
            href="/breaking"
            className="hidden items-center gap-1 rounded-full px-3 py-1.5 text-sm font-semibold text-breaking hover:bg-surface-muted sm:flex"
          >
            <Flame size={15} /> Breaking
          </Link>
          <Link
            href="/bookmarks"
            aria-label="Bookmarks"
            className="hidden h-9 w-9 items-center justify-center rounded-full border border-border text-foreground-muted hover:text-foreground sm:flex"
          >
            <Bookmark size={16} />
          </Link>
          <Link
            href="/account"
            aria-label="Account"
            className="hidden h-9 w-9 items-center justify-center rounded-full border border-border text-foreground-muted hover:text-foreground sm:flex"
          >
            <UserCircle size={16} />
          </Link>
          <ThemeToggle />
          <MobileNav categories={categories} />
        </div>
      </div>

      <div className="scrollbar-none mx-auto hidden max-w-6xl gap-1 overflow-x-auto px-4 pb-2 md:flex">
        {categories.map((c) => (
          <Link
            key={c.slug}
            href={`/category/${c.slug}`}
            className="shrink-0 rounded-full px-3 py-1 text-sm font-medium text-foreground-muted hover:bg-surface-muted hover:text-foreground"
          >
            {c.name}
          </Link>
        ))}
      </div>

      <div className="px-4 pb-2 md:hidden">
        <Suspense fallback={<div className="h-9" />}>
          <SearchBar />
        </Suspense>
      </div>
    </header>
  );
}
