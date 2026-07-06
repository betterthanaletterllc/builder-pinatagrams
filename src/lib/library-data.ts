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

/* --- aisles: the two-level drill-down browse --------------------------------
 * Top row = broad aisles; tapping one opens its sub-chips. Birthdays is its
 * own top-level aisle (Nathan's call — it's the #1 use case), holidays order
 * themselves by the calendar starting from today.
 * -------------------------------------------------------------------------- */

// Occasion labels that are calendar events, with an anchor date for the
// "next holiday first" ordering (approximate is fine for movable feasts).
export const HOLIDAYS: { label: string; month: number; day: number }[] = [
  { label: "New Year", month: 1, day: 1 },
  { label: "Love & Valentine's", month: 2, day: 14 },
  { label: "St. Patrick's Day", month: 3, day: 17 },
  { label: "Easter", month: 4, day: 4 },
  { label: "Cinco de Mayo", month: 5, day: 5 },
  { label: "Mother's Day", month: 5, day: 11 },
  { label: "Pride", month: 6, day: 15 },
  { label: "Juneteenth", month: 6, day: 19 },
  { label: "4th of July", month: 7, day: 4 },
  { label: "Summer", month: 7, day: 15 },
  { label: "Hispanic Heritage", month: 9, day: 15 },
  { label: "Halloween", month: 10, day: 31 },
  { label: "Thanksgiving", month: 11, day: 27 },
  { label: "Hanukkah", month: 12, day: 12 },
  { label: "Christmas", month: 12, day: 25 },
];

export const HOLIDAY_LABELS = new Set(HOLIDAYS.map((h) => h.label));

/** Days from `now` to the holiday's next occurrence (0 = today). */
export function daysUntilHoliday(h: { month: number; day: number }, now: Date): number {
  const year = now.getFullYear();
  let target = new Date(year, h.month - 1, h.day);
  const today = new Date(year, now.getMonth(), now.getDate());
  if (target < today) target = new Date(year + 1, h.month - 1, h.day);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** Holiday list ordered by the calendar, starting from today. */
export function holidaysFromToday(now = new Date()): { label: string; days: number }[] {
  return HOLIDAYS.map((h) => ({ label: h.label, days: daysUntilHoliday(h, now) })).sort(
    (a, b) => a.days - b.days,
  );
}

// Recipient sub-chips per aisle (keys = library-index tag vocabulary).
export const FAMILY_RECIPIENTS: [string, string][] = [
  ["mom", "Mom"],
  ["dad", "Dad"],
  ["partner", "Partner"],
  ["kids", "Kids"],
  ["baby", "Baby"],
];

export const FRIEND_RECIPIENTS: [string, string][] = [
  ["friend", "Friend"],
  ["coworker", "Coworker"],
  ["teacher", "Teacher"],
  ["grad", "Grad"],
];

export const PET_RECIPIENTS: [string, string][] = [
  ["dog", "Dogs"],
  ["cat", "Cats"],
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
