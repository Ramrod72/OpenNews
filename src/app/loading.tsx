import { StoryGridSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <div>
        <div className="skeleton mb-4 h-6 w-40 rounded" />
        <StoryGridSkeleton count={3} />
      </div>
      <div>
        <div className="skeleton mb-4 h-6 w-32 rounded" />
        <StoryGridSkeleton count={6} />
      </div>
    </div>
  );
}
