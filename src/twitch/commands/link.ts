import type { TwitchCommand } from "./types.js";
import { config } from "../../config.js";
import { recordUserSeen } from "../../core/users/userService.js";
import { redeemLinkCode } from "../../core/accounts/accountService.js";

export const link: TwitchCommand = {
  name: "link",
  description: "Finish linking your Twitch account using a code from Discord.",
  async run(ctx) {
    const prefix = config.TWITCH_COMMAND_PREFIX;
    const code = ctx.args[0];
    if (!code) {
      await ctx.reply(`Usage: ${prefix}link <code> — run /link in Discord first to get your code.`);
      return;
    }

    const identity = await recordUserSeen("TWITCH", ctx.userId, ctx.userName);
    const result = await redeemLinkCode(code, identity.id);

    if (result.ok) {
      const discord = result.identities.find((i) => i.platform === "DISCORD");
      await ctx.reply(
        discord
          ? `Linked! Your Twitch and Discord (${discord.username}) accounts are now one account.`
          : "Linked! Your Twitch and Discord accounts are now one account.",
      );
      return;
    }

    switch (result.reason) {
      case "EXPIRED_CODE":
        await ctx.reply("That code has expired. Run /link in Discord again to get a fresh one.");
        return;
      case "INVALID_CODE":
        await ctx.reply(`That code isn't valid. Check it for typos, or run /link in Discord for a new one.`);
        return;
      case "SAME_ACCOUNT":
        await ctx.reply("You've already linked these accounts.");
        return;
      case "PLATFORM_CONFLICT":
        // The clashing platform says which side was already spoken for: our own
        // platform means the code's Discord user already has a Twitch account.
        await ctx.reply(
          result.platform === "TWITCH"
            ? "That Discord account is already linked to a different Twitch account."
            : "Your Twitch account is already linked to a different Discord account.",
        );
        return;
    }
  },
};

export const linkCommands: TwitchCommand[] = [link];
