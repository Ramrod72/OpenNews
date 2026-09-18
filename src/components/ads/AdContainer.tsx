import { getAdSettings } from "@/lib/ads";
import { AdSlot, type AdSlotSize } from "./AdSlot";

const SLOT_LABELS: Record<string, string> = {
  homepageFeed: "Homepage feed",
  sidebar: "Sidebar",
  betweenStories: "Between stories",
  articlePage: "Article page",
  mobileFeed: "Mobile feed",
};

const SLOT_SIZES: Record<string, AdSlotSize> = {
  homepageFeed: "in-feed",
  sidebar: "sidebar",
  betweenStories: "leaderboard",
  articlePage: "rectangle",
  mobileFeed: "in-feed",
};

/** Server component: looks up the admin-configured ad settings for a named slot and renders it. */
export async function AdContainer({
  slot,
  className,
}: {
  slot: "homepageFeed" | "sidebar" | "betweenStories" | "articlePage" | "mobileFeed";
  className?: string;
}) {
  const settings = await getAdSettings();
  const slotConfig = settings.slots[slot];

  return (
    <AdSlot
      name={SLOT_LABELS[slot]}
      size={SLOT_SIZES[slot]}
      enabled={settings.enabled && slotConfig.enabled}
      code={slotConfig.code}
      className={className}
    />
  );
}
