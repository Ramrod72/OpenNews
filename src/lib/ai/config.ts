import { prisma } from "@/lib/db";

export interface AiConfig {
  provider: "none" | "ollama";
  baseUrl: string;
  model: string;
}

const DEFAULT_CONFIG: AiConfig = {
  provider: "none",
  baseUrl: "http://localhost:11434",
  model: "llama3.1",
};

/**
 * AI is entirely optional. Configuration can come from the admin panel
 * (stored in AdminSetting, takes precedence so it's changeable without a
 * redeploy) or from environment variables as a deployment-time default.
 * With nothing configured, the app never calls out to any model.
 */
export async function getAiConfig(): Promise<AiConfig> {
  try {
    const row = await prisma.adminSetting.findUnique({ where: { key: "ai" } });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<AiConfig>;
      return { ...DEFAULT_CONFIG, ...envDefaults(), ...parsed };
    }
  } catch {
    // DB not reachable / not yet migrated — fall through to env defaults.
  }
  return envDefaults();
}

function envDefaults(): AiConfig {
  const provider = process.env.AI_PROVIDER === "ollama" ? "ollama" : "none";
  return {
    provider,
    baseUrl: process.env.AI_BASE_URL || DEFAULT_CONFIG.baseUrl,
    model: process.env.AI_MODEL || DEFAULT_CONFIG.model,
  };
}
