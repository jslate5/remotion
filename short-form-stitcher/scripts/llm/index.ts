import { createOpenAIProvider } from "./openai";
import { createAnthropicProvider } from "./anthropic";
import { createGeminiProvider } from "./gemini";

export type LlmCompleteOptions = {
  system: string;
  user: string;
  jsonMode?: boolean;
};

export interface LlmProvider {
  name: string;
  complete(options: LlmCompleteOptions): Promise<string>;
}

export const getLlmProvider = (): LlmProvider => {
  const providerName = (process.env.LLM_PROVIDER ?? "openai").toLowerCase();

  switch (providerName) {
    case "openai":
      return createOpenAIProvider();
    case "anthropic":
    case "claude":
      return createAnthropicProvider();
    case "gemini":
    case "google":
      return createGeminiProvider();
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${providerName}". Supported: openai, anthropic, gemini.`,
      );
  }
};
