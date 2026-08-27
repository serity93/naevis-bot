import { config } from "../../config.js";
import { logger } from "../../logger.js";
import type { Platform } from "../commands/types.js";
import { getHistory, historyKey, recordExchange } from "./history.js";
import { acquireSlot, queueDepth, takeCooldownSlot } from "./limits.js";
import { classifyAiError, createOllamaProvider, prewarm } from "./ollamaProvider.js";
import { SYSTEM_PROMPT } from "./persona.js";
import { postProcessReply, sanitizeName, sanitizeUserText, truncateAtBoundary } from "./sanitize.js";
import type { AiMessage, AiProvider } from "./types.js";

let provider: AiProvider | null = null;

// Latched when the failure is one that never fixes itself — an unpulled model,
// a base URL pointing nowhere. Same posture as the per-channel disable in
// twitch/watchtime.ts: stop asking rather than logging an identical failure on
// every single mention and burying the one line that says how to fix it.
let permanentlyDisabled = false;
let disabledReason = "";

function getProvider(): AiProvider {
  if (!provider) {
    // A switch rather than a registry map: there is one provider today, and
    // the compiler's exhaustiveness check on the config enum is worth more
    // than the indirection would be.
    switch (config.AI_PROVIDER) {
      case "ollama":
        provider = createOllamaProvider();
        break;
    }
  }
  return provider;
}

export interface ChatRequest {
  platform: Platform;
  channelId: string;
  /** Namespaced "platform:externalId" — the cooldown key, not a database id. */
  userKey: string;
  authorName: string;
  text: string;
  /**
   * The bot's own message being replied to, when there is one. Used only if it
   * isn't already the tail of the channel buffer, which covers someone
   * replying to an older message the buffer has since evicted.
   */
  priorAssistantTurn?: string | null;
}

export type ChatOutcome =
  | { status: "ok"; text: string }
  | { status: "busy" }
  | { status: "error" }
  // Silently dropped. The caller posts nothing at all — a cooldown that
  // announced itself would be noisier than the messages it is suppressing.
  | { status: "skipped"; reason: "disabled" | "cooldown" | "empty" };

/**
 * Gate, prompt, generate, post-process. Platform adapters hand in plain data
 * and get back either a string to post or a reason not to; nothing in here
 * touches discord.js or Twurple, and nothing in here touches Prisma.
 */
export async function generateChatReply(request: ChatRequest): Promise<ChatOutcome> {
  if (!config.AI_ENABLED || permanentlyDisabled) return { status: "skipped", reason: "disabled" };

  const text = sanitizeUserText(request.text);
  if (text.length === 0) return { status: "skipped", reason: "empty" };

  if (!takeCooldownSlot(request.userKey)) {
    logger.debug({ userKey: request.userKey }, "AI reply skipped, user is on cooldown");
    return { status: "skipped", reason: "cooldown" };
  }

  const key = historyKey(request.platform, request.channelId);
  const name = sanitizeName(request.authorName);
  const userTurn = `${name}: ${text}`;
  const messages = buildMessages(key, userTurn, request.priorAssistantTurn ?? null);

  // The clock starts here, not once the GPU slot is free. Someone queued
  // behind two others should still get an answer or a failure inside one
  // AI_TIMEOUT_MS rather than waiting out everyone else's timeout first.
  const deadline = Date.now() + config.AI_TIMEOUT_MS;

  const release = await acquireSlot(deadline);
  if (!release) {
    logger.debug({ queueDepth: queueDepth() }, "AI reply refused, generation queue is full");
    return { status: "busy" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));

  try {
    const result = await getProvider().complete({
      messages,
      maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
      signal: controller.signal,
    });

    const reply = postProcessReply(result.text, request.platform);

    // Record what chat actually saw, not the raw output, so a later reply
    // referring back to "what I said" refers to something that was posted.
    recordExchange(key, userTurn, reply);

    logger.debug(
      {
        platform: request.platform,
        promptTokens: result.promptTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        replyChars: reply.length,
      },
      "AI reply generated",
    );

    return { status: "ok", text: reply };
  } catch (err) {
    const { kind, permanent, message } = classifyAiError(err);

    if (permanent) {
      permanentlyDisabled = true;
      disabledReason = message;
      logger.error({ err, kind }, `AI chat is now off: ${message}`);
    } else {
      logger.error({ err, kind }, `AI generation failed: ${message}`);
    }

    // Nothing is written to the buffer on failure. A question with no answer
    // in the history teaches the model that questions go unanswered.
    return { status: "error" };
  } finally {
    clearTimeout(timer);
    release();
  }
}

function buildMessages(key: string, userTurn: string, priorAssistantTurn: string | null): AiMessage[] {
  const messages: AiMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  const history = getHistory(key);
  messages.push(...history);

  // The buffer normally already ends with the bot's last message, so pushing
  // the reply target as well would duplicate it. It earns its place only when
  // someone replies to an older message that the buffer has since dropped.
  const tail = history[history.length - 1];
  const alreadyPresent = tail?.role === "assistant" && tail.content === priorAssistantTurn;
  if (priorAssistantTurn && !alreadyPresent) {
    messages.push({ role: "assistant", content: truncateAtBoundary(priorAssistantTurn, 400) });
  }

  messages.push({ role: "user", content: userTurn });
  return messages;
}

/** Exposed for the smoke script, which needs to inspect the assembled prompt. */
export { buildMessages as buildMessagesForTesting };

/**
 * Check the provider once at startup and load the model. Fire-and-forget from
 * index.ts: a misconfigured or absent Ollama must not stop the bot connecting
 * to Discord and Twitch, so the worst outcome here is that AI chat is off and
 * the logs say why.
 */
export async function initAiChat(): Promise<void> {
  if (!config.AI_ENABLED) {
    logger.info("AI chat is disabled (set AI_ENABLED=true to turn it on)");
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const probe = await getProvider().probe(controller.signal);
    if (!probe.ok) {
      if (probe.permanent) {
        permanentlyDisabled = true;
        disabledReason = probe.detail;
      }
      logger.warn({ permanent: probe.permanent === true }, `AI chat unavailable: ${probe.detail}`);
      return;
    }
    logger.info(`AI chat ready: ${probe.detail}`);
  } catch (err) {
    logger.warn({ err }, "AI chat probe failed, replies will be attempted anyway");
    return;
  } finally {
    clearTimeout(timer);
  }

  // Only worth doing once the probe says the model exists, and only after it,
  // so a missing model is reported as a missing model rather than as a slow
  // pre-warm.
  const warmController = new AbortController();
  const warmTimer = setTimeout(() => warmController.abort(), 120_000);
  await prewarm(warmController.signal).finally(() => clearTimeout(warmTimer));
}

/** Whether AI chat has latched off, and why. Used by the smoke script. */
export function aiChatStatus(): { disabled: boolean; reason: string } {
  return { disabled: permanentlyDisabled, reason: disabledReason };
}
