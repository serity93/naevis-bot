import { logger } from "./logger.js";
import { startDiscordBot } from "./discord/client.js";
import { startTwitchBot } from "./twitch/client.js";
import type { WatchtimeTracker } from "./twitch/watchtime.js";
import { prisma } from "./db/client.js";
import { initAiChat } from "./core/ai/chatService.js";

let watchtimeTracker: WatchtimeTracker | null = null;

async function main() {
  logger.info("Starting naevis-bot...");

  const results = await Promise.allSettled([startDiscordBot(), startTwitchBot()]);

  const [discordResult, twitchResult] = results;
  if (discordResult.status === "rejected") {
    logger.error({ err: discordResult.reason }, "Discord bot failed to start");
  }
  if (twitchResult.status === "rejected") {
    logger.error({ err: twitchResult.reason }, "Twitch bot failed to start");
  } else {
    watchtimeTracker = twitchResult.value.watchtime;
  }
  if (results.every((r) => r.status === "rejected")) {
    logger.fatal("Both Discord and Twitch bots failed to start, exiting.");
    process.exit(1);
  }

  // Not awaited: probing Ollama and loading a multi-gigabyte model can take a
  // couple of minutes, and none of it should delay the bot being usable for
  // commands. A misconfigured or absent Ollama leaves AI chat off with a
  // reason in the logs, the same way watchtime degrades on its own.
  initAiChat().catch((err: unknown) => {
    logger.error({ err }, "AI chat initialisation failed");
  });
}

async function shutdown() {
  logger.info("Shutting down...");
  // Stops any further samples being scheduled. A sample already in flight is
  // left to finish or fail on its own; the worst case is one lost minute of
  // credit, which isn't worth waiting on.
  watchtimeTracker?.stop();
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
