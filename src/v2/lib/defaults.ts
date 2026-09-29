import type { GraphicChoice } from "@/lib/flow";
import type { HubFilling } from "@/lib/hub";

/**
 * "Start filled, not empty": the choices most buyers make, pre-selected.
 * Pure helpers shared by the server (the landing preset) and the client
 * (design changes mid-flow). Paid extras are NEVER defaulted here.
 */

/** Everyday best sellers, in order (Googly ≈45% of orders, Pink Unicorn
 *  ≈14%, Standard ≈10%) — the body default when nothing more specific
 *  applies. Real catalog ids. */
export const BEST_SELLER_BODIES = ["googly", "pink-uni", "standard"];

/** Bodies made for a moment rather than every day — grouped separately in
 *  the body sheet. Anything not listed (including new hub styles) is
 *  "Everyday". */
const OCCASION_BODIES = new Set([
  "vampire",
  "reindeer",
  "star-spangled",
  "pride",
  "grad",
  "nurse",
  "doctor",
  "money",
]);

export function bodyGroup(styleId: string): "everyday" | "occasions" {
  return OCCASION_BODIES.has(styleId) ? "occasions" : "everyday";
}

export function designPrefix(code: string): string {
  return code.toUpperCase().replace(/[0-9]+$/, "");
}

/** Designs that come with their own filling (lib/library-data prefixes):
 *  dog and cat designs ship treats, Realsy designs ship Realsy dates. */
const PREFIX_FILLINGS: { prefix: string; id: string; label: RegExp }[] = [
  { prefix: "PUPYATA", id: "dog-treats", label: /\bdog/i },
  { prefix: "CATYATA", id: "cat-treats", label: /\bcat/i },
  { prefix: "REALSY", id: "realsy-dates", label: /realsy/i },
];

/** Candy — "Most popular" (88% of lines); first hub filling as a fallback. */
export function candyFilling(fillings: HubFilling[]): HubFilling | undefined {
  return (
    fillings.find((f) => f.id === "candy") ??
    fillings.find((f) => f.label.trim().toLowerCase() === "candy") ??
    fillings[0]
  );
}

/** The filling a design brings with it, if any. */
export function fillingForGraphic(
  g: GraphicChoice | null,
  fillings: HubFilling[],
): HubFilling | undefined {
  if (!g || g.type === "custom") return undefined;
  const rule = PREFIX_FILLINGS.find((r) => r.prefix === designPrefix(g.design));
  if (!rule) return undefined;
  return (
    fillings.find((f) => f.id === rule.id) ?? fillings.find((f) => rule.label.test(f.label))
  );
}

/**
 * The filling after a design change. `auto` = the flow set it (the Candy
 * default or a design's own filling), so it follows the design: a dog design
 * brings Dog Treats, moving on to a birthday design puts Candy back. A
 * filling the shopper picked by hand is never touched.
 */
export function fillingAfterDesignChange(
  current: { filling: string; fillingAuto: boolean },
  g: GraphicChoice | null,
  fillings: HubFilling[],
): { filling: string; fillingAuto: boolean } {
  if (!current.fillingAuto) return current;
  const next = fillingForGraphic(g, fillings) ?? candyFilling(fillings);
  return { filling: next?.label ?? current.filling, fillingAuto: true };
}
