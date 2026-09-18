import { getAdSettings } from "@/lib/ads";
import { getAiConfig } from "@/lib/ai/config";
import { SettingsForm } from "./SettingsForm";

export default async function AdminSettingsPage() {
  const [ads, ai] = await Promise.all([getAdSettings(), getAiConfig()]);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight">Settings</h1>
      <SettingsForm initialAds={ads} initialAi={ai} />
    </div>
  );
}
