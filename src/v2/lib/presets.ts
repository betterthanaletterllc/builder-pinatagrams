import type { OccasionId } from "./occasions";

/**
 * Ad creative → landing preset. When an ad's URL carries utm_content, the
 * piñata it advertised opens on Step 1 even if the link itself only says
 * /design. Explicit ?design= / ?occasion= / ?style= always win, field by
 * field; unknown utm_content values are ignored. Design codes are validated
 * against the storefront's library like any deep link.
 *
 * Keys are matched lower-cased. Add a row per creative, e.g.:
 *   "bday-googly-hbd35": { occasion: "birthday", design: "HBD35", style: "googly" },
 */
export const UTM_PRESETS: Record<
  string,
  { occasion?: OccasionId; design?: string; style?: string }
> = {};
