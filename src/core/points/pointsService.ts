import type { Platform, Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";

export const MESSAGE_POINTS = 5;
export const MESSAGE_POINTS_COOLDOWN_MS = 10 * 60 * 1000;

// Awards message points if the user is off cooldown. Returns the new balance,
// or null if they were still on cooldown.
export async function awardMessagePoints(userId: string): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    const cutoff = new Date(Date.now() - MESSAGE_POINTS_COOLDOWN_MS);

    // Conditional update: a single UPDATE ... WHERE, so Postgres row-locks the
    // user and re-evaluates the predicate for any concurrent caller. Exactly one
    // of two messages arriving together can win.
    const { count } = await tx.user.updateMany({
      where: {
        id: userId,
        OR: [{ lastMessagePointsAt: null }, { lastMessagePointsAt: { lt: cutoff } }],
      },
      data: { points: { increment: MESSAGE_POINTS }, lastMessagePointsAt: new Date() },
    });
    if (count === 0) return null;

    await tx.pointsLedgerEntry.create({
      data: { userId, delta: MESSAGE_POINTS, reason: "MESSAGE" },
    });

    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { points: true } });
    return user.points;
  });
}

export async function getPointsFor(platform: Platform, externalId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { platform_externalId: { platform, externalId } },
    select: { points: true },
  });
  return user?.points ?? 0;
}

export const ACCOUNT_LINK_POINTS = 100;

// Paid to every identity on a freshly merged account — 100 each, so linking
// Discord and Twitch is worth 200. Takes the caller's transaction client so the
// reward commits with the merge itself: no link without the points, and no
// points without the link.
export async function awardAccountLinkPoints(tx: Prisma.TransactionClient, userIds: string[]): Promise<void> {
  await tx.user.updateMany({
    where: { id: { in: userIds } },
    data: { points: { increment: ACCOUNT_LINK_POINTS } },
  });
  await tx.pointsLedgerEntry.createMany({
    data: userIds.map((userId) => ({
      userId,
      delta: ACCOUNT_LINK_POINTS,
      reason: "ACCOUNT_LINK" as const,
    })),
  });
}
