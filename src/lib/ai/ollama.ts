import type { AiConfig } from "./config";

const TIMEOUT_MS = 8000;

/**
 * Minimal client for an Ollama-compatible /api/generate endpoint. Works
 * with a local Ollama install or any self-hosted server implementing the
 * same API — no API key, no paid service required.
 *
 * Unlike feed URLs, `config.baseUrl` is operator-configured (admin panel or
 * env var), not attacker-supplied, and is commonly a localhost/private
 * address by design (a local Ollama install) — so it intentionally isn't
 * run through the public-URL SSRF guard used for feed content.
 */
export async function callOllama(config: AiConfig, prompt: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        prompt,
        stream: false,
        options: { temperature: 0.2 },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    return data.response?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
