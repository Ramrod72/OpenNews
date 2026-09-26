"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X, Bookmark, Flame, UserCircle } from "lucide-react";
import type { Category } from "@prisma/client";

export function MobileNav({ categories }: { categories: Category[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-foreground"
      >
        <Menu size={18} />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex">
          <button
            aria-label="Close navigation menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <nav
            className="relative ml-auto flex h-full w-72 flex-col gap-1 overflow-y-auto bg-surface p-4 shadow-xl"
            aria-label="Site navigation"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="font-bold">Menu</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation menu"
                className="flex h-8 w-8 items-center justify-center rounded-full text-foreground-muted hover:text-foreground"
              >
                <X size={18} />
              </button>
            </div>

            <Link
              href="/breaking"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-breaking hover:bg-surface-muted"
            >
              <Flame size={16} /> Breaking news
            </Link>
            <Link
              href="/bookmarks"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-surface-muted"
            >
              <Bookmark size={16} /> Bookmarks
            </Link>
            <Link
              href="/account"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-surface-muted"
            >
              <UserCircle size={16} /> Account
            </Link>

            <div className="my-2 h-px bg-border" />

            {categories.map((c) => (
              <Link
                key={c.slug}
                href={`/category/${c.slug}`}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-surface-muted"
              >
                {c.name}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </div>
  );
}
