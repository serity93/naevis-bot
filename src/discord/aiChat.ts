import { MessageType, type Message } from "discord.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { generateChatReply } from "../core/ai/chatService.js";
import { clearHistory, historyKey } from "../core/ai/history.js";
import { BUSY_REPLY, ERROR_REPLY } from "../core/ai/persona.js";

// Empty allowlist means anywhere the bot can see, matching how
// TWITCH_WATCHTIME_IGNORED_USERS treats empty as "nobody excluded".
const allowedChannels = new Set(config.DISCORD_AI_CHANNELS);

// Discord shows a typing indicator for about ten seconds per call, so a
// generation that queues behind another easily outlives one. Refreshed a
// little under that.
const TYPING_REFRESH_MS = 8000;

// Only fires on a message that is nothing but a reset phrase once the bot
// mention is stripped. Someone saying "forget it" mid-sentence isn't asking
// for a reset, and matching them would make the memory feel randomly lossy.
const RESET_PHRASE = /^(?:forget|reset|start over|nevermind|never mind)(?: it| that| everything)?[.!]?$/i;

/**
 * Reply in persona when the bot is mentioned or replied to.
 *
 * Called fire-and-forget from the MessageCreate handler: this runs on the
 * gateway's event loop, and a ten-second generation awaited there would stall
 * every other event behind it.
 */
export async function maybeHandleAiChat(message: Message, botUserId: string): Promise<void> {
  if (!config.AI_ENABLED) return;

  // Three loop guards, because they fail differently. author.bot catches other
  // bots and ourselves; the explicit self-check survives a future where the bot
  // posts through something not flagged as a bot; webhookId catches relayed or
  // proxied messages carrying someone else's identity. A bot answering a bot is
  // a token bonfire on a 4GB GPU.
  if (message.author.bot) return;
  if (message.author.id === botUserId) return;
  if (message.webhookId) return;
  if (message.system) return;

  // DMs would need the DirectMessages intent plus Partials.Channel to arrive
  // at all, and carry no channel allowlist to gate them. Out of scope.
  if (!message.inGuild()) return;
  if (allowedChannels.size > 0 && !allowedChannels.has(message.channelId)) return;

  // mentions.users, not mentions.has(): the latter is also true for @everyone
  // and for any role the bot happens to hold, which would turn every
  // server-wide announcement into a generation request.
  const mentioned = message.mentions.users.has(botUserId);

  let repliedToBot = false;
  let priorAssistantTurn: string | null = null;
  if (message.type === MessageType.Reply && message.reference?.messageId) {
    // fetchReference is a REST call when the parent isn't cached, so it stays
    // behind the type check rather than running on every message in the guild.
    const parent = await message.fetchReference().catch(() => null);
    if (parent?.author.id === botUserId) {
      repliedToBot = true;
      priorAssistantTurn = parent.content;
    }
  }

  if (!mentioned && !repliedToBot) return;

  const text = stripMentions(message.content);

  if (text.length === 0) {
    // The message reached us but Discord stripped its text. That happens when
    // the MessageContent privileged intent isn't enabled in the Developer
    // Portal and the reply had its ping toggled off — Discord only guarantees
    // content for messages that actually mention the bot. Nothing useful can
    // be done with an empty prompt, so this is a debug line rather than a
    // reply nobody asked for.
    logger.debug(
      { messageId: message.id, repliedToBot },
      "Message for the bot arrived with no readable content — is the MessageContent intent enabled?",
    );
    return;
  }

  const key = historyKey("discord", message.channelId);

  if (RESET_PHRASE.test(text)) {
    // Handled before generation, not after: asking the model to say goodbye to
    // its own memory would cost five seconds of GPU time for a fixed string.
    const cleared = clearHistory(key);
    await message.reply({
      content: cleared
        ? "Okay, I've forgotten what we were talking about — fresh start!"
        : "I wasn't remembering anything in here anyway.",
      allowedMentions: { parse: [], repliedUser: true },
    });
    return;
  }

  // Started before the queue slot is acquired, so someone waiting behind
  // another generation sees the bot is alive rather than nothing at all.
  const stopTyping = startTyping(message);

  try {
    const outcome = await generateChatReply({
      platform: "discord",
      channelId: message.channelId,
      userKey: `discord:${message.author.id}`,
      authorName: message.member?.displayName ?? message.author.username,
      text,
      priorAssistantTurn,
    });

    if (outcome.status === "skipped") return;

    const content =
      outcome.status === "ok" ? outcome.text : outcome.status === "busy" ? BUSY_REPLY : ERROR_REPLY;

    await message.reply({
      content,
      // The real defence against the model being talked into pinging the
      // server. parse: [] disables every mention type on this message, so even
      // if the text still contains @everyone it renders as inert. repliedUser
      // keeps the ordinary reply ping to the person who asked.
      allowedMentions: { parse: [], repliedUser: true },
    });
  } finally {
    stopTyping();
  }
}

/**
 * Keep the typing indicator alive until the returned function is called.
 *
 * Chained setTimeout rather than setInterval, matching twitch/watchtime.ts: a
 * slow REST call delays the next refresh instead of stacking another on top of
 * it.
 */
// Message<true> rather than Message: inGuild() has already narrowed it by the
// time this is called, and a guild message's channel is the one that is
// guaranteed to support sendTyping.
function startTyping(message: Message<true>): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const send = () => {
    if (stopped) return;
    message.channel.sendTyping().catch((err: unknown) => {
      // A failed indicator is cosmetic — the reply itself still lands — so it
      // is not worth escalating past debug.
      logger.debug({ err }, "Failed to send Discord typing indicator");
    });
    timer = setTimeout(send, TYPING_REFRESH_MS);
  };
  send();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Drop the mentions used to address the bot. Leaving raw "<@123456> hi" in the
 * prompt teaches a small model to echo id syntax back at chat.
 */
function stripMentions(content: string): string {
  return content
    .replace(/<@[!&]?\d+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
