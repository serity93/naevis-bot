import type { DiscordCommand } from "./commands/types.js";
import { basicCommands } from "./commands/basic.js";
import { linkCommands } from "./commands/link.js";

export const allDiscordCommands: DiscordCommand[] = [...basicCommands, ...linkCommands];

export const discordCommandMap = new Map<string, DiscordCommand>(
  allDiscordCommands.map((c) => [c.data.name, c]),
);
