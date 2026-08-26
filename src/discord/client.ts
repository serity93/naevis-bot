import { Client, GatewayIntentBits, Events, MessageFlags } from "discord.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordMessageActivity } from "../core/activity/activityService.js";
import { discordCommandMap } from "./registry.js";
import { maybeHandleAiChat } from "./aiChat.js";

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
    ],
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

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = discordCommandMap.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      logger.error({ err, command: interaction.commandName }, "Error executing Discord command");
      const payload = {
        content: "Something went wrong running that command.",
        flags: [MessageFlags.Ephemeral] as const,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    }
  });

  return client;
}

export async function startDiscordBot() {
  const client = createDiscordClient();
  await client.login(config.DISCORD_TOKEN);
  return client;
}
