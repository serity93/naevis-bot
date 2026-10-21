import {
  DiscordAPIError,
  GuildMemberFlags,
  RESTJSONErrorCodes,
  type Client,
  type Guild,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import { logger } from "../logger.js";
import { getAutoRole, listAutoRoleGuildIds } from "../core/autoRole/autoRoleService.js";

type OnboardingCheck = () => Promise<boolean>;

/**
 * Discord adds someone to the member list the moment they press Join, but
 * until they've accepted the rules (membership screening, `pending`) and, if
 * the server uses it, worked through onboarding, they're still at the door.
 * The auto role waits for both.
 */
async function hasFinishedJoining(member: GuildMember, onboardingEnabled: OnboardingCheck): Promise<boolean> {
  if (member.pending) return false;
  if (member.flags.has(GuildMemberFlags.CompletedOnboarding)) return true;
  // Without onboarding switched on the flag is never set, so its absence only
  // means "still onboarding" on servers that have it.
  return !(await onboardingEnabled());
}

/** Fetched at most once per event, and only if the answer is needed. */
function onboardingCheck(guild: Guild): OnboardingCheck {
  let enabled: Promise<boolean> | undefined;
  return () =>
    (enabled ??= guild.fetchOnboarding().then(
      (o) => o.enabled,
      (err: unknown) => {
        // Falling back to "off" still honours the rules screen; falling back
        // to "on" would leave servers without onboarding never assigning.
        logger.warn({ err, guildId: guild.id }, "Couldn't fetch onboarding settings; assuming it's off");
        return false;
      },
    ));
}

export async function handleMemberAdd(member: GuildMember): Promise<void> {
  if (member.user.bot) return;
  const autoRole = await getAutoRole(member.guild.id);
  if (!autoRole) return;
  // Most joins on a server with screening or onboarding stop here, and get the
  // role from handleMemberUpdate once they're through.
  if (!(await hasFinishedJoining(member, onboardingCheck(member.guild)))) return;
  await assign(member, autoRole.roleId);
}

export async function handleMemberUpdate(
  old: GuildMember | PartialGuildMember,
  member: GuildMember,
): Promise<void> {
  // Only reachable with Partials.GuildMember, which the client doesn't enable:
  // an uncached member's update arrives as guildMemberAvailable instead. That's
  // why warmMemberCache exists.
  if (old.partial) return;
  if (member.user.bot) return;

  // Only these two fields decide whether someone has finished joining, so an
  // update that changes neither — a nickname, a role, a timeout — can't be the
  // moment they did. Checked before any DB or REST call, since this fires for
  // every member change in the server.
  const completed = GuildMemberFlags.CompletedOnboarding;
  if (old.pending === member.pending && old.flags.has(completed) === member.flags.has(completed)) return;

  const autoRole = await getAutoRole(member.guild.id);
  if (!autoRole) return;

  // A transition rather than a state check: someone already in the server
  // whose auto role an admin removed shouldn't get it back on their next
  // update.
  const onboarding = onboardingCheck(member.guild);
  if (await hasFinishedJoining(old, onboarding)) return;
  if (!(await hasFinishedJoining(member, onboarding))) return;
  await assign(member, autoRole.roleId);
}

async function assign(member: GuildMember, roleId: string): Promise<void> {
  if (member.roles.cache.has(roleId)) return;
  const guild = member.guild;
  const role = guild.roles.cache.get(roleId);
  if (!role) {
    logger.warn({ roleId, guildId: guild.id }, "Auto role points at a role that no longer exists");
    return;
  }

  try {
    await member.roles.add(role, "Auto role");
  } catch (err) {
    const forbidden = err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.MissingPermissions;
    logger.warn(
      { err, roleId, guildId: guild.id, userId: member.id },
      forbidden
        ? "Missing permission to assign the auto role — check Manage Roles and role order"
        : "Failed to assign the auto role",
    );
  }
}

/**
 * handleMemberUpdate compares a member before and after, which needs them in
 * the cache. Members cache themselves on join, but a restart empties it, so
 * anyone who joined before and is still mid-onboarding would finish without
 * the role. Loading the member list up front closes that gap.
 */
export async function warmMemberCache(guild: Guild): Promise<void> {
  try {
    await guild.members.fetch();
  } catch (err) {
    logger.warn({ err, guildId: guild.id }, "Failed to load members for auto role");
  }
}

export async function warmAutoRoleGuilds(client: Client<true>): Promise<void> {
  const guildIds = await listAutoRoleGuildIds();
  for (const guildId of guildIds) {
    const guild = client.guilds.cache.get(guildId);
    if (guild) await warmMemberCache(guild);
  }
}
