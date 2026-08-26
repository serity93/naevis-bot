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
    // A first-seen identity owns a brand new account. Linking later merges it
    // into the account on the other platform.
    create: { platform, externalId, username, account: { create: {} } },
  });
}

export interface ExternalIdentity {
  externalId: string;
  username: string;
}

// Resolves a batch of platform identities to internal user ids, creating rows
// for any not seen before. The watchtime poller hands over the whole audience
// every sample, so the lookup is one query for everyone and only genuinely new
// viewers cost an insert — after the first sample of a stream, usually none.
//
// Unlike recordUserSeen this doesn't refresh usernames: that would be a write
// per viewer per sample to keep a display name fresh for someone who never
// speaks. Their name is corrected the moment they chat.
export async function recordUsersSeen(platform: Platform, identities: ExternalIdentity[]): Promise<string[]> {
  if (identities.length === 0) return [];

  const existing = await prisma.user.findMany({
    where: { platform, externalId: { in: identities.map((i) => i.externalId) } },
    select: { id: true, externalId: true },
  });
  const idByExternalId = new Map(existing.map((u) => [u.externalId, u.id]));

  // One at a time, because each new identity needs an Account created
  // alongside it and createMany can't write the relation.
  for (const identity of identities) {
    if (idByExternalId.has(identity.externalId)) continue;
    const user = await recordUserSeen(platform, identity.externalId, identity.username);
    idByExternalId.set(identity.externalId, user.id);
  }

  return [...idByExternalId.values()];
}
