/**
 * Phase 11B's narrow provider abstraction. Product/orchestration code
 * (src/lib/ai/storyBrief/generate.ts) depends only on this interface, never
 * on a specific vendor SDK or HTTP shape — so a future provider (a real
 * cloud vendor, a different self-hosted server) is a new implementation of
 * `AIProvider`, not a change to the orchestrator, the validation pipeline,
 * or the caching/quota logic.
 *
 * `systemInstructions` and `data` are passed SEPARATELY on purpose — never
 * concatenated into one string by the caller. It is each AIProvider
 * implementation's responsibility to keep them structurally distinct in
 * whatever way its own API supports (e.g. a chat API's system/user message
 * roles), never falling back to naive string concatenation. See
 * src/lib/ai/storyBrief/prompt.ts's own doc comment for the full
 * prompt-injection rationale.
 */

export interface AIProviderRequest {
  /** Safety/formatting instructions the model must follow. Never contains any publisher-derived text. */
  systemInstructions: string;
  /** The bounded, already-safe structured input (see storyBrief/input.ts) — untrusted publisher-derived text lives inside this, never inside systemInstructions. */
  data: unknown;
  /** Hard ceiling on the raw response text this provider implementation will accept before treating it as oversized. */
  maxOutputChars: number;
  /** Abort the request if the provider hasn't responded within this many milliseconds. */
  timeoutMs: number;
}

export type AIProviderFailureReason =
  "timeout" | "network_error" | "provider_error" | "empty_response" | "oversized_response";

export interface AIProviderSuccess {
  ok: true;
  /** Raw text the provider returned — NOT yet parsed/validated as the story-brief schema. That happens in storyBrief/schema.ts, independent of which provider produced this text. */
  raw: string;
}

export interface AIProviderFailure {
  ok: false;
  reason: AIProviderFailureReason;
  detail?: string;
}

export type AIProviderResponse = AIProviderSuccess | AIProviderFailure;

export interface AIProvider {
  /** Stable identifier persisted alongside a generated artifact (AiStoryBrief.provider) — e.g. "ollama". */
  readonly name: string;
  /** Model identifier persisted alongside a generated artifact (AiStoryBrief.model) — e.g. "llama3.1". */
  readonly model: string;
  generateStructured(request: AIProviderRequest): Promise<AIProviderResponse>;
}
