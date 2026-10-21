import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Guild,
  type Message,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import { logger } from "../../logger.js";
import {
  createConfig,
  deleteConfig,
  updateConfig,
  type ReactionRoleConfig,
  type ReactionRoleFields,
  type ReactionRolePair,
} from "../../core/reactionRoles/reactionRoleService.js";
import type { Draft } from "./drafts.js";
import { reactionKey } from "./emoji.js";
import { buildReactionRoleEmbed } from "./render.js";

export type PostableChannel = TextChannel | NewsChannel;

/** An error whose message is safe and useful to show the admin as-is. */
export class ReactionRoleError extends Error {}

const REQUIRED_CHANNEL_PERMISSIONS = {
  "View Channel": PermissionFlagsBits.ViewChannel,
  "Send Messages": PermissionFlagsBits.SendMessages,
  "Embed Links": PermissionFlagsBits.EmbedLinks,
  "Add Reactions": PermissionFlagsBits.AddReactions,
  "Read Message History": PermissionFlagsBits.ReadMessageHistory,
} as const;

/** Names of the permissions the bot lacks in a channel, empty if it can post there. */
export function missingChannelPermissions(channel: PostableChannel): string[] {
  const me = channel.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  return Object.entries(REQUIRED_CHANNEL_PERMISSIONS)
    .filter(([, flag]) => !perms?.has(flag))
    .map(([name]) => name);
}

export async function resolvePostableChannel(guild: Guild, channelId: string): Promise<PostableChannel> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
  ) {
    throw new ReactionRoleError("That channel no longer exists. Pick another one.");
  }
  const missing = missingChannelPermissions(channel);
  if (missing.length > 0) {
    throw new ReactionRoleError(`I'm missing these permissions in <#${channel.id}>: ${missing.join(", ")}.`);
  }
  return channel;
}

function isMissingResource(err: unknown): boolean {
  return (
    err instanceof DiscordAPIError &&
    (err.code === RESTJSONErrorCodes.UnknownMessage || err.code === RESTJSONErrorCodes.UnknownChannel)
  );
}

/**
 * The posted message, or null if it (or its channel) has been deleted. Any
 * other failure — a permission change, an outage — is rethrown: treating it as
 * "gone" would repost and leave the original orphaned.
 */
export async function fetchPostedMessage(guild: Guild, config: ReactionRoleConfig): Promise<Message | null> {
  try {
    const channel = await guild.channels.fetch(config.channelId);
    if (!channel?.isTextBased()) return null;
    return await channel.messages.fetch(config.messageId);
  } catch (err) {
    if (isMissingResource(err)) return null;
    throw err;
  }
}

async function deleteQuietly(message: Message): Promise<void> {
  await message.delete().catch((err: unknown) => {
    if (!isMissingResource(err)) throw err;
  });
}

async function reactAll(message: Message, pairs: ReactionRolePair[]): Promise<void> {
  // Sequential on purpose: reaction order on the message is the order they
  // were added, and it should match the list in the embed.
  for (const pair of pairs) {
    try {
      await message.react(pair.emojiDisplay);
    } catch (err) {
      logger.warn({ err, emoji: pair.emojiDisplay }, "Failed to add reaction-role reaction");
      throw new ReactionRoleError(
        `I couldn't react with ${pair.emojiDisplay}. Remove that pair or pick another emoji.`,
      );
    }
  }
}

/**
 * Post the embed and seed its reactions. All or nothing: a message missing one
 * of its reactions would look finished while one role quietly can't be
 * claimed, so a failed reaction takes the whole message down with it.
 */
async function post(channel: PostableChannel, draft: Draft): Promise<Message> {
  const message = await channel.send({
    embeds: [buildReactionRoleEmbed(viewOf(draft))],
    allowedMentions: { parse: [] },
  });
  try {
    await reactAll(message, draft.pairs);
  } catch (err) {
    await deleteQuietly(message).catch(() => undefined);
    throw err;
  }
  return message;
}

function viewOf(draft: Draft) {
  return {
    title: draft.title,
    content: draft.content ?? "",
    color: draft.color,
    showRoleList: draft.showRoleList,
    pairs: draft.pairs,
  };
}

function fieldsOf(draft: Draft, message: Message): ReactionRoleFields {
  return {
    guildId: draft.guildId,
    channelId: message.channelId,
    messageId: message.id,
    title: draft.title,
    content: draft.content ?? "",
    color: draft.color,
    showRoleList: draft.showRoleList,
  };
}

export async function publishNew(guild: Guild, draft: Draft): Promise<ReactionRoleConfig> {
  const channel = await resolvePostableChannel(guild, draft.channelId!);
  const message = await post(channel, draft);
  try {
    return await createConfig(fieldsOf(draft, message), draft.ownerId, draft.pairs);
  } catch (err) {
    // Without its row the message is a dead end: reactions on it do nothing.
    await deleteQuietly(message).catch(() => undefined);
    throw err;
  }
}

export interface EditResult {
  config: ReactionRoleConfig;
  reposted: boolean;
  warnings: string[];
}

export async function applyEdit(guild: Guild, draft: Draft, config: ReactionRoleConfig): Promise<EditResult> {
  const existing = await fetchPostedMessage(guild, config);

  if (!existing || existing.channelId !== draft.channelId) {
    // Moving, or the original was deleted by hand. Post fresh, point the row at
    // it, then retire the old one. Members who reacted on the old message keep
    // their roles: deleting a message fires no per-user reaction removals.
    const channel = await resolvePostableChannel(guild, draft.channelId!);
    const message = await post(channel, draft);
    let updated: ReactionRoleConfig;
    try {
      updated = await updateConfig(config.id, fieldsOf(draft, message), draft.pairs);
    } catch (err) {
      await deleteQuietly(message).catch(() => undefined);
      throw err;
    }
    const warnings: string[] = [];
    if (existing) {
      await deleteQuietly(existing).catch((err: unknown) => {
        logger.warn({ err, messageId: existing.id }, "Failed to delete moved reaction-role message");
        warnings.push(`I couldn't delete the old message in <#${existing.channelId}> — remove it by hand.`);
      });
    }
    return { config: updated, reposted: true, warnings };
  }

  await existing.edit({ embeds: [buildReactionRoleEmbed(viewOf(draft))], allowedMentions: { parse: [] } });

  // A pair is unchanged only if both its emoji and its role survived. An emoji
  // that now points at a different role has its reactions cleared and
  // re-seeded too, so nobody's old reaction stands for a role they never got.
  const unchanged = new Set(
    draft.pairs
      .filter((p) => config.options.some((o) => o.emojiKey === p.emojiKey && o.roleId === p.roleId))
      .map((p) => p.emojiKey),
  );

  const warnings: string[] = [];
  for (const option of config.options) {
    if (unchanged.has(option.emojiKey)) continue;
    const reaction = existing.reactions.cache.find((r) => reactionKey(r.emoji) === option.emojiKey);
    if (!reaction) continue;
    // Removing a whole emoji fires a single REMOVE_EMOJI event rather than one
    // removal per member, so nobody loses the role they already hold.
    await reaction.remove().catch((err: unknown) => {
      logger.warn({ err, emoji: option.emojiDisplay }, "Failed to clear reaction-role reactions");
      warnings.push(
        `I couldn't clear the ${option.emojiDisplay} reactions (I need Manage Messages) — remove them by hand.`,
      );
    });
  }

  await reactAll(
    existing,
    draft.pairs.filter((p) => !unchanged.has(p.emojiKey)),
  );

  const updated = await updateConfig(config.id, fieldsOf(draft, existing), draft.pairs);
  return { config: updated, reposted: false, warnings };
}

/**
 * Delete the posted message and its configuration. Roles already handed out
 * stay where they are — deleting a message fires no reaction removals.
 */
export async function removeReactionRoleMessage(guild: Guild, config: ReactionRoleConfig): Promise<void> {
  const message = await fetchPostedMessage(guild, config);
  if (message) await deleteQuietly(message);
  await deleteConfig(config.id);
}
