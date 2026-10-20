import {
  DiscordAPIError,
  RESTJSONErrorCodes,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { logger } from "../../logger.js";
import { findRoleForReaction } from "../../core/reactionRoles/reactionRoleService.js";
import { reactionKey } from "./emoji.js";

// Long enough to read a one-line confirmation, short enough that a burst of
// people picking roles doesn't bury the message they're reacting to.
const CHANNEL_NOTICE_TTL_MS = 5000;

type Change = "add" | "remove";

/**
 * Grant or revoke the role tied to a reaction on a reaction-role message.
 *
 * Called fire-and-forget from client.ts, like AI chat: it makes several REST
 * calls, and awaiting them on the gateway's event loop would stall everything
 * behind it.
 */
export async function handleReactionChange(
  change: Change,
  rawReaction: MessageReaction | PartialMessageReaction,
  rawUser: User | PartialUser,
): Promise<void> {
  // Also skips the bot's own reactions, which it adds to every message it posts.
  if (rawUser.bot) return;

  // Checked before any fetch: a partial still carries the message id and the
  // emoji, and almost every reaction the bot sees is on some unrelated message.
  const roleId = await findRoleForReaction(rawReaction.message.id, reactionKey(rawReaction.emoji));
  if (!roleId) return;

  const reaction = rawReaction.partial ? await rawReaction.fetch() : rawReaction;
  const user = rawUser.partial ? await rawUser.fetch() : rawUser;
  // A partial user's bot flag is null, so the check above only caught bots
  // that were already cached.
  if (user.bot) return;
  const message = reaction.message;
  if (!message.inGuild()) return;

  const guild = message.guild;
  const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) {
    logger.warn({ roleId, messageId: message.id }, "Reaction-role points at a role that no longer exists");
    await notify(
      user,
      message.channel,
      `Sorry, that role no longer exists in **${guild.name}**. Let a server admin know.`,
    );
    return;
  }

  // Fetched rather than read from cache: without the GuildMembers intent the
  // cache only holds members the bot has happened to see recently.
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return; // Left the server between reacting and now.

  // Already in the wanted state still gets a confirmation: from the member's
  // side they did something, and silence reads as the bot being broken.
  const alreadyDone = member.roles.cache.has(role.id) === (change === "add");
  if (!alreadyDone) {
    try {
      if (change === "add") await member.roles.add(role, "Reaction role");
      else await member.roles.remove(role, "Reaction role");
    } catch (err) {
      const forbidden = err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.MissingPermissions;
      logger.warn(
        { err, roleId: role.id, guildId: guild.id },
        forbidden
          ? "Missing permission to manage a reaction role — check Manage Roles and role order"
          : "Failed to update reaction role",
      );
      await notify(
        user,
        message.channel,
        `Sorry, I couldn't update your **${role.name}** role in **${guild.name}**. Let a server admin know.`,
      );
      return;
    }
  }

  await notify(
    user,
    message.channel,
    change === "add"
      ? `You now have the **${role.name}** role in **${guild.name}**.`
      : `The **${role.name}** role was removed from you in **${guild.name}**.`,
  );
}

interface SendableChannel {
  send(options: {
    content: string;
    allowedMentions: { users: string[] };
  }): Promise<{ delete(): Promise<unknown> }>;
}

/**
 * A reaction carries no interaction, so there's no way to give the reactor a
 * private ephemeral reply. A DM is the private option; members with DMs from
 * server members turned off get a short channel message instead, which
 * mentions only them and cleans itself up.
 */
async function notify(user: User, channel: SendableChannel, text: string): Promise<void> {
  try {
    await user.send(text);
    return;
  } catch (err) {
    if (!(err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser)) {
      logger.debug({ err }, "Failed to DM reaction-role confirmation");
    }
  }

  try {
    const notice = await channel.send({
      content: `<@${user.id}> ${text}`,
      allowedMentions: { users: [user.id] },
    });
    setTimeout(() => {
      notice.delete().catch(() => undefined);
    }, CHANNEL_NOTICE_TTL_MS);
  } catch (err) {
    // The role change itself already happened; a missing confirmation is
    // cosmetic.
    logger.debug({ err }, "Failed to post reaction-role confirmation in channel");
  }
}
