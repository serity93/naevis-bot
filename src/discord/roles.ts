import type { Guild } from "discord.js";

/**
 * Why the bot can't hand out a role, or null if it can. Shared by every
 * feature that assigns roles, so they refuse the same things with the same
 * wording.
 */
export function roleAssignProblem(guild: Guild, roleId: string): string | null {
  const role = guild.roles.cache.get(roleId);
  if (!role) return "That role no longer exists.";
  if (role.id === guild.id) return "@everyone can't be handed out — everyone already has it.";
  if (role.managed)
    return `<@&${role.id}> is managed by an integration or bot, so it can't be assigned by hand.`;
  const me = guild.members.me;
  if (me && me.roles.highest.comparePositionTo(role) <= 0) {
    return `<@&${role.id}> is at or above my highest role, so I can't assign it. Move my role above it in Server Settings → Roles.`;
  }
  return null;
}
