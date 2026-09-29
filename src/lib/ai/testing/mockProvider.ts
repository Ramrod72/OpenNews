import type { AIProvider, AIProviderRequest, AIProviderResponse } from "@/lib/ai/provider";

/**
 * Deterministic AIProvider test double. No test in this repo depends on a
 * live provider — every Phase 11B behavior (validation, quota, caching,
 * dedup, injection defenses) is exercised against this mock instead, which
 * lets a test dictate exactly what "the model" returns, including hostile
 * or malformed output, without any network call.
 */
export interface MockProviderOptions {
  name?: string;
  model?: string;
  /** Called once per generateStructured() invocation. Return a fixed AIProviderResponse, or throw to simulate an unexpected provider crash. */
  respond: (
    request: AIProviderRequest,
    callIndex: number,
  ) => AIProviderResponse | Promise<AIProviderResponse>;
}

export interface MockProvider extends AIProvider {
  readonly calls: AIProviderRequest[];
}

export function createMockProvider(options: MockProviderOptions): MockProvider {
  const calls: AIProviderRequest[] = [];
  let callIndex = 0;

  return {
    name: options.name ?? "mock",
    model: options.model ?? "mock-model",
    calls,
    async generateStructured(request: AIProviderRequest): Promise<AIProviderResponse> {
      calls.push(request);
      const index = callIndex++;
      return options.respond(request, index);
    },
  };
}

/** Convenience: a mock that always returns the same fixed response. */
export function createFixedMockProvider(
  response: AIProviderResponse,
  overrides: Partial<Pick<MockProviderOptions, "name" | "model">> = {},
): MockProvider {
  return createMockProvider({ ...overrides, respond: () => response });
}
