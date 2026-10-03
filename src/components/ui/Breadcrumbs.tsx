import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface BreadcrumbItem {
  name: string;
  /** Omit on the final (current-page) item — it renders as plain text, not a link. */
  href?: string;
}

/**
 * Visible breadcrumb trail. Always pair this with
 * buildBreadcrumbListJsonLd(), given the exact same items in the exact
 * same order — a mismatch between the two is exactly what
 * test/structuredDataSafety.test.ts's breadcrumb-agreement tests guard
 * against, since inconsistent breadcrumb structured data is a form of the
 * prohibited "fake structured data."
 */
export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-sm text-foreground-muted">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, index) => (
          <li key={`${item.name}-${index}`} className="flex items-center gap-1.5">
            {index > 0 && <ChevronRight size={13} aria-hidden />}
            {item.href ? (
              <Link href={item.href} className="hover:text-accent hover:underline">
                {item.name}
              </Link>
            ) : (
              <span aria-current="page" className="font-medium text-foreground">
                {item.name}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
