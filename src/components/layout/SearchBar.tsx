"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { useState, type FormEvent } from "react";

export function SearchBar({ className }: { className?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(searchParams.get("q") ?? "");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    router.push(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search");
  }

  return (
    <form onSubmit={handleSubmit} role="search" className={`relative ${className ?? ""}`}>
      <Search
        size={16}
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-foreground-muted"
        aria-hidden
      />
      <label htmlFor="site-search" className="sr-only">
        Search news
      </label>
      <input
        id="site-search"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search topics, people, companies…"
        className="w-full rounded-full border border-border bg-surface py-2 pr-3 pl-9 text-sm text-foreground placeholder:text-foreground-muted focus:border-accent focus:outline-none"
      />
    </form>
  );
}
