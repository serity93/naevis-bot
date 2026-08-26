import type { Platform, User } from "@prisma/client";
import { prisma } from "../../db/client.js";

export async function recordUserSeen(
  platform: Platform,
  externalId: string,
  username: string,
): Promise<User> {
  return prisma.user.upsert({
    where: { platform_externalId: { platform, externalId } },
    update: { username },
    create: { platform, externalId, username },
  });
}
