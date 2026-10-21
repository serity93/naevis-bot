import { EmbedBuilder } from "discord.js";
import type { ReactionRolePair } from "../../core/reactionRoles/reactionRoleService.js";

// Discord's blurple. Used when the admin doesn't pick a colour.
export const DEFAULT_COLOR = 0x5865f2;

// Discord allows twenty distinct reactions per message.
export const MAX_PAIRS = 20;

// Leaves headroom under the embed description's 4096-character limit for the
// role list: twenty lines of "<:longest_name:id> — <@&id>" is under 1100.
export const MAX_CONTENT_LENGTH = 2900;
export const MAX_TITLE_LENGTH = 256;

export interface ReactionRoleView {
  title: string | null;
  content: string;
  color: number;
  showRoleList: boolean;
  pairs: ReactionRolePair[];
}

/**
 * The embed members actually see. The role list is rendered from the pairs
 * rather than written by the admin, so it can't drift from what reacting
 * really does. Role mentions inside an embed never ping.
 */
export function buildReactionRoleEmbed(view: ReactionRoleView): EmbedBuilder {
  const lines = view.showRoleList ? view.pairs.map((p) => `${p.emojiDisplay} — <@&${p.roleId}>`) : [];
  const description = [view.content, lines.join("\n")].filter(Boolean).join("\n\n");

  const embed = new EmbedBuilder().setColor(view.color).setDescription(description || "​");
  if (view.title) embed.setTitle(view.title);
  return embed;
}

export function formatColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0").toUpperCase()}`;
}

/** Parse "#5865F2", "5865f2" or "" (default). Returns null if it isn't a hex colour. */
export function parseColor(raw: string): number | null {
  const text = raw.trim();
  if (text.length === 0) return DEFAULT_COLOR;
  const match = /^#?([0-9a-f]{6})$/i.exec(text);
  return match ? parseInt(match[1]!, 16) : null;
}

export function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
