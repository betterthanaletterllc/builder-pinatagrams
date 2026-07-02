/**
 * Gift-finding data for the graphic library: occasion taxonomy (from design-
 * code prefixes), AI-authored tags (recipients/vibes/season) and 12-month
 * sales popularity. Tags + popularity are OPTIONAL data files — the library
 * degrades to occasions-only when they're absent. Long-term all of this
 * belongs in the hub catalog as admin-editable data.
 */

export type LibraryGraphic = {
  design: string;
  title: string;
  thumb: string | null;
  art: string | null;
};

export type GraphicTags = { r: string[]; v: string[]; m: number[] };
export type TagIndex = Record<string, GraphicTags>;
export type PopularRanking = { design: string; units: number }[];

// Client-specific one-off designs that shouldn't appear in a public library.
export const EXCLUDED_PREFIXES = new Set(["BSG", "BRYNNEIL", "RETENTION"]);

export const OCCASIONS: Record<string, string> = {
  HBD: "Birthday",
  FAF: "Family & Friends",
  SYMP: "Sympathy",
  APPR: "Thank you",
  CONGRATS: "Congrats",
  VALENTINES: "Love & Valentine's",
  WED: "Wedding",
  ANNI: "Anniversary",
  BABY: "New baby",
  PARTY: "Party",
  DIVORCE: "Divorce party",
  SPORTS: "Sports",
  PUPYATA: "For dogs",
  CATYATA: "For cats",
  REALSY: "Realsy Dates",
  SCHOOLFUN: "School",
  SCHOOL: "School",
  BACKTOSCHOOL: "School",
  BUSINESS: "Work & business",
  SEASON: "Summer",
  CHRISTMASINJULY: "Summer",
  HALLOWEEN: "Halloween",
  THANKSGIVING: "Thanksgiving",
  CHRISTMAS: "Christmas",
  HANUKKAH: "Hanukkah",
  NEWYEAR: "New Year",
  EASTER: "Easter",
  STPADDYS: "St. Patrick's Day",
  CINCODEMAYO: "Cinco de Mayo",
  "4THOFJULY": "4th of July",
  PRIDEMONTH: "Pride",
  JUNETEENTH: "Juneteenth",
  HHM: "Hispanic Heritage",
  MOTHERSDAY: "Mother's Day",
};

export const FALLBACK_OCCASION = "More fun";

export function occasionOf(design: string): string {
  const prefix = design.replace(/[0-9]+$/, "");
  return OCCASIONS[prefix] ?? FALLBACK_OCCASION;
}

// Facet chips, in display order. "anyone" is deliberately not a chip.
export const RECIPIENTS: [string, string][] = [
  ["mom", "Mom"],
  ["dad", "Dad"],
  ["partner", "Partner"],
  ["friend", "Friend"],
  ["coworker", "Coworker"],
  ["teacher", "Teacher"],
  ["kids", "Kids"],
  ["baby", "Baby"],
  ["grad", "Grad"],
  ["dog", "Dog"],
  ["cat", "Cat"],
];

export const VIBES: [string, string][] = [
  ["funny", "Funny"],
  ["punny", "Punny"],
  ["heartfelt", "Heartfelt"],
  ["encouraging", "Encouraging"],
  ["romantic", "Romantic"],
  ["festive", "Festive"],
  ["professional", "Professional"],
];

// Shelves shown on the default (unfiltered) view, in order.
export const SHELF_OCCASIONS = [
  "Birthday",
  "Thank you",
  "Family & Friends",
  "Congrats",
  "Sympathy",
];

export async function loadJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}
