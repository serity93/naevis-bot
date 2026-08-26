import type { SharedCommand } from "./types.js";
import { toDbPlatform } from "../platform.js";
import { getPointsFor } from "../points/pointsService.js";

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

export const pointsCommand: SharedCommand = {
  name: "points",
  description: "Check how many points you have.",
  async run(ctx) {
    const points = await getPointsFor(toDbPlatform(ctx.platform), ctx.authorId);
    if (points === 0) {
      await ctx.reply("You don't have any points yet — chat a little and they'll start rolling in.");
      return;
    }
    await ctx.reply(`You have ${points} point${points === 1 ? "" : "s"}.`);
  },
};

export const naevisbotCommand: SharedCommand = {
  name: "naevisbot",
  description: "Learn who NaevisBot is.",
  async run(ctx) {
    await ctx.reply(
      "Hello! I am NaevisBot, based on the virtual idol Naevis from the digital world KWANGYA. Nice to meet you!",
    );
  },
};

export const sharedCommands: SharedCommand[] = [pingCommand, uptimeCommand, pointsCommand, naevisbotCommand];
