import { STEP_IDS, type StepId } from "./types";

/** The four steps: titles (Arbotek h1), header names, CTA labels (the short
 *  label fits beside the price on phones under 480px). */
export const STEPS: Record<
  StepId,
  { index: number; title: string; name: string; next: string; nextShort: string }
> = {
  design: {
    index: 0,
    title: "Pick your design",
    name: "Design",
    next: "Next: Write the card",
    nextShort: "Next: Card",
  },
  card: {
    index: 1,
    title: "Write the card",
    name: "Card",
    next: "Next: What's inside",
    nextShort: "Next: Inside",
  },
  inside: {
    index: 2,
    title: "What goes inside?",
    name: "Inside",
    next: "Next: Delivery",
    nextShort: "Next: Delivery",
  },
  deliver: {
    index: 3,
    title: "When and where",
    name: "Deliver & pay",
    next: "Continue to payment",
    nextShort: "Continue to payment",
  },
};

// v1's step slugs map onto v2's (the shared /cart page's Edit button links
// with ?step=delivery, and old bookmarks may carry the others).
const ALIASES: Record<string, StepId> = {
  design: "design",
  graphic: "design",
  card: "card",
  message: "card",
  inside: "inside",
  filling: "inside",
  addons: "inside",
  deliver: "deliver",
  delivery: "deliver",
  sendto: "deliver",
};

export function parseStep(v: string | null | undefined): StepId | null {
  return v ? (ALIASES[v.trim().toLowerCase()] ?? null) : null;
}

export function stepAt(index: number): StepId {
  return STEP_IDS[Math.max(0, Math.min(STEP_IDS.length - 1, index))];
}
