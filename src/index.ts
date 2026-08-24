import { logger } from "./logger.js";
import { startDiscordBot } from "./discord/client.js";
import { startTwitchBot } from "./twitch/client.js";

async function main() {
  logger.info("Starting naevis-bot...");

  const results = await Promise.allSettled([startDiscordBot(), startTwitchBot()]);

  const [discordResult, twitchResult] = results;
  if (discordResult.status === "rejected") {
    logger.error({ err: discordResult.reason }, "Discord bot failed to start");
  }
  if (twitchResult.status === "rejected") {
    logger.error({ err: twitchResult.reason }, "Twitch bot failed to start");
  }
  if (results.every((r) => r.status === "rejected")) {
    logger.fatal("Both Discord and Twitch bots failed to start, exiting.");
    process.exit(1);
  }
}

function shutdown() {
  logger.info("Shutting down...");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  logger.fatal({ err }, "Fatal error during startup");
  process.exit(1);
});
