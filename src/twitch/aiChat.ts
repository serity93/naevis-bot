import type { ChatClient, ChatMessage } from "@twurple/chat";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { generateChatReply } from "../core/ai/chatService.js";
import { clearHistory, historyKey } from "../core/ai/history.js";
import { BUSY_REPLY, ERROR_REPLY } from "../core/ai/persona.js";

// Reuses the watchtime ignore list rather than adding a second one. It already
// means "other bots parked in the channel", which is exactly the set that must
// never trigger a generation.
const ignoredLogins = new Set(config.TWITCH_WATCHTIME_IGNORED_USERS);

const RESET_PHRASE = /^(?:forget|reset|start over|nevermind|never mind)(?: it| that| everything)?[.!]?$/i;

export interface TwitchAiChatContext {
  chatClient: ChatClient;
  botLogin: string;
  botUserId: string;
  channel: string;
  text: string;
  msg: ChatMessage;
}

/**
 * Reply in persona when the bot is addressed by name or replied to in chat.
 *
 * Unlike Discord, Twurple hands over the full message text unconditionally and
 * ChatMessage already carries the parent message's author and text, so both
 * triggers work with no extra API call.
 */
export async function maybeHandleTwitchAiChat(ctx: TwitchAiChatContext): Promise<void> {
  if (!config.AI_ENABLED || !config.TWITCH_AI_ENABLED) return;

  const { chatClient, botLogin, botUserId, channel, text, msg } = ctx;

  if (msg.userInfo.userId === botUserId) return;
  if (ignoredLogins.has(msg.userInfo.userName.toLowerCase())) return;

  // Commands are not conversation. Without this, replying to one of the bot's
  // messages with "!ping" would satisfy the reply trigger below and produce an
  // AI reply alongside the command's own — this handler runs before the prefix
  // check in client.ts precisely so it can see non-command messages, which
  // means it also has to decline the command ones itself.
  if (text.startsWith(config.TWITCH_COMMAND_PREFIX)) return;

  const addressed = addressPattern(botLogin).test(text);
  const repliedToBot = msg.parentMessageUserId === botUserId;
  if (!addressed && !repliedToBot) return;

  const prompt = stripBotName(text, botLogin);
  if (prompt.length === 0) return;

  const channelName = channel.replace(/^#/, "");
  const key = historyKey("twitch", channelName);

  const reply = async (replyText: string) => {
    await chatClient.say(channel, replyText, { replyTo: msg.id });
  };

  if (RESET_PHRASE.test(prompt)) {
    const cleared = clearHistory(key);
    await reply(
      cleared
        ? "Okay, I've forgotten what we were talking about — fresh start!"
        : "I wasn't remembering anything in here anyway.",
    );
    return;
  }

  const outcome = await generateChatReply({
    platform: "twitch",
    channelId: channelName,
    userKey: `twitch:${msg.userInfo.userId}`,
    authorName: msg.userInfo.displayName,
    text: prompt,
    priorAssistantTurn: repliedToBot ? msg.parentMessageText : null,
  });

  if (outcome.status === "skipped") return;

  // Twitch has no typing indicator, so silence here is indistinguishable from
  // the bot being down — which is why "busy" and "error" say something instead
  // of returning quietly the way a cooldown does.
  if (outcome.status === "busy") {
    await reply(BUSY_REPLY);
    return;
  }
  if (outcome.status === "error") {
    await reply(ERROR_REPLY);
    return;
  }

  await reply(outcome.text);
  logger.debug({ channel: channelName, user: msg.userInfo.userName }, "Sent Twitch AI reply");
}

// Built once per login rather than per message. This handler is called for
// every line in chat — that is the point of it sitting ahead of the command
// prefix check — so allocating two regexes per message would be paid on the
// entire channel's traffic, not just on the messages meant for the bot.
//
// Word boundary so the name inside a URL or a longer word doesn't count. The @
// is optional because chat rarely bothers with it.
const patternCache = new Map<string, { address: RegExp; strip: RegExp }>();

function patternsFor(botLogin: string) {
  let cached = patternCache.get(botLogin);
  if (!cached) {
    const name = escapeRegExp(botLogin);
    cached = {
      address: new RegExp(`(?:^|\\s)@?${name}\\b`, "i"),
      strip: new RegExp(`(?:^|\\s)@?${name}\\b[,:]?`, "gi"),
    };
    patternCache.set(botLogin, cached);
  }
  return cached;
}

function addressPattern(botLogin: string): RegExp {
  return patternsFor(botLogin).address;
}

/** Drop the leading address so the prompt is just what was actually said. */
function stripBotName(text: string, botLogin: string): string {
  // lastIndex has to be reset because the strip pattern is global and reused
  // across messages; a leftover offset would skip the start of the next one.
  const strip = patternsFor(botLogin).strip;
  strip.lastIndex = 0;
  return text.replace(strip, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
