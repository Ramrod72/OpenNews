export function StoryCardSkeleton({
  variant = "default",
}: {
  variant?: "featured" | "default" | "compact";
}) {
  if (variant === "compact") {
    return (
      <div className="flex items-center gap-3 p-2">
        <div className="skeleton h-14 w-20 shrink-0 rounded-md" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-3.5 w-full rounded" />
          <div className="skeleton h-3.5 w-2/3 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div
        className={`skeleton w-full ${variant === "featured" ? "aspect-[16/9]" : "aspect-[16/10]"}`}
      />
      <div className="space-y-3 p-4">
        <div className="skeleton h-4 w-20 rounded-full" />
        <div className="skeleton h-5 w-full rounded" />
        <div className="skeleton h-5 w-3/4 rounded" />
        <div className="skeleton h-3.5 w-full rounded" />
      </div>
    </div>
  );
}

export function StoryGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <StoryCardSkeleton key={i} />
      ))}
    </div>
  );
}
