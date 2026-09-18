import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <Icon size={28} className="text-foreground-muted" />
      <p className="font-semibold text-foreground">{title}</p>
      {description && <p className="max-w-md text-sm text-foreground-muted">{description}</p>}
      {action}
    </div>
  );
}
