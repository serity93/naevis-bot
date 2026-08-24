import type { DiscordCommand } from "./commands/types.js";
import { basicCommands } from "./commands/basic.js";

export const allDiscordCommands: DiscordCommand[] = [...basicCommands];

export const discordCommandMap = new Map<string, DiscordCommand>(
  allDiscordCommands.map((c) => [c.data.name, c]),
);
