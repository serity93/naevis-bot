import { Client, GatewayIntentBits, Events, MessageFlags } from "discord.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordMessageActivity } from "../core/activity/activityService.js";
import { discordCommandMap } from "./registry.js";

export function createDiscordClient() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  client.once(Events.ClientReady, (c) => {
    logger.info({ user: c.user.tag }, "Discord bot logged in");
  });

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    recordMessageActivity("DISCORD", message.author.id, message.author.username).catch((err) => {
      logger.error({ err }, "Failed to record Discord message activity");
    });
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
