import { logger } from "./logger.js";
import { startDiscordBot } from "./discord/client.js";
import { startTwitchBot } from "./twitch/client.js";
import { prisma } from "./db/client.js";

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

async function shutdown() {
  logger.info("Shutting down...");
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, "Error disconnecting Prisma client");
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((err) => {
  logger.fatal({ err }, "Fatal error during startup");
  process.exit(1);
});
