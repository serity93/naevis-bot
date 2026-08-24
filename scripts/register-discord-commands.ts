import { REST, Routes } from "discord.js";
import { config } from "../src/config.js";
import { allDiscordCommands } from "../src/discord/registry.js";
import { logger } from "../src/logger.js";

const body = allDiscordCommands.map((c) => c.data.toJSON());
const rest = new REST().setToken(config.DISCORD_TOKEN);

async function main() {
  if (config.DISCORD_DEV_GUILD_ID) {
    logger.info(
      { guild: config.DISCORD_DEV_GUILD_ID, count: body.length },
      "Registering guild commands (instant propagation)",
    );
    await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_DEV_GUILD_ID), {
      body,
    });
  } else {
    logger.info({ count: body.length }, "Registering global commands (can take up to 1 hour to propagate)");
    await rest.put(Routes.applicationCommands(config.DISCORD_CLIENT_ID), { body });
  }
  logger.info("Done.");
}

main().catch((err) => {
  logger.error({ err }, "Failed to register Discord commands");
  process.exit(1);
});
