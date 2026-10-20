import type { ReactionRoleMessage, ReactionRoleOption } from "@prisma/client";
import { prisma } from "../../db/client.js";

export type ReactionRoleConfig = ReactionRoleMessage & { options: ReactionRoleOption[] };

export interface ReactionRolePair {
  emojiKey: string;
  emojiDisplay: string;
  roleId: string;
}

export interface ReactionRoleFields {
  guildId: string;
  channelId: string;
  messageId: string;
  title: string | null;
  content: string;
  color: number;
}

const withOptions = { options: { orderBy: { position: "asc" } } } as const;

function optionRows(pairs: ReactionRolePair[]) {
  return pairs.map((p, position) => ({ ...p, position }));
}

export async function listForGuild(guildId: string): Promise<ReactionRoleConfig[]> {
  return prisma.reactionRoleMessage.findMany({
    where: { guildId },
    include: withOptions,
    orderBy: { createdAt: "asc" },
  });
}

export async function getConfig(id: string): Promise<ReactionRoleConfig | null> {
  return prisma.reactionRoleMessage.findUnique({ where: { id }, include: withOptions });
}

// The hot path: runs on every reaction anywhere the bot can see. Both columns
// are indexed (messageId is unique, and the option lookup rides the
// [configId, emojiKey] unique), so a reaction on an unrelated message costs one
// index probe that finds nothing.
export async function findRoleForReaction(messageId: string, emojiKey: string): Promise<string | null> {
  const option = await prisma.reactionRoleOption.findFirst({
    where: { emojiKey, config: { messageId } },
    select: { roleId: true },
  });
  return option?.roleId ?? null;
}

export async function createConfig(
  fields: ReactionRoleFields,
  createdById: string,
  pairs: ReactionRolePair[],
): Promise<ReactionRoleConfig> {
  return prisma.reactionRoleMessage.create({
    data: { ...fields, createdById, options: { create: optionRows(pairs) } },
    include: withOptions,
  });
}

// Options are replaced wholesale rather than diffed: there are at most twenty,
// and doing it in one transaction means a reaction arriving mid-update sees
// either the old set or the new one, never half of each.
export async function updateConfig(
  id: string,
  fields: ReactionRoleFields,
  pairs: ReactionRolePair[],
): Promise<ReactionRoleConfig> {
  return prisma.$transaction(async (tx) => {
    await tx.reactionRoleOption.deleteMany({ where: { configId: id } });
    return tx.reactionRoleMessage.update({
      where: { id },
      data: { ...fields, options: { create: optionRows(pairs) } },
      include: withOptions,
    });
  });
}

export async function deleteConfig(id: string): Promise<void> {
  // deleteMany so a double-click on "Delete" is a no-op rather than a P2025.
  await prisma.reactionRoleMessage.deleteMany({ where: { id } });
}
