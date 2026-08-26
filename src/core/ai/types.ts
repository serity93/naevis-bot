// The narrow surface every AI backend has to satisfy. It is deliberately the
// smallest thing Ollama, a hosted API, or a hand-written stub can all
// implement — the point is that swapping the backend later is one new file
// plus one arm in the switch in chatService, not a rewrite of the trigger and
// persona code that sits on top of it.

export type AiRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface AiCompletionRequest {
  // Fully assembled by the caller: system prompt first, then the turns.
  // Providers must not append, reorder or reinterpret these. Everything
  // persona-related is decided upstream in chatService so that changing
  // providers can never quietly change who the bot is.
  messages: AiMessage[];
  // A cap on generated length, not a guarantee. Post-processing still
  // truncates, because tokens and characters aren't the same currency and the
  // platform limits are counted in characters.
  maxOutputTokens: number;
  // Owned by the caller. Providers hand it to fetch and let the abort surface
  // as a rejection; they never invent a timeout of their own.
  signal: AbortSignal;
}

export interface AiCompletionResult {
  text: string;
  // Telemetry for logging only. Nothing branches on these, so a provider that
  // can't supply them is still a valid provider.
  promptTokens?: number;
  outputTokens?: number;
  // Wall-clock for the whole request, including transport.
  durationMs?: number;
  // Time spent generating, excluding prompt evaluation and transport. Kept
  // separate from durationMs because outputTokens/durationMs is not the
  // generation rate — on a long prompt the two differ by several times over,
  // and that rate is what tells you whether the GPU is being used at all.
  generationMs?: number;
  // Time spent evaluating the prompt before the first token came out. The
  // dominant cost when the conversation buffer is full.
  promptEvalMs?: number;
}

export interface AiProbeResult {
  ok: boolean;
  detail: string;
  // Set when the failure won't fix itself — an unpulled model, a bad base URL.
  // Mirrors the permanent-disable flag in twitch/watchtime.ts: the caller
  // latches off rather than logging the same failure on every mention.
  permanent?: boolean;
}

export interface AiProvider {
  readonly name: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
  // Cheap reachability plus model-present check, run once at startup so a
  // misconfiguration is diagnosed in the logs instead of being discovered by
  // whoever mentions the bot first.
  probe(signal: AbortSignal): Promise<AiProbeResult>;
}
