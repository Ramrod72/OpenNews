import { z } from "zod";

export const adSlotSchema = z.object({
  enabled: z.boolean().default(false),
  code: z.string().max(20_000).default(""),
});

export const adSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  headSnippet: z.string().max(20_000).default(""),
  slots: z
    .object({
      homepageFeed: adSlotSchema.default({ enabled: false, code: "" }),
      sidebar: adSlotSchema.default({ enabled: false, code: "" }),
      betweenStories: adSlotSchema.default({ enabled: false, code: "" }),
      articlePage: adSlotSchema.default({ enabled: false, code: "" }),
      mobileFeed: adSlotSchema.default({ enabled: false, code: "" }),
    })
    .default({
      homepageFeed: { enabled: false, code: "" },
      sidebar: { enabled: false, code: "" },
      betweenStories: { enabled: false, code: "" },
      articlePage: { enabled: false, code: "" },
      mobileFeed: { enabled: false, code: "" },
    }),
});

export type AdSettings = z.infer<typeof adSettingsSchema>;

export const DEFAULT_AD_SETTINGS: AdSettings = adSettingsSchema.parse({});

export const aiSettingsSchema = z.object({
  provider: z.enum(["none", "ollama"]).default("none"),
  baseUrl: z.string().max(500).default("http://localhost:11434"),
  model: z.string().max(200).default("llama3.1"),
});

export type AiSettings = z.infer<typeof aiSettingsSchema>;
