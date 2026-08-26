# naevis-bot

A personal bot that runs in both Redstellar's Discord server and Twitch channel.
Built with Node.js, TypeScript, discord.js, and Twurple.

twitch.tv/redstellar_

## Current scope

The bot connects and responds on both platforms: `ping`, `uptime`, `points`,
`naevisbot`, `forget`, and `help`, implemented once in `src/core/commands`
and exposed on both Discord (as slash commands) and Twitch (as `!`-prefixed
chat commands).

**AI chat** lets the bot hold a short conversation in persona when it is
@-mentioned or when someone replies to one of its messages, on either
platform. Generation runs on a local [Ollama](https://ollama.com) server, so
there are no API keys and nothing leaves the machine. It is off by default —
see [AI chat](#5-ai-chat-optional) below.

Its memory is deliberately small: the last few exchanges **per channel**,
held in process memory. It forgets after 20 idle minutes, forgets on
restart, and forgets when anyone runs `forget` (or just says "forget" at
it). Nothing about a conversation is written to the database.

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

Linking pays a one-time reward of 100 points to _each_ identity — 200 in
total — written to the ledger as `ACCOUNT_LINK` inside the same transaction
as the merge, so the reward and the link can never come apart.

Unlinking isn't implemented yet. When it lands it will need to decide what
happens to that reward, or re-linking becomes a way to farm it.

**Watchtime points** pay 5 points per 10 minutes spent present in a live
Twitch stream, on top of anything earned by chatting — so a lurker earns 5 per
10 minutes and someone talking earns 10. Discord has no equivalent and doesn't
take part.

Twitch exposes no event for a viewer arriving or leaving: EventSub doesn't
cover viewer presence, and IRC `JOIN`/`PART` stops being delivered above 1,000
chatters. So presence is _sampled_ — once a minute the bot asks Helix who is
connected to the chat room, and credits each of them with the time since the
previous sample. Points are paid whenever a viewer's lifetime total crosses a
10-minute boundary. Sampling far more often than the payout interval means a
failed poll costs a minute rather than a whole payout, and nobody can farm by
connecting just before a tick.

Worth being clear about what this measures: Twitch reports who is connected to
_chat_, not who has the video playing. Someone watching on a TV app with chat
closed may not be counted; someone idling on the chat tab with the player
paused will be. There's no better signal available — every watchtime system on
Twitch works this way.

Only live channels are sampled, so the chat room staying populated after a
stream ends doesn't pay anyone.

This needs the bot account to be a **moderator** in each tracked channel, and
its token to carry `moderator:read:chatters`. If either is missing the bot logs
why and carries on without watchtime; chat is unaffected. Two env vars tune it:
`TWITCH_WATCHTIME_ENABLED` (`true`/`false`, default `true`) and
`TWITCH_WATCHTIME_IGNORED_USERS`, a comma-separated list of logins that
shouldn't earn — other bots parked in the channel. The bot excludes itself.

Not built yet, on purpose:

- **Moderation** — will be added once the specific rules/behavior are
  decided (warn/timeout/ban flows, word filtering, etc).
- **The idol gacha game** — groups/idols/images database, rolling, and
  community submissions.

## Project layout

```
src/
  core/            platform-agnostic logic: shared commands, user tracking, points, watchtime accrual, account linking
  core/ai/         persona, prompt assembly, Ollama provider, rate limits, conversation buffer
  discord/         discord.js client, slash commands, event handling
  twitch/          Twurple chat client, chat commands, watchtime polling
  db/              Prisma client singleton
  config.ts        env var loading + validation (zod)
scripts/
  twitch-auth.ts               one-time OAuth flow to authorize the bot's Twitch account
  register-discord-commands.ts registers/updates Discord slash commands
  ai-smoke.ts                  exercises the AI layer without Discord or Twitch
prisma/
  schema.prisma    database schema
  migrations/      generated SQL migrations
```

## Setup

### 1. Discord application

1. Create an application + bot at https://discord.com/developers/applications.
2. Invite the bot to your server with the `bot` and `applications.commands`
   scopes. No special permissions are needed beyond reading and sending
   messages in the channels you want it in.
3. Enable the **Message Content** privileged intent under Bot → Privileged
   Gateway Intents. It is free to turn on while the bot is in fewer than 100
   servers, and AI chat needs it: without it Discord blanks message content
   everywhere except messages that directly mention the bot, so replying to
   the bot with the ping toggled off (one click in Discord's reply box)
   arrives empty and goes unanswered. Everything else works without it.
4. Copy the bot token and application (client) ID into `.env`.

### 2. Twitch application

1. Create an app at https://dev.twitch.tv/console/apps with redirect URI
   `http://localhost:3000/callback`.
2. Copy the client ID and secret into `.env`.
3. Set `TWITCH_CHANNELS` to your channel's login name.
4. Make the bot's Twitch account a moderator in each of those channels
   (`/mod <bot account>` in chat). Watchtime points need this — Twitch only
   grants `moderator:read:chatters` to a moderator of the channel being read.
5. Run the auth helper, logged in as the bot's Twitch account, to grant it a
   token and save it to `tokens/twitch.json`:

   ```bash
   npm run twitch:auth
   ```

   Re-run this after pulling changes that add a scope — an existing token keeps
   working without the new scope, and the bot will log which feature it had to
   skip as a result.

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

### 5. AI chat (optional)

Generation runs on a local Ollama server. `docker-compose.yml` already
defines an `ollama` service with an NVIDIA GPU reservation, on the compose
network only — Ollama has no authentication of any kind, so its port is
deliberately not published to the host.

1. Start it and pull the model (~2GB, stored in the `ollama-models` volume so
   it survives rebuilds):

   ```bash
   docker compose up -d ollama
   docker compose exec ollama ollama pull qwen2.5:3b-instruct-q4_K_M
   ```

2. **Confirm the GPU is actually being used.** This is the difference between
   the feature working and being unusable, and it is invisible from the
   bot's side:

   ```bash
   docker compose exec ollama nvidia-smi
   docker compose exec ollama ollama ps
   ```

   `ollama ps` must show `100% GPU` in the PROCESSOR column. On CPU a reply
   takes 20-40 seconds instead of 2-5, at which point it isn't worth turning
   on.

   On Windows this goes through Docker Desktop's WSL2 backend, which needs a
   current NVIDIA driver on the Windows side (do not install a driver inside
   WSL) and WSL Integration enabled under Settings → Resources. If the GPU
   doesn't come through, install Ollama natively on Windows instead, delete
   the `ollama` service and its volume from `docker-compose.yml`, and point
   the bot at `http://host.docker.internal:11434` — Docker Desktop resolves
   that name automatically. Native Ollama binds loopback only, so it also
   needs `OLLAMA_HOST=0.0.0.0:11434`; firewall port 11434 to the Docker
   bridge subnet if you do that, since it is unauthenticated.

3. Set `AI_ENABLED=true` in `.env` and restart the bot. `npm run dev` uses
   `AI_BASE_URL=http://localhost:11434`, which the `ollama` service publishes
   on loopback only; under Compose the `bot` service overrides it to
   `http://ollama:11434` and reaches it over the compose network instead.

4. Check the whole prompt-and-persona loop without touching a real channel:

   ```bash
   npm run ai:smoke -- "hey naevis, how are you?"
   ```

   It prints the assembled prompt, tokens/sec (single digits means Ollama
   fell back to CPU), the post-processed reply for both platforms, an
   injection probe, and a four-turn conversation showing how the memory
   buffer grows.

Scoping: `DISCORD_AI_CHANNELS` takes a comma-separated list of channel ids
(empty means anywhere the bot can see). Twitch chat opts in separately via
`TWITCH_AI_ENABLED`, since it is a firehose next to a Discord channel.

Editing the persona means editing `src/core/ai/persona.ts` and rebuilding —
it lives in code so changes get diffed and reviewed like any other behaviour
change.

### Running everything with Docker Compose

Once `.env` and `tokens/twitch.json` exist:

```bash
docker compose up -d --build
```

This starts Postgres, Ollama and the bot together, running migrations
automatically. If you have never pulled the model, do that once after the
first `up` (see AI chat above) — the bot will run without it and log that AI
chat is off until you do.
