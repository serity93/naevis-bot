import { Platform as DbPlatform } from "@prisma/client";
import type { Platform } from "./commands/types.js";

// The command layer speaks lowercase platform names; the database enum is
// uppercase. This is the one place that bridges the two.
export function toDbPlatform(platform: Platform): DbPlatform {
  return platform === "discord" ? DbPlatform.DISCORD : DbPlatform.TWITCH;
}
