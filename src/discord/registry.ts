import type { DiscordCommand } from "./commands/types.js";
import { basicCommands } from "./commands/basic.js";
import { linkCommands } from "./commands/link.js";
import { reactionRoleCommands } from "./commands/reactionRoles.js";
import { autoRoleCommands } from "./commands/autoRole.js";

export const allDiscordCommands: DiscordCommand[] = [
  ...basicCommands,
  ...linkCommands,
  ...reactionRoleCommands,
  ...autoRoleCommands,
];

export const discordCommandMap = new Map<string, DiscordCommand>(
  allDiscordCommands.map((c) => [c.data.name, c]),
);
