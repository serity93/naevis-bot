import { randomInt } from "node:crypto";
import { Prisma, type Platform, type User } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { awardAccountLinkPoints } from "../points/pointsService.js";

export const LINK_CODE_LENGTH = 6;
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

// No I/O/0/1 — these get typed back by hand into a chat box.
const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomLinkCode(): string {
  let code = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) {
    code += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
  }
  return code;
}

export interface LinkCode {
  code: string;
  expiresAt: Date;
}

// Issues a fresh code for the account, replacing any outstanding one so a user
// who runs the command twice only ever has a single live code to keep track of.
export async function createLinkCode(accountId: string): Promise<LinkCode> {
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);

  // Collisions are vanishingly rare but cheap to ride out: the primary key is
  // the code itself, so a duplicate just means drawing again. Each attempt gets
  // its own transaction — a failed INSERT aborts the surrounding Postgres
  // transaction, so a retry inside one would only ever hit "already aborted".
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomLinkCode();
    try {
      return await prisma.$transaction(async (tx) => {
        // Spent codes are dead weight that only make collisions likelier, and
        // this is the one place that reliably runs often enough to sweep them.
        await tx.accountLinkCode.deleteMany({
          where: { OR: [{ accountId }, { expiresAt: { lte: new Date() } }] },
        });
        await tx.accountLinkCode.create({ data: { code, accountId, expiresAt } });
        return { code, expiresAt };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }
  throw new Error("Could not generate a unique link code");
}

export type RedeemLinkCodeResult =
  | { ok: true; identities: User[] }
  | { ok: false; reason: "INVALID_CODE" }
  | { ok: false; reason: "EXPIRED_CODE" }
  | { ok: false; reason: "SAME_ACCOUNT" }
  // `platform` is the one both accounts already hold an identity on, which is
  // what tells the caller which side of the link is the one already spoken for.
  | { ok: false; reason: "PLATFORM_CONFLICT"; platform: Platform };

// Merges the code issuer's account with the redeemer's. The issuer's account
// survives and absorbs the redeemer's identities; the emptied one is dropped.
export async function redeemLinkCode(code: string, redeemingUserId: string): Promise<RedeemLinkCodeResult> {
  const normalized = code.trim().toUpperCase();

  return prisma.$transaction(async (tx) => {
    const linkCode = await tx.accountLinkCode.findUnique({ where: { code: normalized } });
    if (!linkCode) {
      return { ok: false, reason: "INVALID_CODE" } as const;
    }
    if (linkCode.expiresAt <= new Date()) {
      // Drop it so the same code can't sit around reporting "expired" forever,
      // and so it's free to be drawn again.
      await tx.accountLinkCode.delete({ where: { code: normalized } });
      return { ok: false, reason: "EXPIRED_CODE" } as const;
    }

    const redeemer = await tx.user.findUniqueOrThrow({
      where: { id: redeemingUserId },
      select: { accountId: true },
    });

    const targetAccountId = linkCode.accountId;
    const sourceAccountId = redeemer.accountId;
    if (targetAccountId === sourceAccountId) {
      return { ok: false, reason: "SAME_ACCOUNT" } as const;
    }

    const [targetIdentities, sourceIdentities] = await Promise.all([
      tx.user.findMany({ where: { accountId: targetAccountId }, select: { platform: true } }),
      tx.user.findMany({ where: { accountId: sourceAccountId }, select: { platform: true } }),
    ]);

    // One identity per platform per account, so a shared platform means one of
    // the two identities would have to be dropped. Refuse rather than guess.
    // The @@unique([accountId, platform]) index is the backstop if two
    // redemptions race past this check; the loser's transaction rolls back.
    const targetPlatforms = new Set(targetIdentities.map((i) => i.platform));
    const clash = sourceIdentities.find((i) => targetPlatforms.has(i.platform));
    if (clash) {
      return { ok: false, reason: "PLATFORM_CONFLICT", platform: clash.platform } as const;
    }

    await tx.user.updateMany({
      where: { accountId: sourceAccountId },
      data: { accountId: targetAccountId },
    });

    // Both sides' codes are spent now; the source account is empty of
    // identities, so removing it cascades away nothing else of value.
    await tx.accountLinkCode.deleteMany({
      where: { accountId: { in: [targetAccountId, sourceAccountId] } },
    });
    await tx.account.delete({ where: { id: sourceAccountId } });

    // The reward for linking, paid inside the merge transaction so the two
    // can never come apart. Both identities are on the target account by now,
    // so this covers the redeemer as well as the code issuer.
    const linked = await tx.user.findMany({
      where: { accountId: targetAccountId },
      select: { id: true },
    });
    await awardAccountLinkPoints(
      tx,
      linked.map((i) => i.id),
    );

    const identities = await tx.user.findMany({
      where: { accountId: targetAccountId },
      orderBy: { platform: "asc" },
    });
    return { ok: true, identities } as const;
  });
}

// The account's identity on a given platform, if it has claimed one. Used to
// answer "are these accounts already linked?" before issuing a code.
export async function getIdentityForPlatform(accountId: string, platform: Platform): Promise<User | null> {
  return prisma.user.findUnique({ where: { accountId_platform: { accountId, platform } } });
}
