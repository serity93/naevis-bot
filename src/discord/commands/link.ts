import { SlashCommandBuilder, MessageFlags } from "discord.js";
import type { DiscordCommand } from "./types.js";
import { config } from "../../config.js";
import { recordUserSeen } from "../../core/users/userService.js";
import { createLinkCode, getIdentityForPlatform } from "../../core/accounts/accountService.js";

export const LINK_DESCRIPTION = "Link your Twitch account to your Discord account.";

export const link: DiscordCommand = {
  data: new SlashCommandBuilder().setName("link").setDescription(LINK_DESCRIPTION),
  async execute(interaction) {
    // Linking is only ever discussed in private: the code is a bearer token for
    // this user's account, so every reply on this path is ephemeral.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // The user may never have spoken in a channel the bot can read, so don't
    // assume message tracking has given them an identity yet.
    const identity = await recordUserSeen("DISCORD", interaction.user.id, interaction.user.username);

    const twitch = await getIdentityForPlatform(identity.accountId, "TWITCH");
    if (twitch) {
      await interaction.editReply(
        `Your Discord account is already linked to Twitch user **${twitch.username}**.`,
      );
      return;
    }

    const { code, expiresAt } = await createLinkCode(identity.accountId);
    const prefix = config.TWITCH_COMMAND_PREFIX;
    const expiresUnix = Math.floor(expiresAt.getTime() / 1000);

    await interaction.editReply(
      [
        "To finish linking, send this in Twitch chat — the stream doesn't have to be live:",
        "",
        `\`${prefix}link ${code}\``,
        "",
        `This code expires <t:${expiresUnix}:R>. Running \`/link\` again issues a new code and invalidates this one.`,
      ].join("\n"),
    );
  },
};

export const linkCommands: DiscordCommand[] = [link];
