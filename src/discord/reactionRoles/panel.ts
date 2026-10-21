import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CheckboxBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type Guild,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { logger } from "../../logger.js";
import { getConfig } from "../../core/reactionRoles/reactionRoleService.js";
import { createDraft, discardDraft, getDraft, isDraftComplete, type Draft } from "./drafts.js";
import { parseEmojiInput } from "./emoji.js";
import {
  applyEdit,
  missingChannelPermissions,
  publishNew,
  removeReactionRoleMessage,
  ReactionRoleError,
} from "./publish.js";
import {
  buildReactionRoleEmbed,
  formatColor,
  MAX_CONTENT_LENGTH,
  MAX_PAIRS,
  MAX_TITLE_LENGTH,
  messageUrl,
  parseColor,
} from "./render.js";

// Every component and modal this module owns carries this prefix, which is
// how client.ts knows to route an interaction here.
export const CUSTOM_ID_PREFIX = "rr:";

const STATUS_COLOR = 0x2b2d31;

type Action =
  | "channel"
  | "content"
  | "contentmodal"
  | "addpair"
  | "pairmodal"
  | "removepair"
  | "publish"
  | "cancel"
  | "delconfirm"
  | "delcancel";

function customId(action: Action, id: string): string {
  return `${CUSTOM_ID_PREFIX}${action}:${id}`;
}

function parseCustomId(raw: string): { action: Action; id: string } | null {
  const [prefix, action, id] = raw.split(":");
  if (`${prefix}:` !== CUSTOM_ID_PREFIX || !action || !id) return null;
  return { action: action as Action, id };
}

// --- Rendering ---------------------------------------------------------------

function step(done: boolean, text: string): string {
  return `${done ? "✅" : "⬜"} ${text}`;
}

function roleLabel(guild: Guild, roleId: string): string {
  return guild.roles.cache.get(roleId)?.name ?? "deleted role";
}

// Select-menu labels are plain text, so a custom emoji's <:name:id> form would
// show up raw. Its :name: reads the way people type it.
function plainEmoji(display: string): string {
  const custom = /^<a?:(\w+):\d+>$/.exec(display);
  return custom ? `:${custom[1]}:` : display;
}

export function renderPanel(draft: Draft, guild: Guild, notice?: string) {
  const editing = draft.editingConfigId !== null;
  const lines = [
    step(
      draft.channelId !== null,
      `**1. Channel** — ${draft.channelId ? `<#${draft.channelId}>` : "pick one below"}`,
    ),
    step(!!draft.content, `**2. Content** — ${draft.content ? "set" : "use **Edit content**"}`),
    step(
      draft.pairs.length > 0,
      `**3. Emoji → role pairs** — ${draft.pairs.length}/${MAX_PAIRS}, use **Add pair**`,
    ),
  ];

  const me = guild.members.me;
  if (me && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    lines.push("", "⚠️ I don't have the **Manage Roles** permission, so reacting won't hand out roles yet.");
  }
  if (notice) lines.push("", notice);

  const status = new EmbedBuilder()
    .setColor(STATUS_COLOR)
    .setTitle(editing ? "Editing a reaction-role message" : "New reaction-role message")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Preview below. Only you can see this panel." });

  const preview = buildReactionRoleEmbed({
    title: draft.title,
    content: draft.content ?? "*Your message will go here.*",
    color: draft.color,
    showRoleList: draft.showRoleList,
    pairs: draft.pairs,
  });

  const channelRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    (() => {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId(customId("channel", draft.id))
        .setPlaceholder("Channel to post in")
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
      if (draft.channelId) menu.setDefaultChannels(draft.channelId);
      return menu;
    })(),
  );

  const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId("content", draft.id))
      .setLabel("Edit content")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(customId("addpair", draft.id))
      .setLabel("Add pair")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(draft.pairs.length >= MAX_PAIRS),
    new ButtonBuilder()
      .setCustomId(customId("publish", draft.id))
      .setLabel(editing ? "Save changes" : "Publish")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!isDraftComplete(draft)),
    new ButtonBuilder()
      .setCustomId(customId("cancel", draft.id))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  const components = [channelRow, buttonRow];

  if (draft.pairs.length > 0) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId("removepair", draft.id))
          .setPlaceholder("Remove a pair…")
          .addOptions(
            draft.pairs.map((p) => ({
              label: `${plainEmoji(p.emojiDisplay)} → @${roleLabel(guild, p.roleId)}`.slice(0, 100),
              value: p.emojiKey,
            })),
          ),
      ),
    );
  }

  return { embeds: [status, preview], components };
}

function contentModal(draft: Draft): ModalBuilder {
  const title = new TextInputBuilder()
    .setCustomId("title")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(MAX_TITLE_LENGTH);
  if (draft.title) title.setValue(draft.title);

  const content = new TextInputBuilder()
    .setCustomId("content")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_CONTENT_LENGTH);
  if (draft.content) content.setValue(draft.content);

  const color = new TextInputBuilder()
    .setCustomId("color")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(7)
    .setValue(formatColor(draft.color));

  const showRoleList = new CheckboxBuilder().setCustomId("showRoleList").setDefault(draft.showRoleList);

  return new ModalBuilder()
    .setCustomId(customId("contentmodal", draft.id))
    .setTitle("Message content")
    .addLabelComponents(
      new LabelBuilder().setLabel("Title (optional)").setTextInputComponent(title),
      new LabelBuilder().setLabel("Message").setTextInputComponent(content),
      new LabelBuilder()
        .setLabel("Border colour")
        .setDescription("Hex, e.g. #5865F2. Leave blank for the default.")
        .setTextInputComponent(color),
      new LabelBuilder()
        .setLabel("Show the emoji → role list")
        .setDescription(
          "Lists each pair under your message and keeps it up to date. Untick to write your own.",
        )
        .setCheckboxComponent(showRoleList),
    );
}

function pairModal(draft: Draft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId("pairmodal", draft.id))
    .setTitle("Add an emoji → role pair")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Emoji")
        .setDescription("Paste an emoji (🎮) or type a server emoji's name (:pepe:).")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("emoji")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100),
        ),
      new LabelBuilder()
        .setLabel("Role")
        // Discord's own picker only lists the first batch of roles
        // alphabetically and won't scroll to the rest; typing searches them
        // all. Not something the bot can change, so the admin is told instead.
        .setDescription("Not every role is listed — type the role's name to search.")
        .setRoleSelectMenuComponent(
          new RoleSelectMenuBuilder().setCustomId("role").setMinValues(1).setMaxValues(1).setRequired(true),
        ),
    );
}

// --- Entry points used by the slash command ---------------------------------

export function startDraft(guild: Guild, ownerId: string, from?: Parameters<typeof createDraft>[2]) {
  const draft = createDraft(guild.id, ownerId, from);
  return renderPanel(draft, guild);
}

export function deleteConfirmation(configId: string) {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId("delconfirm", configId))
      .setLabel("Delete")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(customId("delcancel", configId))
      .setLabel("Keep")
      .setStyle(ButtonStyle.Secondary),
  );
}

// --- Interaction handling ----------------------------------------------------

type PanelInteraction = MessageComponentInteraction<"cached"> | ModalSubmitInteraction<"cached">;

/** Handle any button, select or modal submit whose customId starts with "rr:". */
export async function handleReactionRoleInteraction(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;

  if (parsed.action === "delconfirm" || parsed.action === "delcancel") {
    if (!interaction.isButton()) return;
    await handleDelete(interaction, parsed.action, parsed.id);
    return;
  }

  const draft = getDraft(parsed.id);
  if (!draft || draft.guildId !== interaction.guildId) {
    await expired(interaction);
    return;
  }
  // The panel is ephemeral, so this can't normally happen; it guards against a
  // replayed or hand-crafted interaction driving someone else's draft.
  if (draft.ownerId !== interaction.user.id) {
    await interaction.reply({
      content: "This panel belongs to someone else.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  switch (parsed.action) {
    case "channel":
      if (interaction.isChannelSelectMenu()) await onChannel(interaction, draft);
      return;
    case "content":
      if (interaction.isButton()) await interaction.showModal(contentModal(draft));
      return;
    case "addpair":
      if (interaction.isButton()) await interaction.showModal(pairModal(draft));
      return;
    case "contentmodal":
      if (interaction.isModalSubmit()) await onContent(interaction, draft);
      return;
    case "pairmodal":
      if (interaction.isModalSubmit()) await onPair(interaction, draft);
      return;
    case "removepair":
      if (interaction.isStringSelectMenu()) await onRemovePair(interaction, draft);
      return;
    case "publish":
      if (interaction.isButton()) await onPublish(interaction, draft);
      return;
    case "cancel":
      discardDraft(draft.id);
      await updatePanel(interaction, {
        content: "Cancelled — nothing was changed.",
        embeds: [],
        components: [],
      });
      return;
  }
}

async function expired(interaction: PanelInteraction) {
  await updatePanel(interaction, {
    content: "This panel has expired. Run `/reactroles` again to start over.",
    embeds: [],
    components: [],
  });
}

async function refresh(interaction: PanelInteraction, draft: Draft, notice?: string) {
  await updatePanel(interaction, renderPanel(draft, interaction.guild, notice));
}

async function updatePanel(
  interaction: PanelInteraction,
  payload: Omit<InteractionUpdateOptions, "flags"> & Omit<InteractionReplyOptions, "flags">,
) {
  // A modal opened from the panel comes back attached to the panel's message,
  // so it can update it in place like a button press would.
  if (interaction.isMessageComponent()) {
    await interaction.update(payload);
  } else if (interaction.isFromMessage()) {
    await interaction.update(payload);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

async function onChannel(interaction: ChannelSelectMenuInteraction<"cached">, draft: Draft) {
  const channel = interaction.channels.first();
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
  ) {
    await refresh(interaction, draft, "⚠️ Pick a text or announcement channel.");
    return;
  }
  const missing = missingChannelPermissions(channel);
  if (missing.length > 0) {
    await refresh(
      interaction,
      draft,
      `⚠️ I can't post in <#${channel.id}> — I'm missing: ${missing.join(", ")}.`,
    );
    return;
  }
  draft.channelId = channel.id;
  await refresh(interaction, draft);
}

async function onContent(interaction: ModalSubmitInteraction<"cached">, draft: Draft) {
  const content = interaction.fields.getTextInputValue("content").trim();
  const title = interaction.fields.getTextInputValue("title").trim();
  const colorRaw = interaction.fields.getTextInputValue("color");
  const color = parseColor(colorRaw);

  if (content.length === 0) {
    await refresh(interaction, draft, "⚠️ The message can't be blank.");
    return;
  }
  draft.content = content;
  draft.title = title || null;
  draft.showRoleList = interaction.fields.getCheckbox("showRoleList");
  if (color === null) {
    await refresh(
      interaction,
      draft,
      `⚠️ \`${colorRaw.trim()}\` isn't a hex colour like #5865F2 — kept the old one.`,
    );
    return;
  }
  draft.color = color;
  await refresh(interaction, draft);
}

async function onPair(interaction: ModalSubmitInteraction<"cached">, draft: Draft) {
  const guild = interaction.guild;
  const roleId = interaction.fields.getSelectedRoles("role", true).first()?.id;
  const role = roleId ? guild.roles.cache.get(roleId) : undefined;
  if (!role) {
    await refresh(interaction, draft, "⚠️ Pick a role.");
    return;
  }

  const parsed = parseEmojiInput(interaction.fields.getTextInputValue("emoji"), guild);
  if (!parsed.ok) {
    await refresh(interaction, draft, `⚠️ ${parsed.reason}`);
    return;
  }

  const problem = validateRole(guild, role.id);
  if (problem) {
    await refresh(interaction, draft, `⚠️ ${problem}`);
    return;
  }
  if (draft.pairs.length >= MAX_PAIRS) {
    await refresh(interaction, draft, `⚠️ A message can have at most ${MAX_PAIRS} reactions.`);
    return;
  }
  const sameEmoji = draft.pairs.find((p) => p.emojiKey === parsed.emoji.emojiKey);
  if (sameEmoji) {
    await refresh(
      interaction,
      draft,
      `⚠️ ${sameEmoji.emojiDisplay} is already used for <@&${sameEmoji.roleId}>. Remove that pair first to reassign it.`,
    );
    return;
  }
  if (draft.pairs.some((p) => p.roleId === role.id)) {
    await refresh(interaction, draft, `⚠️ <@&${role.id}> already has an emoji on this message.`);
    return;
  }

  draft.pairs.push({ ...parsed.emoji, roleId: role.id });
  await refresh(interaction, draft);
}

function validateRole(guild: Guild, roleId: string): string | null {
  const role = guild.roles.cache.get(roleId);
  if (!role) return "That role no longer exists.";
  if (role.id === guild.id) return "@everyone can't be handed out by reaction — everyone already has it.";
  if (role.managed)
    return `<@&${role.id}> is managed by an integration or bot, so it can't be assigned by hand.`;
  const me = guild.members.me;
  if (me && me.roles.highest.comparePositionTo(role) <= 0) {
    return `<@&${role.id}> is at or above my highest role, so I can't assign it. Move my role above it in Server Settings → Roles.`;
  }
  return null;
}

async function onRemovePair(interaction: StringSelectMenuInteraction<"cached">, draft: Draft) {
  const key = interaction.values[0];
  draft.pairs = draft.pairs.filter((p) => p.emojiKey !== key);
  await refresh(interaction, draft);
}

// Publishing makes several REST calls (up to twenty reactions, each rate
// limited), so a double-click could otherwise post twice.
const publishing = new Set<string>();

async function onPublish(interaction: ButtonInteraction<"cached">, draft: Draft) {
  if (publishing.has(draft.id)) {
    await interaction.deferUpdate();
    return;
  }
  if (!isDraftComplete(draft)) {
    await refresh(interaction, draft, "⚠️ Finish all three steps first.");
    return;
  }

  publishing.add(draft.id);
  await interaction.deferUpdate();
  try {
    const guild = interaction.guild;
    let summary: string;
    let warnings: string[] = [];

    if (draft.editingConfigId) {
      const config = await getConfig(draft.editingConfigId);
      if (!config || config.guildId !== guild.id) {
        throw new ReactionRoleError("That reaction-role message was deleted while you were editing it.");
      }
      const result = await applyEdit(guild, draft, config);
      warnings = result.warnings;
      const link = messageUrl(guild.id, result.config.channelId, result.config.messageId);
      summary = result.reposted ? `Reposted in <#${result.config.channelId}>: ${link}` : `Updated: ${link}`;
    } else {
      const config = await publishNew(guild, draft);
      summary = `Posted in <#${config.channelId}>: ${messageUrl(guild.id, config.channelId, config.messageId)}`;
    }

    discardDraft(draft.id);
    await interaction.editReply({
      content: [`✅ ${summary}`, ...warnings.map((w) => `⚠️ ${w}`)].join("\n"),
      embeds: [],
      components: [],
    });
  } catch (err) {
    const notice =
      err instanceof ReactionRoleError
        ? `⚠️ ${err.message}`
        : "⚠️ Something went wrong — check the bot logs and try again.";
    if (!(err instanceof ReactionRoleError)) logger.error({ err }, "Failed to publish reaction-role message");
    await interaction.editReply(renderPanel(draft, interaction.guild, notice));
  } finally {
    publishing.delete(draft.id);
  }
}

async function handleDelete(
  interaction: ButtonInteraction<"cached">,
  action: "delconfirm" | "delcancel",
  configId: string,
) {
  if (action === "delcancel") {
    await interaction.update({ content: "Kept it — nothing was deleted.", components: [] });
    return;
  }

  await interaction.deferUpdate();
  const config = await getConfig(configId);
  if (!config || config.guildId !== interaction.guildId) {
    await interaction.editReply({ content: "That reaction-role message is already gone.", components: [] });
    return;
  }
  try {
    await removeReactionRoleMessage(interaction.guild, config);
    await interaction.editReply({
      content: "🗑️ Deleted. Anyone who already has one of its roles keeps it.",
      components: [],
    });
  } catch (err) {
    logger.error({ err, configId }, "Failed to delete reaction-role message");
    await interaction.editReply({
      content: "Something went wrong deleting that message — check the bot logs and try again.",
      components: [],
    });
  }
}
