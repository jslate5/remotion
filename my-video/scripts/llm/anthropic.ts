import type { LlmProvider } from "./index";

// Stub: install @anthropic-ai/sdk and flesh this out when you want to use Claude.
// The interface contract is: return a string response. When jsonMode is true,
// the response body MUST be a JSON object (enforce via the system prompt).
export const createAnthropicProvider = (): LlmProvider => {
  throw new Error(
    "Anthropic provider not implemented yet. Install @anthropic-ai/sdk and wire it up in scripts/llm/anthropic.ts, or set LLM_PROVIDER=openai.",
  );
};
