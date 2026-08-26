import { config } from "../../config.js";

// Exactly one generation at a time. This is not configurable on purpose: the
// target hardware is a 4GB card running a small model, where a second
// concurrent request doesn't run in parallel — it makes both slower and risks
// pushing the KV cache out of VRAM into a partial CPU offload, which is a
// cliff rather than a slope. If this ever runs on a card that can genuinely
// serve two, that is a deliberate change with a benchmark behind it.
const MAX_CONCURRENT = 1;

// Above this many tracked users, sweep the expired entries. A plain size check
// rather than a timer, because the Map only grows when someone talks to the
// bot and there's no reason to wake up otherwise.
const COOLDOWN_PRUNE_AT = 1000;

// Deliberately in memory, unlike the message-points cooldown in
// core/points/pointsService.ts. That one guards a currency, so it is a
// race-safe conditional UPDATE with the predicate in the WHERE clause — two
// messages arriving together must not both pay out. This one guards a GPU.
// Losing it across a restart costs at most one extra reply; a stale entry
// costs one missed reply. Neither is worth a database round trip on every
// mention, and there is exactly one bot process, so a Map is not just simpler
// but strictly more correct about what is actually contended: this process's
// GPU slot.
const lastReplyAt = new Map<string, number>();

/**
 * Claim this user's cooldown slot, returning false if they used it too
 * recently. Keys are namespaced "platform:externalId" rather than the internal
 * User.id — the AI path never touches Prisma and shouldn't start to just to
 * build a cooldown key.
 */
export function takeCooldownSlot(key: string, now = Date.now()): boolean {
  const previous = lastReplyAt.get(key);
  if (previous !== undefined && now - previous < config.AI_COOLDOWN_MS) return false;

  if (lastReplyAt.size >= COOLDOWN_PRUNE_AT) {
    for (const [entryKey, at] of lastReplyAt) {
      if (now - at >= config.AI_COOLDOWN_MS) lastReplyAt.delete(entryKey);
    }
  }

  lastReplyAt.set(key, now);
  return true;
}

export type SlotRelease = () => void;

interface Waiter {
  resolve: (release: SlotRelease | null) => void;
  timer: NodeJS.Timeout;
}

let active = 0;
const waiting: Waiter[] = [];

function makeRelease(): SlotRelease {
  let released = false;
  return () => {
    // Idempotent. A double release would let two generations run at once,
    // which is the one thing this file exists to prevent, and callers invoke
    // it from a finally block where a second call is easy to introduce.
    if (released) return;
    released = true;

    const next = waiting.shift();
    if (next) {
      // Hand the slot straight over rather than decrementing and letting the
      // waiter re-acquire: dropping to zero in between opens a window for a
      // brand-new request to jump the queue.
      clearTimeout(next.timer);
      next.resolve(makeRelease());
      return;
    }
    active -= 1;
  };
}

/**
 * Wait for the single generation slot, giving up at `deadline`.
 *
 * The deadline is passed in rather than derived here so that it can start when
 * the request was accepted, not when the slot was acquired — otherwise someone
 * queued behind two others waits their own full timeout on top of everyone
 * else's, and a reply arrives long after the conversation moved on.
 *
 * Returns null when the queue is already full or the deadline passes first. A
 * short queue rather than an outright refusal because a two-person
 * conversation naturally overlaps by a few seconds, and making the second
 * person retry for that would feel broken; past the limit an honest "busy"
 * beats an unbounded backlog, since a queue of ten here is a minute of latency.
 */
export async function acquireSlot(deadline: number): Promise<SlotRelease | null> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return makeRelease();
  }

  if (waiting.length >= config.AI_QUEUE_LIMIT) return null;

  const wait = deadline - Date.now();
  if (wait <= 0) return null;

  return new Promise<SlotRelease | null>((resolve) => {
    const waiter: Waiter = {
      resolve,
      timer: setTimeout(() => {
        const index = waiting.indexOf(waiter);
        if (index !== -1) waiting.splice(index, 1);
        resolve(null);
      }, wait),
    };
    waiting.push(waiter);
  });
}

/** How many requests are queued behind the active one. Logging only. */
export function queueDepth(): number {
  return waiting.length;
}
