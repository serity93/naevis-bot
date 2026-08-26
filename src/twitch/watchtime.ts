import type { ApiClient } from "@twurple/api";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { recordWatchtimeActivity } from "../core/activity/activityService.js";

// Twitch has no event for "a viewer started watching" — EventSub doesn't cover
// viewer presence, and IRC JOIN/PART stops being delivered above 1,000 chatters
// — so presence is sampled by polling the chatters endpoint instead.
//
// Worth being clear about what that measures: Get Chatters returns who is
// connected to the *chat room*, not who has the video playing. Someone watching
// on a TV app with chat closed may not appear; someone idling on the chat tab
// with the player paused will. Every watchtime system on Twitch works this way,
// because nothing better is exposed.
export const CHATTERS_SCOPE = "moderator:read:chatters";

// How often the audience is sampled. Well under the 10-minute payout interval
// on purpose: viewers are credited for the time since the previous sample, so a
// single failed poll costs a minute rather than a whole payout, and nobody can
// farm points by connecting just before a tick fires.
const POLL_INTERVAL_MS = 60_000;

// The most a single sample will ever credit. A paused process, a long API
// outage or a clock jump would otherwise hand out a windfall on the next
// successful poll.
const MAX_CREDIT_SECONDS = (POLL_INTERVAL_MS / 1000) * 2;

interface ChannelState {
  login: string;
  broadcasterId: string;
  // When the last successful sample was taken, or null when the channel is
  // offline or hasn't been sampled since it came online.
  lastSampleAt: number | null;
  // Set when Twitch refuses the request in a way that won't fix itself.
  disabled: boolean;
}

export interface WatchtimeTracker {
  stop(): void;
}

// Starts sampling the audience of every configured channel. Returns null when
// tracking can't run at all, which is a normal state, not a failure — chat
// carries on regardless.
export async function startWatchtimeTracking(
  apiClient: ApiClient,
  botUserId: string,
  grantedScopes: string[],
): Promise<WatchtimeTracker | null> {
  if (!config.TWITCH_WATCHTIME_ENABLED) {
    logger.info("Twitch watchtime tracking is disabled by config");
    return null;
  }

  if (!grantedScopes.includes(CHATTERS_SCOPE)) {
    logger.warn(
      { scope: CHATTERS_SCOPE },
      'Twitch token was issued without the chatters scope, so watchtime tracking is off. Re-run "npm run twitch:auth" to grant it.',
    );
    return null;
  }

  const channels = await resolveChannels(apiClient);
  if (channels.length === 0) {
    logger.warn("No resolvable Twitch channels, watchtime tracking is off");
    return null;
  }

  const ignoredLogins = new Set(config.TWITCH_WATCHTIME_IGNORED_USERS);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const tick = async () => {
    for (const channel of channels) {
      if (channel.disabled) continue;
      try {
        await sampleChannel(apiClient, botUserId, channel, ignoredLogins);
      } catch (err) {
        // 401 means the token no longer carries the scope, 403 that the bot
        // isn't a moderator in this channel. Neither recovers on its own, so
        // stop asking rather than logging the same failure every minute.
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 401 || statusCode === 403) {
          channel.disabled = true;
          logger.error(
            { err, channel: channel.login },
            "Not allowed to read chatters — is the bot a moderator in this channel? Watchtime tracking for it is now off.",
          );
        } else {
          logger.error({ err, channel: channel.login }, "Watchtime sample failed");
        }
      }
    }
  };

  // Chained timeouts rather than setInterval, so a slow sample delays the next
  // one instead of overlapping with it.
  const schedule = () => {
    timer = setTimeout(() => {
      void tick().finally(() => {
        if (!stopped) schedule();
      });
    }, POLL_INTERVAL_MS);
  };

  logger.info(
    { channels: channels.map((c) => c.login), intervalMs: POLL_INTERVAL_MS },
    "Twitch watchtime tracking started",
  );

  // Sample immediately so the baseline is in place before the first interval
  // elapses; the first sample of a stream never credits anything itself.
  void tick().finally(() => {
    if (!stopped) schedule();
  });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// TWITCH_CHANNELS holds login names but Helix wants ids, so they're resolved
// once at startup. A channel that can't be resolved is skipped rather than
// treated as fatal — the others should still earn.
async function resolveChannels(apiClient: ApiClient): Promise<ChannelState[]> {
  const logins = config.TWITCH_CHANNELS.map((c) => c.toLowerCase());
  const users = await apiClient.users.getUsersByNames(logins);
  const idByLogin = new Map(users.map((u) => [u.name, u.id]));

  const channels: ChannelState[] = [];
  for (const login of logins) {
    const broadcasterId = idByLogin.get(login);
    if (!broadcasterId) {
      logger.warn({ channel: login }, "Twitch channel not found, skipping watchtime tracking for it");
      continue;
    }
    channels.push({ login, broadcasterId, lastSampleAt: null, disabled: false });
  }
  return channels;
}

async function sampleChannel(
  apiClient: ApiClient,
  botUserId: string,
  channel: ChannelState,
  ignoredLogins: Set<string>,
): Promise<void> {
  // Offline channels earn nothing: the chat room stays populated long after a
  // stream ends, and paying for that is paying people to idle. Clearing the
  // baseline also means the gap until the next stream is never credited.
  const stream = await apiClient.streams.getStreamByUserId(channel.broadcasterId);
  if (!stream) {
    channel.lastSampleAt = null;
    return;
  }

  // asUser pins the call to the bot's token. getChatters otherwise defaults to
  // the broadcaster's, which the bot doesn't hold — it reads the list as a
  // moderator instead.
  const chatters = await apiClient.asUser(botUserId, (ctx) =>
    ctx.chat.getChattersPaginated(channel.broadcasterId).getAll(),
  );

  const now = Date.now();
  const previous = channel.lastSampleAt;

  // Advanced before anything is credited, so a database failure below loses
  // this interval instead of rolling it into the next sample and paying twice.
  channel.lastSampleAt = now;

  // The first sample after a stream comes online only establishes the baseline
  // that the next one measures against.
  if (previous === null) return;

  const seconds = Math.min(Math.round((now - previous) / 1000), MAX_CREDIT_SECONDS);
  if (seconds <= 0) return;

  const viewers = chatters
    .filter((c) => c.userId !== botUserId && !ignoredLogins.has(c.userName.toLowerCase()))
    .map((c) => ({ externalId: c.userId, username: c.userDisplayName }));
  if (viewers.length === 0) return;

  const awards = await recordWatchtimeActivity("TWITCH", viewers, seconds);
  logger.debug(
    { channel: channel.login, viewers: viewers.length, seconds, paid: awards.length },
    "Watchtime sample recorded",
  );
}
