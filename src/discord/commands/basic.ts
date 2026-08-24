import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommand } from "./types.js";
import { pingCommand, uptimeCommand, sharedCommands } from "../../core/commands/shared.js";
import type { CommandContext } from "../../core/commands/types.js";

function toContext(interaction: Parameters<DiscordCommand["execute"]>[0]): CommandContext {
  return {
    platform: "discord",
    args: [],
    authorId: interaction.user.id,
    authorName: interaction.user.username,
    reply: async (text: string) => {
      await interaction.reply(text);
    },
  };
}

export const ping: DiscordCommand = {
  data: new SlashCommandBuilder().setName("ping").setDescription(pingCommand.description),
  async execute(interaction) {
    await pingCommand.run(toContext(interaction));
  },
};

export const uptime: DiscordCommand = {
  data: new SlashCommandBuilder().setName("uptime").setDescription(uptimeCommand.description),
  async execute(interaction) {
    await uptimeCommand.run(toContext(interaction));
  },
};

export const help: DiscordCommand = {
  data: new SlashCommandBuilder().setName("help").setDescription("List available commands."),
  async execute(interaction) {
    const names = [...sharedCommands.map((c) => c.name), "help"];
    await interaction.reply(`Available commands: ${names.map((n) => `\`/${n}\``).join(", ")}`);
  },
};

export const basicCommands: DiscordCommand[] = [ping, uptime, help];
