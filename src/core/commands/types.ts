export type Platform = "discord" | "twitch";

// Minimal shared surface for commands that behave identically on both
// platforms (ping, help, etc). Anything that needs platform-specific power
// is implemented per-platform instead of forced through here — see
// src/discord/commands and src/twitch/commands.
export interface CommandContext {
  platform: Platform;
  args: string[];
  authorId: string;
  authorName: string;
  reply(text: string): Promise<void>;
}

export interface SharedCommand {
  name: string;
  description: string;
  run(ctx: CommandContext): Promise<void>;
}
