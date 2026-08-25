import type { Platform } from "@prisma/client";
import { prisma } from "../../db/client.js";

export async function recordUserSeen(
  platform: Platform,
  externalId: string,
  username: string,
): Promise<void> {
  await prisma.user.upsert({
    where: { platform_externalId: { platform, externalId } },
    update: { username },
    create: { platform, externalId, username },
  });
}
