import type { SharedCommand } from "./types.js";

const startedAt = Date.now();

export const pingCommand: SharedCommand = {
  name: "ping",
  description: "Check whether the bot is alive and responsive.",
  async run(ctx) {
    await ctx.reply("Pong!");
  },
};

export const uptimeCommand: SharedCommand = {
  name: "uptime",
  description: "Show how long the bot has been running.",
  async run(ctx) {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    await ctx.reply(`Uptime: ${h}h ${m}m ${s}s`);
  },
};

export const sharedCommands: SharedCommand[] = [pingCommand, uptimeCommand];
