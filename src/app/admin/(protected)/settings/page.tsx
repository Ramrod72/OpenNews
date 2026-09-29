import { getAdSettings } from "@/lib/ads";
import { getAiConfig } from "@/lib/ai/config";
import { SettingsForm } from "./SettingsForm";

// See src/app/admin/(protected)/sources/page.tsx's own comment on this
// directive — every admin page reading live data needs it, and this one
// especially: the Story Brief kill switch's displayed initial value must
// reflect the current AdminSetting/env-derived state, not a build-time
// snapshot.
export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const [ads, aiConfig] = await Promise.all([getAdSettings(), getAiConfig()]);

  // Explicitly picked, never spread: aiConfig (the full server-only
  // AiConfig from @/lib/ai/config.ts) also carries storyBriefTimeoutMs,
  // which must never reach this client component's serialized props —
  // see settings/types.ts's own local, narrower AiConfig re-declaration.
  const ai = {
    provider: aiConfig.provider,
    baseUrl: aiConfig.baseUrl,
    model: aiConfig.model,
    storyBriefEnabled: aiConfig.storyBriefEnabled,
  };

  return (
    <div>
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight">Settings</h1>
      <SettingsForm initialAds={ads} initialAi={ai} />
    </div>
  );
}
