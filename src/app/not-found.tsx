import Link from "next/link";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";

export default function NotFound() {
  return (
    <EmptyState
      icon={SearchX}
      title="Page not found"
      description="The page you're looking for doesn't exist, or the story may have been merged into another one."
      action={
        <Link
          href="/"
          className="mt-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground"
        >
          Back to homepage
        </Link>
      }
    />
  );
}
