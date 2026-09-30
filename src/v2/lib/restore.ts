import type { CartLine, GraphicChoice } from "@/lib/flow";
import type { HubFilling } from "@/lib/hub";
import { fillingAfterDesignChange } from "./defaults";
import { applyPreset, draftFromLine, draftFromPreset, type DraftV2 } from "./draft";
import { hasMessage } from "./message";
import { parseStep, STEPS } from "./steps";
import type { Preset, StepId, StepVia } from "./types";

/** Library and hub picks are ready as they are; a custom design needs its
 *  uploaded print file AND its sha256, or checkout refuses the line. */
export function graphicReady(g: GraphicChoice): boolean {
  return g.type !== "custom" || (!!g.art && !!g.artSha256);
}

/**
 * Where /design opens, decided once on the client from the URL and what
 * this tab already holds. Pure: it only DESCRIBES storage writes (park /
 * unpark / consume) — the caller performs them after mount, so a dev
 * Strict-Mode double mount can't consume anything twice.
 *
 *  - ?edit=<line>: that cart line becomes the draft (a new piñata in
 *    progress is parked, not lost); a line that's gone is dropped quietly.
 *  - an abandoned edit never leaks into a new piñata (it would REPLACE a
 *    cart line on save); a parked piñata comes back.
 *  - a NEW deep link applies its preset over the draft (only what it asked
 *    for); the same link again (a refresh) restores instead.
 *  - ?step=deliver with piñatas in the cart — or an order waiting for
 *    payment (back from its invoice, the cart icon) — and nothing in
 *    progress = the order review (no draft; the flow reopens the waiting
 *    order into it). Never a fresh, empty piñata.
 */
export function resolveRestore(input: {
  url: URL;
  stored: DraftV2 | null;
  parked: DraftV2 | null;
  lines: CartLine[];
  /** An unpaid order is waiting (its lines left the cart at checkout). */
  pendingWaiting?: boolean;
  preset: Preset;
  deepLink: boolean;
  presetApplied: boolean;
  inStock: (styleId: string) => boolean;
  fillings: HubFilling[];
}): {
  draft: DraftV2 | null;
  step: StepId;
  via: StepVia;
  fresh: boolean;
  note: string | null;
  park: DraftV2 | null;
  unpark: boolean;
  consume: boolean;
  url: URL;
} {
  const url = new URL(input.url);
  const editId = url.searchParams.get("edit");
  let d = input.stored;
  let via: StepVia = "continue";
  let fresh = false;
  let note: string | null = null;
  let park: DraftV2 | null = null;
  let unpark = false;
  let consume = false;

  if (editId) {
    consume = true; // the edit link's ?style= is not a new preset
    if (d?.editLineId === editId) {
      via = "restore";
    } else {
      const line = input.lines.find((l) => l.id === editId);
      if (line) {
        if (d && !d.editLineId) park = d;
        d = draftFromLine(line, d?.occasion ?? input.preset.occasion);
        via = "deeplink";
      } else {
        url.searchParams.delete("edit");
        if (d?.editLineId) d = null;
        note = "That piñata isn't in your order anymore.";
      }
    }
  } else {
    if (d?.editLineId) d = null;
    if (!d && input.parked) {
      d = input.parked;
      unpark = true;
    }
    if (input.deepLink && !input.presetApplied) {
      fresh = !d;
      d = applyPreset(d, input.preset, (x, g) => fillingAfterDesignChange(x, g, input.fillings));
      consume = true;
      via = "deeplink";
    } else if (d) {
      via = "restore";
    } else if (
      !(
        parseStep(url.searchParams.get("step")) === "deliver" &&
        (input.lines.length || input.pendingWaiting)
      )
    ) {
      d = draftFromPreset(input.preset);
      fresh = true;
    }
  }

  if (d && !input.inStock(d.styleId)) {
    d = { ...d, styleId: input.preset.styleId };
    note = "That piñata style just sold out, so we picked another — change it anytime.";
  }

  let step: StepId = parseStep(url.searchParams.get("step")) ?? "design";
  if (!d) step = "deliver";
  else if (!graphicReady(d.graphic)) step = "design";
  // no message yet: nothing past the card (every piñata carries one)
  else if (
    STEPS[step].index > STEPS.card.index &&
    !hasMessage(d)
  ) {
    step = "card";
  }
  url.searchParams.set("step", step);
  url.searchParams.delete("view");

  return { draft: d, step, via, fresh, note, park, unpark, consume, url };
}
