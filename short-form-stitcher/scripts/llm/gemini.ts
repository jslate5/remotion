import type { LlmProvider } from "./index";

// Stub: install @google/genai and flesh this out when you want to use Gemini.
// The interface contract is: return a string response. When jsonMode is true,
// the response body MUST be a JSON object (enforce via the system prompt).
export const createGeminiProvider = (): LlmProvider => {
  throw new Error(
    "Gemini provider not implemented yet. Install @google/genai and wire it up in scripts/llm/gemini.ts, or set LLM_PROVIDER=openai.",
  );
};
