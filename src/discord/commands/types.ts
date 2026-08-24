import type { ChatInputCommandInteraction, SlashCommandOptionsOnlyBuilder } from "discord.js";
import type { SlashCommandBuilder } from "discord.js";

export interface DiscordCommand {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}
