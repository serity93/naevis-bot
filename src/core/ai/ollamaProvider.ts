import { z } from "zod";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import type { AiCompletionRequest, AiCompletionResult, AiProbeResult, AiProvider } from "./types.js";

// The one file that knows Ollama's HTTP shape. Everything Ollama-specific —
// the endpoint, the options block, keep_alive, the response envelope — stops
// here, so a different backend is a sibling file rather than a refactor.

// Parsed rather than cast. A cast would turn a malformed response into a
// TypeError thrown deep inside a fire-and-forget message handler, where the
// stack says nothing about the actual problem.
const chatResponseSchema = z.object({
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  // Both are nanoseconds, which is why they get divided rather than passed
  // through. eval_duration covers generation only; prompt_eval_duration covers
  // the pass over the prompt before the first token appears.
  eval_duration: z.number().optional(),
  prompt_eval_duration: z.number().optional(),
});

const NS_PER_MS = 1e6;

function nsToMs(ns: number | undefined): number | undefined {
  return ns === undefined ? undefined : ns / NS_PER_MS;
}

const tagsResponseSchema = z.object({
  models: z.array(z.object({ name: z.string() })),
});

export function createOllamaProvider(): AiProvider {
  const baseUrl = config.AI_BASE_URL.replace(/\/+$/, "");

  return {
    name: "ollama",

    async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
      const startedAt = Date.now();

      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: request.signal,
        body: JSON.stringify({
          model: config.AI_MODEL,
          messages: request.messages,
          // No streaming: chat platforms post a whole message at a time, so
          // token-by-token delivery would only mean reassembling it here.
          stream: false,
          // The single most important setting on modest hardware. Ollama
          // evicts the model after 5 minutes by default, and reloading it
          // costs 5-15 seconds that whoever mentioned the bot next pays for.
          keep_alive: config.AI_KEEP_ALIVE,
          options: {
            temperature: 0.8,
            top_p: 0.9,
            // Bounds the worst case. Post-processing truncates by characters
            // anyway, so this is purely a latency guard against the model
            // deciding to write an essay.
            num_predict: request.maxOutputTokens,
            // Sized for the system prompt plus a full conversation buffer with
            // slack. Raising it is not free: KV cache lives in VRAM, and on a
            // 4GB card the spare room runs out into a partial CPU offload.
            num_ctx: 4096,
            repeat_penalty: 1.1,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new OllamaHttpError(response.status, body);
      }

      const parsed = chatResponseSchema.parse(await response.json());

      return {
        text: parsed.message.content,
        promptTokens: parsed.prompt_eval_count,
        generationMs: nsToMs(parsed.eval_duration),
        promptEvalMs: nsToMs(parsed.prompt_eval_duration),
        outputTokens: parsed.eval_count,
        durationMs: Date.now() - startedAt,
      };
    },

    async probe(signal: AbortSignal): Promise<AiProbeResult> {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/api/tags`, { signal });
      } catch (err) {
        // A fetch rejection here is Ollama being unreachable, which does fix
        // itself when the service comes back — so it stays retryable.
        return { ok: false, detail: `cannot reach Ollama at ${baseUrl}: ${describeError(err)}` };
      }

      if (!response.ok) {
        return { ok: false, detail: `Ollama returned HTTP ${response.status} from /api/tags` };
      }

      const parsed = tagsResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        return { ok: false, detail: "Ollama returned an unrecognised /api/tags response" };
      }

      const names = parsed.data.models.map((m) => m.name);
      if (!names.includes(config.AI_MODEL)) {
        // An unpulled model never fixes itself, so the caller latches off
        // rather than rediscovering this on every mention.
        return {
          ok: false,
          permanent: true,
          detail: `model ${config.AI_MODEL} is not pulled — run: ollama pull ${config.AI_MODEL}`,
        };
      }

      return { ok: true, detail: `${config.AI_MODEL} ready at ${baseUrl}` };
    },
  };
}

/** A non-2xx from Ollama, carrying the status so callers can tell 404 apart. */
export class OllamaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Ollama returned HTTP ${status}`);
    this.name = "OllamaHttpError";
  }
}

/**
 * Classify a failure so the logs distinguish the three cases that look alike
 * from the outside but need completely different responses: the model was too
 * slow, the model isn't there, and Ollama isn't running. Conflating them makes
 * the logs useless at exactly the moment someone is reading them.
 */
export function classifyAiError(err: unknown): {
  kind: "timeout" | "missing-model" | "unreachable" | "unknown";
  permanent: boolean;
  message: string;
} {
  // fetch signals an aborted request with a DOMException named AbortError.
  // This is the repo's first use of AbortController, so it is worth being
  // explicit that this is a deliberate cancellation, not a network fault.
  if (err instanceof Error && err.name === "AbortError") {
    return { kind: "timeout", permanent: false, message: "generation exceeded AI_TIMEOUT_MS" };
  }

  if (err instanceof OllamaHttpError) {
    if (err.status === 404) {
      return {
        kind: "missing-model",
        permanent: true,
        message: `model ${config.AI_MODEL} is not pulled — run: ollama pull ${config.AI_MODEL}`,
      };
    }
    return { kind: "unknown", permanent: false, message: `Ollama returned HTTP ${err.status}` };
  }

  // A bare TypeError from fetch is a connection failure.
  if (err instanceof TypeError) {
    return {
      kind: "unreachable",
      permanent: false,
      message: `cannot reach Ollama at ${config.AI_BASE_URL}`,
    };
  }

  return { kind: "unknown", permanent: false, message: describeError(err) };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ask Ollama to load the model without generating anything, so the first real
 * mention doesn't pay the load cost. Best-effort: a failure here is logged and
 * forgotten, because the probe has already reported anything worth acting on.
 */
export async function prewarm(signal: AbortSignal): Promise<void> {
  const baseUrl = config.AI_BASE_URL.replace(/\/+$/, "");
  try {
    // An empty messages array is Ollama's documented way to load a model and
    // return immediately.
    await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ model: config.AI_MODEL, messages: [], keep_alive: config.AI_KEEP_ALIVE }),
    });
    logger.info({ model: config.AI_MODEL }, "AI model pre-warmed");
  } catch (err) {
    logger.warn({ err }, "AI model pre-warm failed, the first reply will be slower");
  }
}
