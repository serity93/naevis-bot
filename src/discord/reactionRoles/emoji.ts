import type { Guild, GuildEmoji, ReactionEmoji, ApplicationEmoji } from "discord.js";
import type { ReactionRolePair } from "../../core/reactionRoles/reactionRoleService.js";

// Built at runtime rather than as a literal: the v flag needs an ES2024 target
// for tsc to accept it in source, and Node 20 supports it regardless.
const SINGLE_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
const CUSTOM_EMOJI = /^<(a?):(\w{2,32}):(\d{17,20})>$/;
const EMOJI_NAME = /^:?(\w{2,32}):?$/;
const SNOWFLAKE = /^\d{17,20}$/;

// Discord sometimes reports a unicode reaction with the U+FE0F variation
// selector and sometimes without ("❤️" vs "❤"), depending on the client that
// added it. Matching on the stripped form makes both hit the same option.
function stripVariationSelector(text: string): string {
  return text.replace(/️/g, "");
}

export type ParsedEmoji = Omit<ReactionRolePair, "roleId">;

export type ParseEmojiResult = { ok: true; emoji: ParsedEmoji } | { ok: false; reason: string };

/**
 * Turn what an admin typed into the modal into a reactable emoji.
 *
 * Modal text inputs get no emoji autocomplete, so typing ":pepe:" arrives as
 * literal text. Server emoji are therefore accepted by name (with or without
 * colons) as well as in their raw <:name:id> form; unicode emoji have to be
 * pasted or picked from the OS emoji keyboard.
 */
export function parseEmojiInput(raw: string, guild: Guild): ParseEmojiResult {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: "No emoji given." };

  if (SINGLE_EMOJI.test(text)) {
    return { ok: true, emoji: { emojiKey: stripVariationSelector(text), emojiDisplay: text } };
  }

  const custom = CUSTOM_EMOJI.exec(text);
  if (custom) {
    const id = custom[3]!;
    // The bot can only react with custom emoji from servers it is in. Checked
    // here so the admin hears about it now, not as a failed publish later.
    const emoji = guild.client.emojis.cache.get(id);
    if (!emoji) {
      return {
        ok: false,
        reason: `I can't use ${text} — it belongs to a server I'm not in. Use an emoji from this server instead.`,
      };
    }
    return { ok: true, emoji: fromGuildEmoji(emoji) };
  }

  if (SNOWFLAKE.test(text)) {
    const emoji = guild.client.emojis.cache.get(text);
    if (emoji) return { ok: true, emoji: fromGuildEmoji(emoji) };
  }

  const named = EMOJI_NAME.exec(text);
  if (named) {
    const name = named[1]!.toLowerCase();
    // This server first, so a name shared with an emoji elsewhere resolves to
    // the one the admin can actually see in their picker.
    const emoji =
      guild.emojis.cache.find((e) => e.name?.toLowerCase() === name) ??
      guild.client.emojis.cache.find((e) => e.name?.toLowerCase() === name);
    if (emoji) return { ok: true, emoji: fromGuildEmoji(emoji) };
    return {
      ok: false,
      reason: `I couldn't find a server emoji called \`:${named[1]}:\`. For standard emoji, paste the emoji itself (e.g. 🎮) rather than its name.`,
    };
  }

  return {
    ok: false,
    reason:
      "That doesn't look like a single emoji. Paste one emoji (e.g. 🎮) or type a server emoji's name (e.g. :pepe:).",
  };
}

function fromGuildEmoji(emoji: GuildEmoji | ApplicationEmoji): ParsedEmoji {
  return { emojiKey: emoji.id, emojiDisplay: emoji.toString() };
}

/** The key a live reaction matches options on. See ReactionRoleOption.emojiKey. */
export function reactionKey(
  emoji: ReactionEmoji | GuildEmoji | { id: string | null; name: string | null },
): string {
  return emoji.id ?? stripVariationSelector(emoji.name ?? "");
}
