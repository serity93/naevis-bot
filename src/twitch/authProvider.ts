import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { RefreshingAuthProvider, type AccessToken } from "@twurple/auth";
import { config } from "../config.js";
import { logger } from "../logger.js";

const tokensPath = path.resolve("tokens/twitch.json");

export interface TwitchAuth {
  authProvider: RefreshingAuthProvider;
  // The bot account's own user id. Helix calls made as a moderator have to name
  // the acting user, and it's also what the bot excludes itself by.
  botUserId: string;
  // What the saved token was actually granted, which is not necessarily what
  // TWITCH_SCOPES asks for — a token minted before a scope was added keeps
  // working, just without it, until the auth helper is re-run.
  scopes: string[];
}

export async function createTwitchAuthProvider(): Promise<TwitchAuth> {
  if (!existsSync(tokensPath)) {
    throw new Error(
      `No Twitch tokens found at ${tokensPath}. Run "npm run twitch:auth" first to authorize the bot account.`,
    );
  }

  const tokenData = JSON.parse(readFileSync(tokensPath, "utf-8")) as AccessToken;

  const authProvider = new RefreshingAuthProvider({
    clientId: config.TWITCH_CLIENT_ID,
    clientSecret: config.TWITCH_CLIENT_SECRET,
  });

  authProvider.onRefresh((_userId, newTokenData) => {
    writeFileSync(tokensPath, JSON.stringify(newTokenData, null, 2));
    logger.debug("Refreshed and saved Twitch tokens");
  });

  const botUserId = await authProvider.addUserForToken(tokenData, ["chat"]);

  return { authProvider, botUserId, scopes: tokenData.scope ?? [] };
}
