import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_DEV_GUILD_ID: z.string().optional(),

  TWITCH_CLIENT_ID: z.string().min(1),
  TWITCH_CLIENT_SECRET: z.string().min(1),
  TWITCH_CHANNELS: z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
    ),
  TWITCH_COMMAND_PREFIX: z.string().default("!"),

  // z.coerce.boolean() would read the string "false" as true, so the accepted
  // values are spelled out instead.
  TWITCH_WATCHTIME_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Logins that shouldn't earn watchtime — other bots parked in the channel.
  // The bot's own account is excluded automatically.
  TWITCH_WATCHTIME_IGNORED_USERS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((u) => u.trim().toLowerCase())
        .filter(Boolean),
    ),

  // --- AI chat ---
  // Off by default so an existing deployment that pulls this change and
  // restarts doesn't start throwing connection errors at an Ollama that isn't
  // running. Opting in is one line in .env.
  AI_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AI_PROVIDER: z.enum(["ollama"]).default("ollama"),
  AI_BASE_URL: z.string().url().default("http://localhost:11434"),
  AI_MODEL: z.string().default("qwen2.5:3b-instruct-q4_K_M"),
  // Ollama unloads the model after 5 minutes by default. On modest hardware a
  // reload costs 5-15 seconds, paid by whoever mentions the bot next, so it is
  // kept warm instead. "-1" pins it resident indefinitely.
  AI_KEEP_ALIVE: z.string().default("30m"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(160),
  AI_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(500),
  AI_MAX_REPLY_CHARS: z.coerce.number().int().positive().default(400),
  AI_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(15_000),
  // One generation at a time plus this many waiting. See core/ai/limits.ts for
  // why the concurrency itself isn't configurable.
  AI_QUEUE_LIMIT: z.coerce.number().int().nonnegative().default(2),
  // 6 turns is 3 exchanges. Raising it makes replies worse as well as slower —
  // a 3B model loses the thread past a few turns. 0 disables the buffer and
  // falls back to single-turn replies. See core/ai/history.ts.
  AI_HISTORY_TURNS: z.coerce.number().int().nonnegative().default(6),
  AI_HISTORY_MAX_CHARS: z.coerce.number().int().positive().default(1200),
  // Idle window before a channel's buffer is dropped. A conversation resumed
  // three hours later produces confident non-sequiturs, which read worse than
  // having no memory at all.
  AI_HISTORY_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(20 * 60 * 1000),
  // Channel ids the bot will chat in. Empty means anywhere it can see, the
  // same way TWITCH_WATCHTIME_IGNORED_USERS treats empty as "nobody excluded".
  DISCORD_AI_CHANNELS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
    ),
  // Twitch chat is a firehose compared to a Discord channel, so it opts in
  // separately even once AI_ENABLED is on.
  TWITCH_AI_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  DATABASE_URL: z.string().min(1),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
