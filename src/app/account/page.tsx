import { redirect } from "next/navigation";
import { UserCircle } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/consumer/getCurrentUser";
import { getPlan } from "@/lib/entitlements";
import { prisma } from "@/lib/db";
import { absoluteTime } from "@/lib/format";
import { LogoutButton } from "./LogoutButton";
import { UpgradeButton } from "./UpgradeButton";

export const metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const [plan, plans] = await Promise.all([
    getPlan(user.id),
    prisma.plan.findMany({ where: { isActive: true }, orderBy: { priceCents: "asc" } }),
  ]);

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-6 flex items-center gap-3">
        <UserCircle size={32} className="text-accent" />
        <div>
          <h1 className="text-xl font-extrabold">{user.displayName || user.email}</h1>
          <p className="text-sm text-foreground-muted">{user.email}</p>
        </div>
      </div>

      <div className="mb-6 flex items-center justify-between rounded-xl border border-border p-4">
        <div>
          <p className="text-xs font-semibold tracking-wide text-foreground-muted uppercase">
            Current plan
          </p>
          <p className="text-lg font-bold">{plan.name}</p>
          <p className="text-xs text-foreground-muted">
            Member since {absoluteTime(user.createdAt)}
          </p>
        </div>
        <LogoutButton />
      </div>

      <div className="rounded-xl border border-border p-4">
        <p className="mb-3 font-bold">Available plans</p>
        <ul className="space-y-3">
          {plans.map((p) => (
            <li key={p.slug} className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">{p.name}</p>
                <p className="text-xs text-foreground-muted">
                  {p.priceCents === 0
                    ? "Free"
                    : `$${(p.priceCents / 100).toFixed(2)}/${p.billingInterval}`}
                </p>
              </div>
              {p.slug === plan.slug ? (
                <span className="rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-foreground-muted">
                  Current plan
                </span>
              ) : (
                <UpgradeButton planName={p.name} />
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
