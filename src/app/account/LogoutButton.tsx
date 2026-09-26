"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { CSRF_HEADER } from "@/lib/auth/consumer/csrf";

export function LogoutButton() {
  const router = useRouter();

  async function logout() {
    await fetch("/api/account/logout", { method: "POST", headers: { [CSRF_HEADER]: "1" } });
    router.push("/");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={logout}
      className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground-muted hover:bg-surface-muted hover:text-foreground"
    >
      <LogOut size={15} /> Log out
    </button>
  );
}
