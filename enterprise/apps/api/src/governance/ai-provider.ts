import { Injectable, Logger } from "@nestjs/common";

import { serviceUnavailable } from "../problem.js";

export interface AiProviderInput {
  readonly context: readonly { readonly excerpt: string; readonly title: string }[];
  readonly query: string;
}

export interface AiProvider {
  complete(input: AiProviderInput): Promise<{ readonly answer: string }>;
}

/** OpenAI 兼容 HTTP provider；凭据只来自运行时环境，不进入数据库、日志或请求正文审计。 */
@Injectable()
export class HttpAiProvider implements AiProvider {
  readonly #logger = new Logger("HttpAiProvider");

  async complete(input: AiProviderInput): Promise<{ readonly answer: string }> {
    const endpoint = process.env.SINGULARITY_AI_BASE_URL;
    const apiKey = process.env.SINGULARITY_AI_API_KEY;
    const model = process.env.SINGULARITY_AI_MODEL;
    if (endpoint === undefined || apiKey === undefined || model === undefined) {
      const error = new Error("Authorized AI provider is not configured");
      this.#logger.error({ error, event: "ai.provider", outcome: "unavailable" });
      throw serviceUnavailable({ cause: error });
    }
    try {
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
        body: JSON.stringify({
          messages: [
            { content: "只根据提供的知识片段回答，并保持简洁。", role: "system" },
            { content: `${input.context.map((item) => `[${item.title}] ${item.excerpt}`).join("\n")}\n\n问题：${input.query}`, role: "user" },
          ],
          model,
          temperature: 0,
        }),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      if (!response.ok) {
        throw new Error(`AI provider returned HTTP ${response.status}`);
      }
      const answer = payload.choices?.[0]?.message?.content;
      if (typeof answer !== "string" || answer.trim().length === 0) {
        throw new Error("AI provider returned an empty answer");
      }
      return { answer: answer.trim() };
    } catch (error) {
      this.#logger.error({ error, event: "ai.provider", outcome: "failed" });
      if (error instanceof Error && error.name === "ApiProblemError") {
        throw error;
      }
      throw serviceUnavailable({ cause: error });
    }
  }
}
