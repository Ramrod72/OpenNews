import { createHash } from "node:crypto";
import type { AiStoryBriefInput } from "./input";

/**
 * Deterministic SHA-256 of the EXACT bounded input the model would see —
 * never a hash of raw DB rows. This is what makes the cache (AiStoryBrief
 * table) self-invalidating: whenever a new article's claims/headline
 * change the claim groups, source overlap, or headline comparison, the
 * input object changes, so this fingerprint changes, so the next request
 * naturally misses the cache and regenerates — no explicit invalidation
 * logic needed anywhere else (see ARCHITECTURE.md's Phase 11B section).
 *
 * `JSON.stringify` on this input is stable because every array here is
 * already built in a fixed, deterministic order (see input.ts) and every
 * object has a fixed key set — no key-order-dependent Map/Set iteration
 * reaches this function.
 */
export function fingerprintAiStoryBriefInput(input: AiStoryBriefInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
