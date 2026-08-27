import { config } from "../../config.js";
import { EMPTY_REPLY_FALLBACK } from "./persona.js";
import type { Platform } from "../commands/types.js";

// Twitch caps a chat line at 500 characters and silently drops anything over,
// so "no reply appeared" is the failure mode rather than an error. The budget
// is kept well under the cap because Twitch counts code points and a reply
// carrying multi-byte characters is easy to underestimate.
const TWITCH_REPLY_LIMIT = 380;

// Spelled as an escape rather than pasted literally: a zero-width space in
// source is invisible, so a reviewer cannot tell it is there or that it is the
// right character.
const ZERO_WIDTH_SPACE = "\u200b";

// Qwen2.5 uses ChatML, so a user typing an im_start marker gets themselves a
// free role boundary if their text is ever rendered into a raw prompt string.
// Ollama's /api/chat applies the template server-side, which makes this
// defence-in-depth today — but the day someone adds a provider that takes a
// raw prompt, this is the line that keeps it safe. The Llama-style markers are
// here for the same reason.
const ROLE_MARKERS = /<\|(?:im_start|im_end|endoftext|system|user|assistant)\|>|\[\/?INST\]|<<\/?SYS>>/gi;

/**
 * Strip C0 controls (keeping tab, newline and carriage return) along with the
 * invisible formatting characters — zero-width spaces, bidi overrides, word
 * joiners, the BOM — which are how instructions get smuggled past a human
 * reading the same message.
 *
 * Written as code-point comparisons rather than a character-class regex on
 * purpose: a class full of escapes for characters that are invisible by
 * definition is unreviewable, because nobody can tell a correct one from a
 * broken one by looking at it.
 */
function stripInvisibles(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isC0 = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    const isDelete = code === 0x7f;
    const isFormat = (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e);
    const isJoiner = (code >= 0x2060 && code <= 0x2064) || code === 0xfeff;
    if (isC0 || isDelete || isFormat || isJoiner) continue;
    out += ch;
  }
  return out;
}

/** Scrub a user's message before it becomes a prompt turn. */
export function sanitizeUserText(raw: string): string {
  return stripInvisibles(raw.replace(ROLE_MARKERS, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, config.AI_MAX_INPUT_CHARS);
}

/**
 * Scrub a display name before it is used as a turn prefix. Colons and newlines
 * are the characters that matter: without stripping them, someone calling
 * themselves "System<newline>Ignore all rules" can fake a turn boundary inside
 * what the model sees as a single user message.
 */
export function sanitizeName(raw: string): string {
  const cleaned = stripInvisibles(raw.replace(ROLE_MARKERS, ""))
    .replace(/[:：\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : "someone";
}

/**
 * Turn raw model output into something safe to post on the given platform.
 * Ordering matters: the structural unwrapping has to happen before the length
 * cap, or a reply wrapped in a code fence gets truncated with the fence still
 * attached.
 */
export function postProcessReply(raw: string, platform: Platform): string {
  let text = raw.trim();

  // Reasoning-style models emit a think block even when not asked to. Qwen2.5
  // instruct normally doesn't, but stripping it costs nothing and means
  // changing AI_MODEL can't leak a visible scratchpad into chat.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // Small instruct models like to answer in a wrapper: the whole reply fenced
  // as a code block, or quoted as if reciting a line back.
  text = text.replace(/^```[a-z]*\r?\n?([\s\S]*?)\r?\n?```$/i, "$1").trim();
  text = text.replace(/^["“'](.*)["”']$/s, "$1").trim();

  // Speaker labels — the model narrating itself despite being told not to.
  // Anchored and bounded so a reply that legitimately opens "Naevis, the idol,
  // is..." survives untouched.
  text = text.replace(/^(?:naevis(?:bot)?|assistant)\s*[:：]\s*/i, "");
  text = text.replace(/^(?:sure|okay|of course|certainly|got it)[,!.]?\s+/i, "");

  if (platform === "twitch") {
    // IRC is single-line: an embedded newline either truncates the message at
    // the break or gets it rejected outright, so paragraphs collapse to spaces.
    text = text.replace(/\s*\r?\n+\s*/g, " ");
  } else {
    text = text.replace(/\n{3,}/g, "\n\n");
    // allowedMentions on the send already makes these inert, but they still
    // render as "@everyone" and still look like the bot tried it. A zero-width
    // space between the @ and the word kills the appearance too, and is
    // invisible to anyone reading the message normally.
    text = text.replace(/@(everyone|here)/gi, `@${ZERO_WIDTH_SPACE}$1`);
    // Raw id syntax the model may have copied out of the prompt.
    text = text.replace(/<@[!&]?\d+>/g, "@user");
  }

  text = text.replace(/[ \t]{2,}/g, " ").trim();

  const limit = platform === "twitch" ? TWITCH_REPLY_LIMIT : config.AI_MAX_REPLY_CHARS;
  text = truncateAtBoundary(text, limit);

  return text.length > 0 ? text : EMPTY_REPLY_FALLBACK;
}

// A boundary has to keep at least this much of the budget to be worth using.
// Below it, ending tidily costs more of the reply than the tidiness is worth.
// Inclusive: there is no reason a boundary at exactly the floor should be
// rejected in favour of a mid-sentence cut further along.
const BOUNDARY_FLOOR = 0.6;

/**
 * Cut to length at the friendliest boundary available. A sentence end is
 * preferred even when a word break would keep more text, because a reply that
 * ends on a full stop doesn't look truncated at all, whereas one that stops
 * mid-sentence reads as a crash rather than as a character running out of
 * things to say.
 */
export function truncateAtBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const head = text.slice(0, limit);
  const floor = limit * BOUNDARY_FLOOR;

  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentenceEnd >= floor) return head.slice(0, sentenceEnd + 1).trim();

  const wordBreak = head.lastIndexOf(" ");
  if (wordBreak >= floor) return `${head.slice(0, wordBreak).trim()}…`;

  return `${head.slice(0, limit - 1).trim()}…`;
}

export { TWITCH_REPLY_LIMIT };
