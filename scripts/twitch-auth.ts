// One-time (and re-runnable) helper to obtain a Twitch user OAuth token for
// the bot account via the Authorization Code flow, and save it to
// tokens/twitch.json where RefreshingAuthProvider picks it up at runtime.
import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import open from "open";
import { TWITCH_SCOPES } from "../src/twitch/scopes.js";

const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const redirectUri = "http://localhost:3000/callback";
const tokensDir = path.resolve("tokens");
const tokensPath = path.join(tokensDir, "twitch.json");

if (!clientId || !clientSecret) {
  console.error("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const authorizeUrl = new URL("https://id.twitch.tv/oauth2/authorize");
authorizeUrl.searchParams.set("client_id", clientId);
authorizeUrl.searchParams.set("redirect_uri", redirectUri);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("scope", TWITCH_SCOPES.join(" "));

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.writeHead(404).end();
    return;
  }

  const url = new URL(req.url, redirectUri);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error_description");

  if (error) {
    res.writeHead(400).end(`Authorization failed: ${error}`);
    console.error("Authorization failed:", error);
    server.close(() => process.exit(1));
    return;
  }

  if (!code) {
    res.writeHead(400).end("Missing code");
    return;
  }

  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    res.writeHead(500).end("Token exchange failed, see terminal.");
    console.error("Token exchange failed:", text);
    server.close(() => process.exit(1));
    return;
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string[];
  };

  mkdirSync(tokensDir, { recursive: true });
  writeFileSync(
    tokensPath,
    JSON.stringify(
      {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresIn: tokenData.expires_in,
        obtainmentTimestamp: Date.now(),
        scope: tokenData.scope,
      },
      null,
      2,
    ),
  );

  res
    .writeHead(200, { "Content-Type": "text/plain" })
    .end("Authorized! You can close this tab and return to the terminal.");
  console.log(`Saved Twitch tokens to ${tokensPath}`);
  server.close(() => process.exit(0));
});

server.listen(3000, async () => {
  console.log("Opening browser to authorize the bot's Twitch account...");
  console.log(`If it doesn't open automatically, visit:\n${authorizeUrl.toString()}\n`);
  await open(authorizeUrl.toString());
});
