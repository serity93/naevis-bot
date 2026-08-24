import type { TwitchCommand, TwitchCommandContext } from "./types.js";
import { pingCommand, uptimeCommand } from "../../core/commands/shared.js";
import type { CommandContext } from "../../core/commands/types.js";

function toContext(ctx: TwitchCommandContext): CommandContext {
  return {
    platform: "twitch",
    args: ctx.args,
    authorId: ctx.userId,
    authorName: ctx.userName,
    reply: ctx.reply,
  };
}

export const ping: TwitchCommand = {
  name: "ping",
  description: pingCommand.description,
  async run(ctx) {
    await pingCommand.run(toContext(ctx));
  },
};

export const uptime: TwitchCommand = {
  name: "uptime",
  description: uptimeCommand.description,
  async run(ctx) {
    await uptimeCommand.run(toContext(ctx));
  },
};

export const help: TwitchCommand = {
  name: "help",
  description: "List available commands.",
  async run(ctx) {
    const names = ["ping", "uptime", "help"];
    await ctx.reply(`Available commands: ${names.map((n) => `!${n}`).join(", ")}`);
  },
};

export const basicCommands: TwitchCommand[] = [ping, uptime, help];
