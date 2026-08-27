/**
 * HTTP Model Caller — bridges the pure `ModelCaller` seam (domain/orchestration)
 * to OmniRoute's own OpenAI-compatible endpoint.
 *
 * Deliberately goes through the SAME `/v1/chat/completions` surface every
 * external client (Cline, Cursor, etc.) uses, rather than reaching into
 * `handleChatCore`/`handleComboChat` directly — those assume a live `Request`
 * object and combo/task-aware-routing context that only exists mid-HTTP-request.
 * Routing through the public endpoint keeps this seam simple, keeps auth/
 * quota/circuit-breaker/fallback logic centralized in one place, and matches
 * how every other client integration in this codebase talks to OmniRoute.
 *
 * @module lib/orchestration/modelCaller
 */

import type { ModelCaller } from "@/domain/orchestration/types";

export interface HttpModelCallerOptions {
  /** e.g. "http://127.0.0.1:20128" — no trailing slash. */
  baseUrl: string;
  /** OmniRoute-issued API key with permission to call the target models. */
  apiKey: string;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Build a `ModelCaller` that dispatches through OmniRoute's own OpenAI-compatible
 * endpoint. Non-streaming only — orchestration subtasks consume the full text,
 * not a live stream (matches the buffered stage-executor pattern already used
 * by `open-sse/services/autoCombo/pipelineRouter.ts`).
 */
export function createHttpModelCaller(options: HttpModelCallerOptions): ModelCaller {
  const { baseUrl, apiKey, timeoutMs = 120_000 } = options;

  return async ({ model, systemPrompt, userPrompt, signal }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort);

    const start = Date.now();
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Model call failed (${res.status}) for ${model}: ${text.slice(0, 500)}`);
      }

      const json = (await res.json()) as ChatCompletionResponse;
      const text = json.choices?.[0]?.message?.content ?? "";
      return {
        text,
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
        latencyMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  };
}
