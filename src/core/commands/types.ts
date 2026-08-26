export type Platform = "discord" | "twitch";

// Minimal shared surface for commands that behave identically on both
// platforms (ping, help, etc). Anything that needs platform-specific power
// is implemented per-platform instead of forced through here — see
// src/discord/commands and src/twitch/commands.
export interface CommandContext {
  platform: Platform;
  args: string[];
  // Where the command was used. Platform-native id: a Discord channel id, a
  // Twitch channel login. Shared commands that act on a place rather than on
  // a person need it — see forgetCommand.
  channelId: string;
  authorId: string;
  authorName: string;
  reply(text: string): Promise<void>;
}

export interface SharedCommand {
  name: string;
  description: string;
  run(ctx: CommandContext): Promise<void>;
}
