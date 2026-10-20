import { Client, GatewayIntentBits, Events, MessageFlags, Partials, type Interaction } from "discord.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordMessageActivity } from "../core/activity/activityService.js";
import { discordCommandMap } from "./registry.js";
import { maybeHandleAiChat } from "./aiChat.js";
import { CUSTOM_ID_PREFIX, handleReactionRoleInteraction } from "./reactionRoles/panel.js";
import { handleReactionChange } from "./reactionRoles/reactions.js";

export function createDiscordClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // Privileged, and must also be enabled in the Developer Portal.
      // Without it Discord blanks message content everywhere except
      // messages that mention the bot, DMs, and the bot's own messages — so
      // replying to the bot with the ping toggled off (one click in the
      // reply box) would arrive empty and go unanswered, which reads as a
      // random bug rather than a missing permission.
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    // Reactions on messages the bot hasn't cached — every reaction-role
    // message, after a restart — are dropped entirely without these. With
    // them the event arrives carrying just ids, and the handler fetches the
    // rest only once it knows the message is one of ours.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });

  client.once(Events.ClientReady, (c) => {
    logger.info({ user: c.user.tag }, "Discord bot logged in");
  });

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    recordMessageActivity("DISCORD", message.author.id, message.author.username).catch((err) => {
      logger.error({ err }, "Failed to record Discord message activity");
    });

    // Points and AI chat are independent: a failed generation must not cost
    // someone their message points, and vice versa. Both are fire-and-forget
    // for the same reason — this handler runs on the gateway's event loop, and
    // a ten-second generation awaited here would stall every event behind it.
    const botUserId = client.user?.id;
    if (botUserId) {
      maybeHandleAiChat(message, botUserId).catch((err: unknown) => {
        logger.error({ err }, "Failed to handle Discord AI chat");
      });
    }
  });

  // Fire-and-forget for the same reason as AI chat: each one makes several
  // REST calls, and awaiting them here would stall every event behind them.
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    handleReactionChange("add", reaction, user).catch((err: unknown) => {
      logger.error({ err }, "Failed to handle reaction-role add");
    });
  });

  client.on(Events.MessageReactionRemove, (reaction, user) => {
    handleReactionChange("remove", reaction, user).catch((err: unknown) => {
      logger.error({ err }, "Failed to handle reaction-role remove");
    });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      // A failed autocomplete just shows no suggestions; there's nothing to
      // reply to, so logging is all there is to do.
      const command = discordCommandMap.get(interaction.commandName);
      await command?.autocomplete?.(interaction).catch((err: unknown) => {
        logger.error({ err, command: interaction.commandName }, "Error in Discord autocomplete");
      });
      return;
    }

    if (
      (interaction.isMessageComponent() || interaction.isModalSubmit()) &&
      interaction.customId.startsWith(CUSTOM_ID_PREFIX)
    ) {
      try {
        await handleReactionRoleInteraction(interaction);
      } catch (err) {
        logger.error({ err, customId: interaction.customId }, "Error handling reaction-role interaction");
        await replyWithError(interaction, "Something went wrong handling that.");
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const command = discordCommandMap.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      logger.error({ err, command: interaction.commandName }, "Error executing Discord command");
      await replyWithError(interaction, "Something went wrong running that command.");
    }
  });

  return client;
}

async function replyWithError(interaction: Interaction, content: string) {
  if (!interaction.isRepliable()) return;
  const payload = { content, flags: [MessageFlags.Ephemeral] as const };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

export async function startDiscordBot() {
  const client = createDiscordClient();
  await client.login(config.DISCORD_TOKEN);
  return client;
}
