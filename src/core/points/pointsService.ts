import { Prisma, type Platform } from "@prisma/client";
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

export const WATCHTIME_INTERVAL_SECONDS = 10 * 60;

// Deliberately the same as MESSAGE_POINTS, on the same 10-minute clock: being
// there is worth something, and someone who also chats earns both, so talking
// is worth exactly double lurking.
export const WATCHTIME_POINTS = 5;

export interface WatchtimeAward {
  userId: string;
  points: number;
  intervals: number;
}

// Credits `seconds` of presence to every listed identity and pays out for each
// 10-minute boundary that crossing pushed them past. Callers hand over a whole
// audience at once, so this is written to cost the same handful of queries
// whether five people are watching or five hundred.
export async function accrueWatchtimePoints(userIds: string[], seconds: number): Promise<WatchtimeAward[]> {
  if (userIds.length === 0 || seconds <= 0) return [];

  return prisma.$transaction(async (tx) => {
    // Raw SQL because updateMany can increment but can't report the resulting
    // totals, and a round trip per viewer would scale with the audience.
    // RETURNING gives the new totals; the old ones are just `new - seconds`,
    // which is what identifies who crossed a payout boundary. Raw SQL also
    // bypasses Prisma's @updatedAt, so lastSeenAt is set by hand here —
    // watching the stream counts as being seen.
    const rows = await tx.$queryRaw<Array<{ id: string; watchtimeSeconds: number }>>`
      UPDATE "User"
      SET "watchtimeSeconds" = "watchtimeSeconds" + ${seconds},
          "lastSeenAt" = NOW()
      WHERE "id" IN (${Prisma.join(userIds)})
      RETURNING "id", "watchtimeSeconds"
    `;

    const awards: WatchtimeAward[] = [];
    for (const row of rows) {
      const intervals =
        Math.floor(row.watchtimeSeconds / WATCHTIME_INTERVAL_SECONDS) -
        Math.floor((row.watchtimeSeconds - seconds) / WATCHTIME_INTERVAL_SECONDS);
      if (intervals > 0) {
        awards.push({ userId: row.id, points: intervals * WATCHTIME_POINTS, intervals });
      }
    }
    if (awards.length === 0) return [];

    // Everyone in a sample is credited the same elapsed time, so they nearly
    // always cross the same number of boundaries. Grouping by payout keeps this
    // to one UPDATE per distinct amount instead of one per viewer.
    const idsByPoints = new Map<number, string[]>();
    for (const award of awards) {
      const ids = idsByPoints.get(award.points);
      if (ids) ids.push(award.userId);
      else idsByPoints.set(award.points, [award.userId]);
    }
    for (const [points, ids] of idsByPoints) {
      await tx.user.updateMany({ where: { id: { in: ids } }, data: { points: { increment: points } } });
    }

    await tx.pointsLedgerEntry.createMany({
      data: awards.map((award) => ({
        userId: award.userId,
        delta: award.points,
        reason: "WATCHTIME" as const,
        metadata: { seconds: award.intervals * WATCHTIME_INTERVAL_SECONDS },
      })),
    });

    return awards;
  });
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
