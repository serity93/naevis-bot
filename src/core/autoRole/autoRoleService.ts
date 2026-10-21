import type { AutoRole } from "@prisma/client";
import { prisma } from "../../db/client.js";

export async function getAutoRole(guildId: string): Promise<AutoRole | null> {
  return prisma.autoRole.findUnique({ where: { guildId } });
}

export async function listAutoRoleGuildIds(): Promise<string[]> {
  const rows = await prisma.autoRole.findMany({ select: { guildId: true } });
  return rows.map((r) => r.guildId);
}

export async function setAutoRole(guildId: string, roleId: string, updatedById: string): Promise<AutoRole> {
  return prisma.autoRole.upsert({
    where: { guildId },
    create: { guildId, roleId, updatedById },
    update: { roleId, updatedById },
  });
}

/** Returns whether there was one to clear. */
export async function clearAutoRole(guildId: string): Promise<boolean> {
  // deleteMany so clearing twice is a no-op rather than a P2025.
  const { count } = await prisma.autoRole.deleteMany({ where: { guildId } });
  return count > 0;
}
