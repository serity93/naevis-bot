import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { RefreshingAuthProvider, type AccessToken } from "@twurple/auth";
import { config } from "../config.js";
import { logger } from "../logger.js";

const tokensPath = path.resolve("tokens/twitch.json");

export async function createTwitchAuthProvider() {
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

  await authProvider.addUserForToken(tokenData, ["chat"]);

  return authProvider;
}
