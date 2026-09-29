export type { AdSettings } from "@/lib/validation/settings";

// Redeclared (rather than imported from lib/ai/config.ts) so this file
// stays safe to import from client components — lib/ai/config.ts pulls in
// the Prisma client, which can't be bundled for the browser.
export interface AiConfig {
  provider: "none" | "ollama";
  baseUrl: string;
  model: string;
  /** Phase 13B operational kill switch for AI Story Brief generation — deliberately the ONLY Story Brief field exposed here (never storyBriefTimeoutMs). */
  storyBriefEnabled: boolean;
}
