import type { OccasionId } from "./occasions";

/**
 * The card: To / Message / From, printed as ONE `message` line attribute —
 *   `${to ? to + ",\n" : ""}${message}${from ? "\n— " + from : ""}`
 * Checkout keeps the first 300 UTF-16 units (route.ts str(message, 300)), so
 * the COMBINED text is held to that limit here: the counter counts it and
 * input past it is refused, never silently cut at checkout.
 */

export const MESSAGE_LIMIT = 300;
export const TO_MAX = 40;
export const FROM_MAX = 40;

export type CardParts = { to: string; body: string; from: string };

/** Every piñata carries a message: words, not just a "— From" line. */
export function hasMessage(d: { msgTo: string; msgBody: string }): boolean {
  return !!(d.msgBody.trim() || d.msgTo.trim());
}

export function composeMessage({ to, body, from }: CardParts): string {
  const t = to.trim();
  const f = from.trim();
  const b = body.replace(/\s+$/, "").replace(/^\s*\n/, "");
  return `${t ? `${t},\n` : ""}${b}${f ? `\n— ${f}` : ""}`.trim();
}

/**
 * Split a saved message back into parts (edit mode). The exact inverse of
 * composeMessage for v2-made lines; anything else (v1 free text) lands in
 * the body untouched, so re-composing never changes what prints.
 */
export function parseMessage(message: string): CardParts {
  let rest = message ?? "";
  let to = "";
  let from = "";
  const head = /^([^\n,]{1,40}),\n/.exec(rest);
  if (head) {
    to = head[1];
    rest = rest.slice(head[0].length);
  }
  const tail = /\n— ([^\n]{1,40})$/.exec(rest);
  if (tail) {
    from = tail[1];
    rest = rest.slice(0, tail.index);
  }
  const parts = { to, body: rest, from };
  // Only accept the split if it round-trips exactly; otherwise keep the
  // whole text as the message body.
  return composeMessage(parts) === message.trim() ? parts : { to: "", body: message, from: "" };
}

/** Cut a string to at most `max` UTF-16 units without splitting a
 *  surrogate pair (an emoji half would print as a replacement box). */
export function fitUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, Math.max(0, max));
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Warm, short starters per occasion — editable, on-brand (the candy comes
 *  out and the piñata gets kept: no smashing), written by people. */
export const STARTERS: Record<OccasionId | "default", string[]> = {
  birthday: [
    "Happy birthday! Here's a little party in a box.",
    "Another trip around the sun deserves something sweet.",
    "Sweets for the sweetest person I know.",
    "Wishing you a year as fun as this box.",
  ],
  halloween: [
    "Happy Halloween! No tricks, just treats.",
    "A little something sweet for spooky season.",
    "Treats for my favorite ghoul.",
  ],
  "thank-you": [
    "Thank you — you made my day.",
    "A sweet thank-you for everything you do.",
    "Grateful for you, today and every day.",
  ],
  congrats: [
    "Congratulations! You earned this.",
    "So proud of you — time to celebrate!",
    "Cheers to you and this big moment.",
  ],
  love: [
    "Sending you a box full of love.",
    "You make every day sweeter.",
    "Just a little something to say I love you.",
  ],
  "get-well": [
    "Get well soon — thinking of you.",
    "Sending sweets and good vibes your way.",
    "Rest up. We're all rooting for you.",
  ],
  holidays: [
    "Happy holidays from our home to yours.",
    "Wishing you a sweet and cozy season.",
    "Cheers to the season — and to you.",
  ],
  "just-because": [
    "Just because you're you.",
    "Thinking of you — enjoy a little treat!",
    "No reason needed. You deserve this.",
  ],
  default: [
    "A little party in a box, just for you.",
    "Thinking of you — enjoy a little treat!",
    "You deserve something sweet today.",
  ],
};
