import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import type { DiscordCommand } from "./types.js";
import { config } from "../../config.js";
import { clearAutoRole, getAutoRole, setAutoRole } from "../../core/autoRole/autoRoleService.js";
import { roleAssignProblem } from "../roles.js";
import { warmMemberCache } from "../autoRole.js";

const ROLE_OPTION = "role";

/** Things that would stop the role landing, worded for the admin to fix. */
function warnings(guild: Guild, roleId: string): string[] {
  const lines: string[] = [];
  const problem = roleAssignProblem(guild, roleId);
  if (problem) lines.push(`⚠️ ${problem}`);
  const me = guild.members.me;
  if (me && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    lines.push("⚠️ I don't have the **Manage Roles** permission, so I can't hand it out yet.");
  }
  if (!config.DISCORD_AUTO_ROLE_ENABLED) {
    lines.push(
      "⚠️ Auto role is switched off in my configuration, so nothing will be assigned until the bot's operator turns it on.",
    );
  }
  return lines;
}

async function set(interaction: ChatInputCommandInteraction<"cached">) {
  const role = interaction.options.getRole(ROLE_OPTION, true);
  // Refused outright rather than saved with a warning: unlike a missing
  // permission, none of these fix themselves without picking another role.
  const problem = roleAssignProblem(interaction.guild, role.id);
  if (problem) {
    await interaction.reply({ content: `⚠️ ${problem}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await setAutoRole(interaction.guildId, role.id, interaction.user.id);
  if (config.DISCORD_AUTO_ROLE_ENABLED) {
    // Not awaited: on a big server this takes a moment, and only matters for
    // people already partway through joining.
    void warmMemberCache(interaction.guild);
  }

  const lines = [
    `New members will get <@&${role.id}> once they've accepted the rules and finished onboarding. Members already in the server aren't changed.`,
    ...warnings(interaction.guild, role.id),
  ];
  await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
}

async function show(interaction: ChatInputCommandInteraction<"cached">) {
  const autoRole = await getAutoRole(interaction.guildId);
  if (!autoRole) {
    await interaction.reply({
      content: "No auto role is set. Use `/autorole set` to pick one.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const lines = [
    `New members get <@&${autoRole.roleId}> once they've finished joining (last set by <@${autoRole.updatedById}>).`,
    ...warnings(interaction.guild, autoRole.roleId),
  ];
  await interaction.reply({
    content: lines.join("\n"),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function clear(interaction: ChatInputCommandInteraction<"cached">) {
  const cleared = await clearAutoRole(interaction.guildId);
  await interaction.reply({
    content: cleared
      ? "Auto role turned off. Members who already have the role keep it."
      : "There was no auto role set.",
    flags: MessageFlags.Ephemeral,
  });
}

export const autorole: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName("autorole")
    .setDescription("Give new members a role once they've finished joining.")
    // Same gate as /reactroles; adjustable under Server Settings → Integrations.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("Pick the role new members get.")
        .addRoleOption((o) => o.setName(ROLE_OPTION).setDescription("The role to give").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("show").setDescription("Show the current auto role."))
    .addSubcommand((s) =>
      s.setName("clear").setDescription("Stop giving new members a role. Nobody loses it."),
    ),

  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "This only works inside a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    switch (interaction.options.getSubcommand()) {
      case "set":
        await set(interaction);
        return;
      case "show":
        await show(interaction);
        return;
      case "clear":
        await clear(interaction);
        return;
    }
  },
};

export const autoRoleCommands: DiscordCommand[] = [autorole];
