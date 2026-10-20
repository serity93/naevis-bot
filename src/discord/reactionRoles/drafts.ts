import { randomBytes } from "node:crypto";
import type { ReactionRolePair, ReactionRoleConfig } from "../../core/reactionRoles/reactionRoleService.js";
import { DEFAULT_COLOR } from "./render.js";

export interface Draft {
  id: string;
  guildId: string;
  ownerId: string;
  // Set when editing an existing message; absent when creating a new one.
  editingConfigId: string | null;
  channelId: string | null;
  title: string | null;
  content: string | null;
  color: number;
  pairs: ReactionRolePair[];
  touchedAt: number;
}

// Long enough to write a paragraph and hunt down the right emoji, short enough
// that an abandoned panel doesn't sit in memory all day. Refreshed on every
// interaction, so an admin actively working never hits it.
const DRAFT_TTL_MS = 30 * 60 * 1000;

// In memory, like the AI conversation buffer: a half-finished panel is worth
// losing on restart, and the panel itself is ephemeral, so nothing could reach
// a persisted draft afterwards anyway.
const drafts = new Map<string, Draft>();

function sweep(now: number) {
  for (const [id, draft] of drafts) {
    if (now - draft.touchedAt >= DRAFT_TTL_MS) drafts.delete(id);
  }
}

export function createDraft(guildId: string, ownerId: string, from?: ReactionRoleConfig): Draft {
  const now = Date.now();
  sweep(now);
  // Short, because it rides in every customId (100-character limit).
  const id = randomBytes(6).toString("hex");
  const draft: Draft = {
    id,
    guildId,
    ownerId,
    editingConfigId: from?.id ?? null,
    channelId: from?.channelId ?? null,
    title: from?.title ?? null,
    content: from?.content ?? null,
    color: from?.color ?? DEFAULT_COLOR,
    pairs:
      from?.options.map((o) => ({ emojiKey: o.emojiKey, emojiDisplay: o.emojiDisplay, roleId: o.roleId })) ??
      [],
    touchedAt: now,
  };
  drafts.set(id, draft);
  return draft;
}

export function getDraft(id: string): Draft | null {
  const now = Date.now();
  sweep(now);
  const draft = drafts.get(id);
  if (!draft) return null;
  draft.touchedAt = now;
  return draft;
}

export function discardDraft(id: string): void {
  drafts.delete(id);
}

export function isDraftComplete(draft: Draft): boolean {
  return draft.channelId !== null && !!draft.content && draft.pairs.length > 0;
}
