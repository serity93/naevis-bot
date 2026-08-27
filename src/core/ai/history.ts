import { config } from "../../config.js";
import type { AiMessage } from "./types.js";

interface Turn {
  role: "user" | "assistant";
  content: string;
  at: number;
}

// Keyed by "platform:channelId", not by user. The bot sits in a group chat, so
// a buffer scoped to one person would answer "what were we just saying?" with
// the wrong conversation. The cost is interleaving — several people talking to
// the bot at once collapse into a single thread — which is why every user turn
// carries a name prefix when it is recorded: the model needs some way to tell
// them apart.
//
// Nothing here is persisted. The buffer is worth losing on restart: it is a
// few minutes of small talk, and a database round trip per message to keep it
// would cost more than it saves.
const buffers = new Map<string, Turn[]>();

/** Build the cache key for a channel. */
export function historyKey(platform: string, channelId: string): string {
  return `${platform}:${channelId}`;
}

function isFresh(turn: Turn, now: number): boolean {
  return now - turn.at < config.AI_HISTORY_TTL_MS;
}

/**
 * The conversation so far, oldest first, ready to splice into a prompt.
 *
 * Three independent bounds apply, because they fail differently:
 *  - AI_HISTORY_TURNS caps how far back the model can see. A 3B model starts
 *    contradicting itself past a few turns, so a bigger buffer makes replies
 *    worse, not just slower.
 *  - AI_HISTORY_MAX_CHARS caps prompt size. Turn count alone doesn't bound it
 *    when someone pastes a paragraph.
 *  - AI_HISTORY_TTL_MS caps age. A conversation resumed hours later produces
 *    confident non-sequiturs, which read worse than having no memory at all.
 */
export function getHistory(key: string, now = Date.now()): AiMessage[] {
  if (config.AI_HISTORY_TURNS === 0) return [];

  const buffer = buffers.get(key);
  if (!buffer) return [];

  const fresh = buffer.filter((turn) => isFresh(turn, now));
  if (fresh.length !== buffer.length) {
    if (fresh.length === 0) buffers.delete(key);
    else buffers.set(key, fresh);
  }

  let selected = fresh.slice(-config.AI_HISTORY_TURNS);

  // Trim oldest-first until the character budget is met. Dropping from the
  // front keeps the most recent exchange, which is the one the next reply
  // actually has to follow on from.
  let total = selected.reduce((sum, turn) => sum + turn.content.length, 0);
  while (selected.length > 0 && total > config.AI_HISTORY_MAX_CHARS) {
    const [dropped] = selected;
    if (!dropped) break;
    total -= dropped.content.length;
    selected = selected.slice(1);
  }

  // A buffer that opens on an assistant turn reads to the model as if it spoke
  // unprompted, which encourages it to keep monologuing. Drop the orphan.
  if (selected[0]?.role === "assistant") selected = selected.slice(1);

  return selected.map((turn) => ({ role: turn.role, content: turn.content }));
}

/**
 * Record a completed exchange.
 *
 * Both turns go in together, and only on success. A half-exchange — a question
 * with no answer, left behind by a timeout or a busy refusal — teaches the
 * model that questions go unanswered, and it starts producing replies to match.
 *
 * `assistantContent` should be the post-processed text that was actually
 * posted, not the raw model output: what the buffer holds has to be what chat
 * saw, or the bot will refer back to sentences nobody read.
 */
export function recordExchange(
  key: string,
  userContent: string,
  assistantContent: string,
  now = Date.now(),
): void {
  if (config.AI_HISTORY_TURNS === 0) return;

  pruneStaleChannels(now);

  const buffer = buffers.get(key) ?? [];
  buffer.push({ role: "user", content: userContent, at: now });
  buffer.push({ role: "assistant", content: assistantContent, at: now });

  // Keep a little slack over the turn cap so a raised AI_HISTORY_TURNS has
  // something to work with, but not so much that the array grows unbounded.
  buffers.set(key, buffer.slice(-(config.AI_HISTORY_TURNS * 2)));
}

/** Drop a channel's buffer. Returns whether there was anything to drop. */
export function clearHistory(key: string): boolean {
  return buffers.delete(key);
}

/**
 * Evict whole channels that have gone quiet. Runs on write rather than on a
 * timer: the Map only grows when someone talks to the bot, so there is nothing
 * to clean up at any other moment.
 */
function pruneStaleChannels(now: number): void {
  for (const [key, turns] of buffers) {
    const newest = turns[turns.length - 1];
    if (!newest || !isFresh(newest, now)) buffers.delete(key);
  }
}

/** Number of channels currently holding a buffer. Logging and smoke tests. */
export function trackedChannelCount(): number {
  return buffers.size;
}
