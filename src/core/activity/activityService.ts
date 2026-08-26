import type { Platform } from "@prisma/client";
import { recordUserSeen } from "../users/userService.js";
import { awardMessagePoints } from "../points/pointsService.js";

// Everything that should happen when a user sends a message on any platform.
export async function recordMessageActivity(
  platform: Platform,
  externalId: string,
  username: string,
): Promise<void> {
  const user = await recordUserSeen(platform, externalId, username);
  await awardMessagePoints(user.id);
}
