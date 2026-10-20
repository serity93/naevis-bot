import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import type { DiscordCommand } from "./types.js";
import {
  getConfig,
  listForGuild,
  type ReactionRoleConfig,
} from "../../core/reactionRoles/reactionRoleService.js";
import { deleteConfirmation, startDraft } from "../reactionRoles/panel.js";
import { fetchPostedMessage } from "../reactionRoles/publish.js";
import { messageUrl } from "../reactionRoles/render.js";

const MESSAGE_OPTION = "message";

function summary(config: ReactionRoleConfig): string {
  const firstLine = config.content.split("\n")[0] ?? "";
  const text = config.title ?? firstLine;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

async function loadForGuild(
  interaction: ChatInputCommandInteraction<"cached">,
): Promise<ReactionRoleConfig | null> {
  const id = interaction.options.getString(MESSAGE_OPTION, true);
  const config = await getConfig(id);
  // Autocomplete values can be typed by hand, so an id from another server has
  // to be refused here rather than trusted.
  if (!config || config.guildId !== interaction.guildId) {
    await interaction.reply({
      content: "I couldn't find that reaction-role message. Pick one from the suggestions.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return config;
}

async function list(interaction: ChatInputCommandInteraction<"cached">) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const configs = await listForGuild(guild.id);
  if (configs.length === 0) {
    await interaction.editReply(
      "There are no reaction-role messages yet. Use `/reactroles create` to make one.",
    );
    return;
  }

  const sections = await Promise.all(configs.map((c, i) => describe(guild, c, i + 1)));
  // Embed descriptions cap at 4096 characters; split across embeds (max ten
  // per message) rather than truncating someone's list.
  const embeds: EmbedBuilder[] = [];
  let current = "";
  for (const section of sections) {
    if (current && current.length + section.length + 2 > 4000) {
      embeds.push(new EmbedBuilder().setDescription(current));
      current = "";
    }
    current = current ? `${current}\n\n${section}` : section;
  }
  if (current) embeds.push(new EmbedBuilder().setDescription(current));
  embeds[0]?.setTitle(`Reaction-role messages (${configs.length})`);

  await interaction.editReply({ embeds: embeds.slice(0, 10) });
}

async function describe(guild: Guild, config: ReactionRoleConfig, n: number): Promise<string> {
  const message = await fetchPostedMessage(guild, config).catch(() => undefined);
  const where =
    message === null
      ? `<#${config.channelId}> — ⚠️ message was deleted; use \`/reactroles edit\` to repost it`
      : `<#${config.channelId}> — ${messageUrl(guild.id, config.channelId, config.messageId)}`;
  const pairs = config.options.map((o) => {
    const missing = guild.roles.cache.has(o.roleId) ? "" : " ⚠️ role deleted";
    return `${o.emojiDisplay} → <@&${o.roleId}>${missing}`;
  });
  return [`**${n}. ${summary(config) || "(no text)"}**`, where, pairs.join(" · ")].join("\n");
}

export const reactroles: DiscordCommand = {
  data: new SlashCommandBuilder()
    .setName("reactroles")
    .setDescription("Manage messages that hand out roles by emoji reaction.")
    // Hidden from everyone without Manage Roles. Server owners can loosen or
    // tighten this per role under Server Settings → Integrations.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName("list").setDescription("List this server's reaction-role messages."))
    .addSubcommand((s) => s.setName("create").setDescription("Set up and post a new reaction-role message."))
    .addSubcommand((s) =>
      s
        .setName("edit")
        .setDescription("Change a reaction-role message's content, channel or roles.")
        .addStringOption((o) =>
          o.setName(MESSAGE_OPTION).setDescription("Which message").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("delete")
        .setDescription("Delete a reaction-role message. Members keep roles they already have.")
        .addStringOption((o) =>
          o.setName(MESSAGE_OPTION).setDescription("Which message").setRequired(true).setAutocomplete(true),
        ),
    ),

  async execute(interaction) {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "This only works inside a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    switch (interaction.options.getSubcommand()) {
      case "list":
        await list(interaction);
        return;
      case "create":
        await interaction.reply({
          ...startDraft(interaction.guild, interaction.user.id),
          flags: MessageFlags.Ephemeral,
        });
        return;
      case "edit": {
        const config = await loadForGuild(interaction);
        if (!config) return;
        await interaction.reply({
          ...startDraft(interaction.guild, interaction.user.id, config),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      case "delete": {
        const config = await loadForGuild(interaction);
        if (!config) return;
        await interaction.reply({
          content: `Delete the reaction-role message in <#${config.channelId}> (**${summary(config) || "no text"}**)? Members keep any roles they already got from it.`,
          components: [deleteConfirmation(config.id)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    if (!interaction.guildId) {
      await interaction.respond([]);
      return;
    }
    const query = interaction.options.getFocused().toLowerCase();
    const configs = await listForGuild(interaction.guildId);
    const choices = configs
      .map((c) => {
        const channel = interaction.guild?.channels.cache.get(c.channelId)?.name ?? "deleted-channel";
        return { name: `#${channel} — ${summary(c) || "(no text)"}`.slice(0, 100), value: c.id };
      })
      .filter((c) => c.name.toLowerCase().includes(query))
      .slice(0, 25);
    await interaction.respond(choices);
  },
};

export const reactionRoleCommands: DiscordCommand[] = [reactroles];
