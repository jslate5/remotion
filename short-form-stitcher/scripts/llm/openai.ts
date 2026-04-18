import OpenAI from "openai";
import type { LlmProvider, LlmCompleteOptions } from "./index";

export const createOpenAIProvider = (): LlmProvider => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to my-video/.env (see .env.example).",
    );
  }

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  return {
    name: `openai:${model}`,
    async complete({ system, user, jsonMode }: LlmCompleteOptions) {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: jsonMode ? { type: "json_object" } : undefined,
        temperature: 0.8,
      });

      const text = response.choices[0]?.message?.content;
      if (!text) {
        throw new Error("OpenAI returned an empty response.");
      }
      return text;
    },
  };
};
