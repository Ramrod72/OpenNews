"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <EmptyState
      icon={AlertTriangle}
      title="Something went wrong"
      description="This page hit an unexpected error. You can try again, or head back to the homepage."
      action={
        <button
          onClick={reset}
          type="button"
          className="mt-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground"
        >
          Try again
        </button>
      }
    />
  );
}
