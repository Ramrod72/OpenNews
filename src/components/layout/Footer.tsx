import Link from "next/link";

export function Footer() {
  return (
    <footer className="mt-12 border-t border-border py-8 text-sm text-foreground-muted">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 sm:flex-row sm:items-center sm:justify-between">
        <p>
          OpenNews aggregates publicly available headlines and links back to original publishers. It
          does not host full article content.
        </p>
        <nav className="flex gap-4">
          <Link href="/sources" className="hover:text-foreground">
            Sources
          </Link>
          <Link href="/about" className="hover:text-foreground">
            About
          </Link>
          <a
            href="https://github.com"
            className="hover:text-foreground"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
