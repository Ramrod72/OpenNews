import Link from "next/link";

export function CategoryBadge({
  slug,
  name,
  className,
}: {
  slug: string;
  name: string;
  className?: string;
}) {
  return (
    <Link
      href={`/category/${slug}`}
      className={`inline-flex items-center rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-foreground-muted hover:text-accent ${className ?? ""}`}
    >
      {name}
    </Link>
  );
}

export function BreakingBadge({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-breaking/10 px-2.5 py-0.5 text-xs font-bold tracking-wide text-breaking uppercase ${className ?? ""}`}
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-breaking" aria-hidden />
      Breaking
    </span>
  );
}
