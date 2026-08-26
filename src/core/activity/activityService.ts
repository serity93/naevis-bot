import type { Platform } from "@prisma/client";
import { recordUserSeen, recordUsersSeen, type ExternalIdentity } from "../users/userService.js";
import { awardMessagePoints, accrueWatchtimePoints, type WatchtimeAward } from "../points/pointsService.js";

// Everything that should happen when a user sends a message on any platform.
export async function recordMessageActivity(
  platform: Platform,
  externalId: string,
  username: string,
): Promise<void> {
  const user = await recordUserSeen(platform, externalId, username);
  await awardMessagePoints(user.id);
}

// Everything that should happen for one sample of who is currently present.
// `seconds` is the time since the previous sample, which is what each listed
// viewer gets credited for. Only Twitch calls this: Discord has no equivalent
// notion of being present in a stream.
export async function recordWatchtimeActivity(
  platform: Platform,
  viewers: ExternalIdentity[],
  seconds: number,
): Promise<WatchtimeAward[]> {
  const userIds = await recordUsersSeen(platform, viewers);
  return accrueWatchtimePoints(userIds, seconds);
}
