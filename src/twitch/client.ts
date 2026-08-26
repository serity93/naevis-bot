import { ApiClient } from "@twurple/api";
import { ChatClient } from "@twurple/chat";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordMessageActivity } from "../core/activity/activityService.js";
import { createTwitchAuthProvider } from "./authProvider.js";
import { startWatchtimeTracking, type WatchtimeTracker } from "./watchtime.js";
import { basicCommands } from "./commands/basic.js";
import { linkCommands } from "./commands/link.js";
import type { TwitchCommand } from "./commands/types.js";

export interface TwitchBot {
  chatClient: ChatClient;
  watchtime: WatchtimeTracker | null;
}

export async function startTwitchBot(): Promise<TwitchBot> {
  const { authProvider, botUserId, scopes } = await createTwitchAuthProvider();

  const commands: TwitchCommand[] = [...basicCommands, ...linkCommands];
  const commandMap = new Map(commands.map((c) => [c.name, c]));

  const chatClient = new ChatClient({ authProvider, channels: config.TWITCH_CHANNELS });

  chatClient.onConnect(() => {
    logger.info({ channels: config.TWITCH_CHANNELS }, "Twitch chat client connected");
  });

  chatClient.onMessage(async (channel, user, text, msg) => {
    recordMessageActivity("TWITCH", msg.userInfo.userId, msg.userInfo.displayName).catch((err) => {
      logger.error({ err }, "Failed to record Twitch message activity");
    });

    if (!text.startsWith(config.TWITCH_COMMAND_PREFIX)) return;
    const [rawName, ...args] = text.slice(config.TWITCH_COMMAND_PREFIX.length).trim().split(/\s+/);
    const name = rawName?.toLowerCase();
    if (!name) return;

    const command = commandMap.get(name);
    if (!command) return;

    const reply = async (replyText: string) => {
      await chatClient.say(channel, replyText, { replyTo: msg.id });
    };

    try {
      await command.run({
        channel: channel.replace(/^#/, ""),
        userId: msg.userInfo.userId,
        userName: msg.userInfo.displayName,
        args,
        reply,
      });
    } catch (err) {
      logger.error({ err, command: name }, "Error executing Twitch command");
      await reply("Something went wrong running that command.");
    }
  });

  await chatClient.connect();

  // Watchtime is a bonus on top of chat, so its failures stay its own: a bad
  // token scope or an unreachable Helix shouldn't take the bot down with it.
  const watchtime = await startWatchtimeTracking(new ApiClient({ authProvider }), botUserId, scopes).catch(
    (err: unknown) => {
      logger.error({ err }, "Failed to start Twitch watchtime tracking");
      return null;
    },
  );

  return { chatClient, watchtime };
}
