# naevis-bot

A personal bot that runs in both Redstellar's Discord server and Twitch channel.
Built with Node.js, TypeScript, discord.js, and Twurple.

twitch.tv/redstellar_

## Current scope

The bot connects and responds on both platforms: `ping`, `uptime`, `points`,
and `help`, implemented once in `src/core/commands` and exposed on both
Discord (as slash commands) and Twitch (as `!`-prefixed chat commands).

It tracks a per-platform identity record (`User` in Postgres) for anyone who
sends a message it sees on either platform — no command needed, just
first-seen/last-seen bookkeeping keyed by platform + external user id — and
awards points for chatting via an append-only ledger.

**Cross-platform account linking** ties those per-platform identities
together. Every `User` belongs to an `Account`; a newly seen identity gets an
`Account` of its own, and linking merges two of them so one person is one
internal id. The flow starts on Discord so the code stays private:

1. The user runs `/link` in Discord and gets a one-time code back as an
   ephemeral (only-they-can-see-it) reply.
2. They send `!link <code>` in Twitch chat — the stream doesn't have to be
   live — and the bot confirms in chat.

Codes last 10 minutes, and running `/link` again invalidates the previous
one. Points stay on the identity that earned them, so an account's total is
the sum of its identities and a per-platform breakdown survives linking.
Unlinking isn't implemented yet.

Not built yet, on purpose:

- **Moderation** — will be added once the specific rules/behavior are
  decided (warn/timeout/ban flows, word filtering, etc).
- **The idol gacha game** — groups/idols/images database, rolling, and
  community submissions.

## Project layout

```
src/
  core/            platform-agnostic logic: shared commands, user tracking, points, account linking
  discord/         discord.js client, slash commands, event handling
  twitch/          Twurple chat client, chat commands
  db/              Prisma client singleton
  config.ts        env var loading + validation (zod)
scripts/
  twitch-auth.ts               one-time OAuth flow to authorize the bot's Twitch account
  register-discord-commands.ts registers/updates Discord slash commands
prisma/
  schema.prisma    database schema
  migrations/      generated SQL migrations
```

## Setup

### 1. Discord application

1. Create an application + bot at https://discord.com/developers/applications.
2. Invite the bot to your server with the `bot` and `applications.commands`
   scopes (no privileged intents or special permissions are needed yet).
3. Copy the bot token and application (client) ID into `.env`.

### 2. Twitch application

1. Create an app at https://dev.twitch.tv/console/apps with redirect URI
   `http://localhost:3000/callback`.
2. Copy the client ID and secret into `.env`.
3. Set `TWITCH_CHANNELS` to your channel's login name.
4. Run the auth helper, logged in as the bot's Twitch account, to grant it a
   token and save it to `tokens/twitch.json`:

   ```bash
   npm run twitch:auth
   ```

### 3. Database

For local development outside Docker:

```bash
docker compose up -d postgres
npm run prisma:deploy
```

`DATABASE_URL` in `.env` already defaults to that local Postgres — adjust if
pointing elsewhere. (Running the full stack via Docker Compose, below,
applies migrations automatically on container start — this step is only
needed for `npm run dev`.)

### 4. Install, register commands, and run

```bash
npm install
npm run discord:register   # set DISCORD_DEV_GUILD_ID in .env first for instant propagation while developing
npm run dev
```

### Running everything with Docker Compose

Once `.env` and `tokens/twitch.json` exist:

```bash
docker compose up -d --build
```

This starts Postgres and the bot together, running migrations automatically.
