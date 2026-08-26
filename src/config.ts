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
