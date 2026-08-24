export interface TwitchCommandContext {
  channel: string; // login name, no leading "#"
  userId: string;
  userName: string;
  args: string[];
  reply(text: string): Promise<void>;
}

export interface TwitchCommand {
  name: string;
  description: string;
  run(ctx: TwitchCommandContext): Promise<void>;
}
