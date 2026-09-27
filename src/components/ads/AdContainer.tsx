import { AdSlot, type AdSlotKey, type AdSlotSize } from "./AdSlot";

const SLOT_LABELS: Record<AdSlotKey, string> = {
  homepageFeed: "Homepage feed",
  sidebar: "Sidebar",
  betweenStories: "Between stories",
  articlePage: "Article page",
  mobileFeed: "Mobile feed",
};

const SLOT_SIZES: Record<AdSlotKey, AdSlotSize> = {
  homepageFeed: "in-feed",
  sidebar: "sidebar",
  betweenStories: "leaderboard",
  articlePage: "rectangle",
  mobileFeed: "in-feed",
};

/**
 * Thin, viewer-independent wrapper: just tells AdSlot which named slot to
 * render. It deliberately does NOT look up the admin's ad settings itself
 * (it did before Phase 5's fix) — AdSlot now reads both the admin's
 * config and the viewer's eligibility from useAdConfig(), which never
 * carries the actual ad code unless this viewer is eligible. Doing that
 * lookup here instead would mean embedding the ad network's snippet text
 * in this component's props on every page load regardless of viewer,
 * which is exactly what Phase 5 closes: on a page that uses ISR caching
 * (homepage/category/story), that per-slot code would also be identical
 * for every visitor, admin-configured content included, whether or not
 * they're allowed to see it.
 */
export function AdContainer({ slot, className }: { slot: AdSlotKey; className?: string }) {
  return (
    <AdSlot name={SLOT_LABELS[slot]} size={SLOT_SIZES[slot]} slot={slot} className={className} />
  );
}
