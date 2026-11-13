import { holidaysFromToday, occasionOf } from "@/lib/library-data";

/**
 * "What are you celebrating?" — the v2 occasion chips, mapped onto the
 * library's occasion taxonomy (lib/library-data OCCASIONS: design-code prefix
 * → label). Pure data + date math, safe on server and client; the design
 * lists themselves are resolved server-side (catalog-server.ts) so the 400 KB
 * graphics manifest never ships just to fill a filmstrip.
 */

export type OccasionId =
  | "birthday"
  | "halloween"
  | "thank-you"
  | "congrats"
  | "love"
  | "get-well"
  | "holidays"
  | "school"
  | "just-because";

export type OccasionDef = {
  id: OccasionId;
  label: string;
  /** Library occasion labels this chip covers ("holidays" is computed). */
  library: string[];
  /** Seasonal chips only show while their day is coming up. */
  season?: { month: number; day: number; leadDays: number };
  /** The body style that suits the occasion (used only if it's in stock). */
  bodyHint?: string;
};

export const OCCASION_DEFS: readonly OccasionDef[] = [
  { id: "birthday", label: "Birthday", library: ["Birthday"] },
  {
    id: "halloween",
    label: "Halloween",
    library: ["Halloween"],
    season: { month: 10, day: 31, leadDays: 60 },
    bodyHint: "vampire",
  },
  { id: "thank-you", label: "Thank you", library: ["Thank you"] },
  { id: "congrats", label: "Congrats", library: ["Congrats"] },
  {
    id: "love",
    label: "Love",
    library: ["Love & Valentine's", "Anniversary", "Wedding"],
  },
  // The library files these under "Sympathy": get-well, thinking-of-you,
  // cancer-support and comfort designs.
  { id: "get-well", label: "Get well", library: ["Sympathy"] },
  { id: "holidays", label: "Holidays", library: [] },
  // School designs, plus the graduation and teacher designs filed under
  // Congrats / Thank you (they join by their grad/teacher tags — see
  // isSchoolDesign).
  { id: "school", label: "School & grad", library: ["School"], bodyHint: "grad" },
  { id: "just-because", label: "Just because", library: ["Family & Friends", "Party"] },
];

/** Tags that put a design in the School & grad chip whatever its code. */
export const SCHOOL_TAGS = ["grad", "teacher"];

/** School & grad membership: a School design, or one tagged for a grad or
 *  a teacher (library-index.json). One rule for the step 1 strip and the
 *  library's School & grad category. */
export function isSchoolDesign(design: string, recipients: readonly string[] = []): boolean {
  return occasionOf(design) === "School" || recipients.some((r) => SCHOOL_TAGS.includes(r));
}

export function isOccasionId(v: unknown): v is OccasionId {
  return OCCASION_DEFS.some((d) => d.id === v);
}

export function occasionDef(id: OccasionId): OccasionDef {
  return OCCASION_DEFS.find((d) => d.id === id)!;
}

/**
 * "See all <occasion> designs": where the full library opens. The library's
 * top row of categories IS this chip list (same names, same order —
 * graphic-library AISLES), so each chip opens its own category; Halloween
 * opens inside Holidays. null = everything.
 */
export function libraryViewFor(id: OccasionId | null): { aisle: string | null; sub: string | null } {
  if (!id) return { aisle: null, sub: null };
  if (id === "birthday") return { aisle: "birthdays", sub: null };
  if (id === "halloween") return { aisle: "holidays", sub: "Halloween" };
  return { aisle: id, sub: null };
}

/**
 * The chip a picked design belongs to, among the chips showing — so the
 * step 1 chip follows a design chosen in the library (or the editor's
 * search) instead of staying on the occasion it started on. Birthday wins
 * for any birthday wording ("Happy Birthday Dad" is filed under Family &
 * Friends); null when no showing chip covers it (the Classic, a hub folder).
 */
export function occasionForPick(
  design: string,
  title: string,
  showing: readonly OccasionId[],
  now = new Date(),
): OccasionId | null {
  const label = occasionOf(design);
  const has = (id: OccasionId) => showing.includes(id);
  if ((label === "Birthday" || /\b(birthday|bday|cumple\w*)\b/i.test(title)) && has("birthday")) {
    return "birthday";
  }
  if (has("school") && isSchoolDesign(design)) return "school";
  if (/\b(grad|graduat\w*|teacher)\b/i.test(title) && has("school")) return "school";
  return showing.find((id) => libraryLabelsFor(id, now).includes(label)) ?? null;
}

function daysUntil(month: number, day: number, now: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), month - 1, day);
  if (target < today) target = new Date(now.getFullYear() + 1, month - 1, day);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** Seasonal chips are in season from `leadDays` before their day through it. */
export function inSeason(def: OccasionDef, now = new Date()): boolean {
  if (!def.season) return true;
  return daysUntil(def.season.month, def.season.day, now) <= def.season.leadDays;
}

/**
 * The Holidays chip = the library holidays coming up in the next ~4 months,
 * nearest first. Halloween is left out while its own chip is showing.
 */
export function upcomingHolidayLabels(now = new Date()): string[] {
  const halloweenChip = inSeason(occasionDef("halloween"), now);
  return holidaysFromToday(now)
    .filter((h) => h.days <= 120)
    .filter((h) => !(halloweenChip && h.label === "Halloween"))
    .map((h) => h.label);
}

/** Library labels a chip covers today. */
export function libraryLabelsFor(id: OccasionId, now = new Date()): string[] {
  return id === "holidays" ? upcomingHolidayLabels(now) : occasionDef(id).library;
}

/** Chips to offer today, in display order. */
export function activeOccasions(now = new Date()): OccasionDef[] {
  return OCCASION_DEFS.filter((d) => inSeason(d, now));
}

/** A library occasion's natural body (the design-level hint). */
export const OCCASION_BODY_HINTS: Record<string, string> = {
  Halloween: "vampire",
  Christmas: "reindeer",
  "4th of July": "star-spangled",
  Pride: "pride",
};
