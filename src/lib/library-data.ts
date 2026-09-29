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
  // matching inside-flap message card (graphics/message metafield)
  message?: string | null;
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

/* --- Birthdays sub-filters ---------------------------------------------------
 * Birthdays is 67% of library picks and ~75 designs — one flat grid buries
 * the specific ones. Each sub-filter is DERIVED from data the library already
 * has (tags or title wording), so a chip only claims what the data backs:
 * the counts are real, and a filter with fewer than BIRTHDAY_SUB_MIN designs
 * doesn't render at all.
 * -------------------------------------------------------------------------- */

const MONTH_NAMES =
  "january|february|march|april|may|june|july|august|september|october|november|december";
const ZODIAC_SIGNS =
  "aries|taurus|gemini|cancer|leo|virgo|libra|scorpio|sagittarius|capricorn|aquarius|pisces";

export const BIRTHDAY_SUB_MIN = 3;

export const BIRTHDAY_SUBS: {
  key: string;
  label: string;
  test: (g: LibraryGraphic, t: GraphicTags | undefined) => boolean;
}[] = [
  // recipient tag
  { key: "kids", label: "Kids", test: (_g, t) => !!t?.r.includes("kids") },
  // age-themed wording: "Getting Old", "Another Year Wiser", Quinceañera
  {
    key: "milestone",
    label: "Milestone",
    test: (g) => /\b(old|older|wiser|milestones?|quinceanera)\b/.test(normalizeText(g.title)),
  },
  // vibe tags
  {
    key: "funny",
    label: "Funny",
    test: (_g, t) => !!t && (t.v.includes("funny") || t.v.includes("punny")),
  },
  // "Belated", "Beelated", "Better Late Than Never"
  {
    key: "belated",
    label: "Belated",
    test: (g) => /\b(belated|beelated|late)\b/.test(normalizeText(g.title)),
  },
  // "January Baby" … "Pisces Baby"
  {
    key: "birth-month",
    label: "Birth month & zodiac",
    test: (g) =>
      new RegExp(`\\b(${MONTH_NAMES}|${ZODIAC_SIGNS}) baby\\b`).test(
        normalizeText(g.title),
      ),
  },
  // Spanish-language designs ("Feliz Cumpleaños", "Hoy Es Tu Dia", …)
  {
    key: "spanish",
    label: "En español",
    test: (g) =>
      /\b(feliz|cumple|cumpleanos|magico|quinceanera|hoy es tu dia|vuelta al sol)\b/.test(
        normalizeText(g.title),
      ),
  },
];

/* ---------------------------------------------------------------------------
 * Library view state — where the shopper was (aisle, sub-pick, search,
 * scroll). Saved on every change + on pick, so "Change graphic" lands them
 * EXACTLY where they left off. sessionStorage: dies with the tab, cleared
 * on add-to-cart (a new piñata browses fresh).
 * ------------------------------------------------------------------------- */

export type LibraryViewState = {
  q: string;
  a: string | null;
  s: string | null;
  y: number;
};

const LIB_STATE_KEY = "pinatagrams-library-state";

export function saveLibraryState(st: LibraryViewState): void {
  try {
    sessionStorage.setItem(LIB_STATE_KEY, JSON.stringify(st));
  } catch {}
}

export function loadLibraryState(): LibraryViewState | null {
  try {
    const raw = sessionStorage.getItem(LIB_STATE_KEY);
    return raw ? (JSON.parse(raw) as LibraryViewState) : null;
  } catch {
    return null;
  }
}

export function clearLibraryState(): void {
  try {
    sessionStorage.removeItem(LIB_STATE_KEY);
  } catch {}
}

/**
 * Shopify's CDN resizes on the fly — a width-limited variant is ~50× lighter
 * than the print-resolution original. Non-CDN URLs (data URLs, Blob art)
 * pass through untouched.
 */
export function cdnThumb(u: string | null, width: number): string | null {
  if (!u || !u.includes("cdn.shopify.com")) return u;
  return u + (u.includes("?") ? "&" : "?") + `width=${width}`;
}

/** Designs ordered by 12-month popularity (best sellers first); designs
 *  without sales history keep their manifest order after them. */
export function byPopularity<T extends { design: string }>(
  list: T[],
  rank: Map<string, number>,
): T[] {
  const r = (d: string) => rank.get(d) ?? Number.MAX_SAFE_INTEGER;
  // Array.prototype.sort is stable, so ties keep manifest order.
  return [...list].sort((a, b) => r(a.design) - r(b.design));
}

/* ---------------------------------------------------------------------------
 * Search — forgiving, ranked, never a dead end.
 *
 * Shoppers type the way they talk ("bday for my boss", "xmas", "5th
 * birthday"), not the way designs are titled. A query becomes CONCEPTS (one
 * per meaningful word once stopwords are dropped); each concept expands
 * through the synonym table into terms that can hit a design's title words,
 * occasion, recipient tags or vibe tags. Every concept a design matches adds
 * to its score (tokenized OR scoring), then:
 *  - exact results = designs matching EVERY concept, best score first, ties
 *    broken by 12-month popularity;
 *  - close results = when nothing matches everything, the designs matching
 *    the most concepts ("No exact match — here are close ones") instead of
 *    an empty screen.
 * Design codes (HBD35…) are never searchable text — "5" used to return 58
 * codes — only an exact whole-code match finds one (support + ad lookups).
 * ------------------------------------------------------------------------- */

/** Lowercase, strip accents (piñata → pinata), drop apostrophes. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’‘`´]/g, "");
}

/** Light plural folding — applied identically to queries and designs, so it
 *  only has to be consistent, not linguistically perfect. */
export function stemWord(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ss|us|is|as|os)$/.test(w)) return w; // christmas, tennis, hocus
  if (/(sh|ch|x|z)es$/.test(w)) return w.slice(0, -2); // wishes, witches
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function wordsOf(s: string): string[] {
  return normalizeText(s).split(/[^a-z0-9]+/).filter(Boolean);
}

// Words on nearly every product title — they carry no signal.
const BOILERPLATE = new Set(["pinatagram", "pinatagrams", "pinata", "pinatas"]);

// Dropped from queries ("birthday for my boss" → birthday, boss). If a query
// is NOTHING but stopwords ("happy"), its words are searched literally.
const STOPWORDS = new Set(
  (
    "a an the for to of and or with on in at from by as my our your yours you " +
    "me i im id its it is are be was this that these those some someone " +
    "somebody who whos her his him she he their them they we us so very just " +
    "really gift gifts present presents card cards design designs graphic " +
    "graphics idea ideas pinata pinatas pinatagram pinatagrams please want " +
    "need looking something anything send sending say saying happy day st " +
    "saint"
  ).split(" "),
);

type Field = "title" | "occ" | "r" | "v";
const FIELD_WEIGHT: Record<Field, number> = { title: 1, occ: 0.9, r: 0.9, v: 0.6 };

type Term =
  // a word in any field; `fuzzy` = the shopper's own word (prefix + typo ok)
  | { t: "w"; w: string; wt: number; fuzzy?: boolean }
  | { t: "occ"; label: string; wt: number } // occasion label, exactly
  | { t: "r"; tag: string; wt: number } // recipient tag
  | { t: "v"; tag: string; wt: number } // vibe tag
  | { t: "re"; re: RegExp; wt: number }; // title wording (age boosts)

type Concept = { terms: Term[]; boosts: Term[]; code?: string };

const w = (word: string, wt = 0.9): Term => ({ t: "w", w: stemWord(word), wt });
const occ = (label: string, wt = 0.9): Term => ({ t: "occ", label, wt });
const rTag = (tag: string, wt = 0.8): Term => ({ t: "r", tag: stemWord(tag), wt });
const vTag = (tag: string, wt = 0.8): Term => ({ t: "v", tag: stemWord(tag), wt });

// Synonym groups: every listed spelling expands to the same terms. Keys are
// normalized (accents + apostrophes stripped) and looked up both raw and
// stemmed. Terms target the library's own vocabulary — occasion labels from
// OCCASIONS, recipient/vibe tags from library-index.json.
const SYNONYM_GROUPS: [string, Term[]][] = [
  ["bday bdays birthday birthdays hbd bd cumple cumpleanos", [occ("Birthday"), w("birthday")]],
  ["xmas christmas navidad", [occ("Christmas"), w("christmas")]],
  ["holiday holidays", [w("holiday"), occ("Christmas", 0.7), occ("Hanukkah", 0.7), occ("New Year", 0.7)]],
  ["dad dads father fathers daddy papa papi pops stepdad", [rTag("dad"), w("dad"), w("father")]],
  ["mom moms mother mothers mommy mama mami mum mummy momma madre stepmom mothersday", [rTag("mom"), w("mom"), w("mother"), occ("Mother's Day", 0.7)]],
  ["bf gf boyfriend boyfriends girlfriend girlfriends husband hubby wife wifey spouse fiance fiancee partner sweetheart lover", [rTag("partner"), vTag("romantic", 0.6), occ("Love & Valentine's", 0.7)]],
  ["love loving romantic romance", [w("love"), vTag("romantic"), occ("Love & Valentine's", 0.8)]],
  ["valentine valentines vday galentine galentines cupid", [occ("Love & Valentine's"), w("valentine")]],
  ["boss bosses coworker coworkers colleague colleagues employee employees staff team client clients customer customers office manager work job business corporate company employer", [occ("Work & business"), rTag("coworker"), vTag("professional"), w("work")]],
  ["bestie besties bff bestfriend friend friends pal pals buddy amiga amigo", [rTag("friend"), w("friend"), w("bestie")]],
  ["grad grads graduate graduates graduating graduation graduated commencement diploma", [rTag("grad"), w("graduation"), w("grad")]],
  ["anniv anni anniversary anniversaries aniversario", [occ("Anniversary"), w("anniversary")]],
  ["congrats congratulations congratulation congrat congratz felicidades", [occ("Congrats"), w("congrats"), w("congratulations")]],
  ["kudos proud", [occ("Congrats", 0.8), w("job"), w("proud"), w("great")]],
  ["thanks thank thankyou thx ty gracias appreciate appreciation grateful gratitude", [occ("Thank you"), w("thank"), w("grateful")]],
  ["sympathy condolence condolences sorry loss grief grieving bereavement funeral", [occ("Sympathy"), w("sorry")]],
  ["getwell sick illness ill surgery hospital recovery recover recovering heal healing", [occ("Sympathy", 0.8), w("heal"), w("healing"), w("well")]],
  ["halloween spooky spook boo trickortreat", [occ("Halloween"), w("halloween")]],
  ["thanksgiving turkey friendsgiving gobble", [occ("Thanksgiving"), w("thanksgiving")]],
  ["easter bunny", [occ("Easter"), w("easter")]],
  ["stpatricks patrick patricks paddy paddys patty pattys shamrock irish leprechaun", [occ("St. Patrick's Day")]],
  ["july4 independence patriotic usa america american", [occ("4th of July")]],
  ["cincodemayo cinco mayo", [occ("Cinco de Mayo")]],
  ["newyear nye", [occ("New Year")]],
  ["hanukkah chanukah hanukah chanukkah", [occ("Hanukkah")]],
  ["pride lgbt lgbtq lgbtqia gay queer", [occ("Pride"), w("pride")]],
  ["juneteenth", [occ("Juneteenth")]],
  ["hispanic latino latina latinx heritage hhm", [occ("Hispanic Heritage")]],
  // (no title-word term: "January Baby" & co. are birthday designs)
  ["baby babies newborn infant babyshower shower expecting pregnant pregnancy newbaby", [occ("New baby"), rTag("baby")]],
  ["wedding weddings married marriage bride groom bridal bachelorette bachelor engaged engagement bridesmaid groomsman newlywed newlyweds", [occ("Wedding"), w("wedding")]],
  ["divorce divorced", [occ("Divorce party"), w("divorce")]],
  ["retire retired retirement retiring", [w("retirement")]],
  ["housewarming home house realtor", [w("home")]],
  ["sport sports athlete coach", [occ("Sports")]],
  ["dog dogs puppy puppies pup pups doggy doggie doggo pupyata canine", [occ("For dogs"), rTag("dog"), w("dog")]],
  ["cat cats kitty kitties kitten kittens catyata feline", [occ("For cats"), rTag("cat"), w("cat")]],
  ["kid kids child children son daughter toddler niece nephew grandkid grandkids grandchild grandson granddaughter", [rTag("kids")]],
  ["teacher teachers teach educator professor tutor maestra maestro", [rTag("teacher"), w("teacher")]],
  ["school backtoschool class student students classroom", [occ("School"), w("school")]],
  ["summer beach pool vacation vacay", [occ("Summer"), w("summer")]],
  ["funny hilarious humor humour joke jokes silly lol sarcastic witty", [vTag("funny"), vTag("punny", 0.6)]],
  ["pun puns punny", [vTag("punny")]],
  ["heartfelt sentimental touching meaningful", [vTag("heartfelt")]],
  ["encouraging encouragement motivation motivational inspire inspirational support supportive uplifting", [vTag("encouraging")]],
  ["milestone milestones aging", [w("milestone"), w("old"), w("wiser")]],
  ["grandma grandmother granny nana abuela grammy", [w("grandma"), w("abuela")]],
  ["grandpa grandfather granddad grandad abuelo gramps", [w("grandpa")]],
  ["brother brothers bro bros", [w("brother"), w("bro")]],
  ["sister sisters sis", [w("sister")]],
  ["aunt auntie aunty tia", [w("aunt")]],
  ["uncle tio", [w("uncle")]],
  ["money cash raise bonus", [w("money"), w("raise")]],
  ["military veteran veterans army navy soldier", [w("military"), w("service"), w("soldier"), w("brave")]],
];

const SYNONYMS = new Map<string, Term[]>();
for (const [keys, terms] of SYNONYM_GROUPS) {
  for (const k of keys.split(" ")) SYNONYMS.set(k, terms);
}

// Multi-word phrases rewritten to one synonym key BEFORE tokenizing (after
// normalizeText, so apostrophes are already gone: "mother's" → "mothers").
const PHRASES: [RegExp, string][] = [
  [/\b(4th|fourth) of july\b|\bjuly (4th|4|fourth)\b|\bindependence day\b/g, " july4 "],
  [/\b(cinco|5) de mayo\b/g, " cincodemayo "],
  [/\bget well( soon)?\b|\bfeel better\b/g, " getwell "],
  [/\bnew years?( eve)?\b/g, " newyear "],
  [/\b(st|saint)\.? ?(patrick|patty|paddy)s?\b/g, " stpatricks "],
  [/\bback to school\b/g, " backtoschool "],
  [/\b(baby shower|gender reveal|new ?born|new baby)\b/g, " newbaby "],
  [/\bbest friends?\b/g, " bestfriend "],
  [/\bthank you\b/g, " thankyou "],
  [/\b(good|great|nice) (job|work)\b|\bwell done\b|\bway to go\b/g, " kudos "],
  [/\bmothers? day\b/g, " mothersday "],
  [/\bfathers? day\b/g, " dad "],
  [/\bover the hill\b/g, " milestone "],
  [/\bfirst birthday\b/g, " 1st birthday "],
  [/\bsweet (16|sixteen)\b/g, " 16th birthday "],
];

// "5th", "5 year old", "turning 5", "5yo" → an age → a birthday. An ordinal
// next to anniversary/wedding/work words counts years, not an age.
const AGE_PATTERNS = [
  /\b(\d{1,3}) ?(?:st|nd|rd|th)\b/g,
  /\b(\d{1,3}) ?-?(?:years?|yrs?) ?-?old\b/g,
  /\b(\d{1,3}) ?yo\b/g,
  /\bturning (\d{1,3})\b/g,
];
const NOT_AN_AGE = /\b(anniv\w*|anni|wedding|married|marriage|retire\w*|work\w*|job|sober\w*|sobriety|together)\b/;

function ageConcept(n: number, wt = 1): Concept {
  const boosts: Term[] = [];
  if (n <= 12) boosts.push(rTag("kids", 0.5));
  if (n === 15) boosts.push({ t: "re", re: /\bquinceanera\b/, wt: 0.5 });
  // "Getting Old" / "Another Year Wiser" suit the round grown-up birthdays
  if (n >= 30 && n % 5 === 0) {
    boosts.push({ t: "re", re: /\b(old|older|wiser|milestones?)\b/, wt: 0.5 });
  }
  return { terms: [occ("Birthday", wt), w("birthday", wt)], boosts };
}

export type SearchDoc = {
  design: string;
  code: string; // lowercased design code — exact whole-code matches only
  title: Set<string>;
  titleText: string; // normalized title, for wording regexes
  occ: Set<string>; // words of every occasion label this design belongs to
  occLabels: Set<string>;
  r: Set<string>;
  v: Set<string>;
  pop: number; // popularity rank (lower = sells more)
  order: number; // manifest order (stable tiebreak)
};

export type SearchIndex = {
  docs: SearchDoc[];
  vocab: string[];
  vocabSet: Set<string>;
  codes: Map<string, number>;
};

/** Build once per data load. `extraBirthday` = collection members that are
 *  birthday designs despite a non-HBD code (FAF44 "Happy Birthday Dad"). */
export function buildSearchIndex(
  graphics: LibraryGraphic[],
  opts: {
    tags?: TagIndex;
    ranking?: PopularRanking;
    extraBirthday?: Set<string>;
    // hub folder designs: the title IS the customer-facing folder label,
    // and hub codes never participate (they're internal)
    hub?: boolean;
  } = {},
): SearchIndex {
  const rank = new Map((opts.ranking ?? []).map((p, i) => [p.design, i]));
  const vocab = new Set<string>();
  const codes = new Map<string, number>();
  const docs = graphics.map((g, order): SearchDoc => {
    const title = new Set(
      wordsOf(g.title).filter((x) => !BOILERPLATE.has(x)).map(stemWord),
    );
    const occLabels = new Set<string>();
    if (!opts.hub) {
      occLabels.add(occasionOf(g.design));
      if (opts.extraBirthday?.has(g.design)) occLabels.add("Birthday");
    }
    const occWords = new Set(
      [...occLabels].flatMap(wordsOf).filter((x) => !STOPWORDS.has(x)).map(stemWord),
    );
    const t = opts.tags?.[g.design];
    const r = new Set((t?.r ?? []).filter((x) => x !== "anyone").map(stemWord));
    const v = new Set((t?.v ?? []).map(stemWord));
    for (const s of [title, occWords, r, v]) for (const x of s) vocab.add(x);
    if (!opts.hub) codes.set(g.design.toLowerCase(), order);
    return {
      design: g.design,
      code: g.design.toLowerCase(),
      title,
      titleText: normalizeText(g.title),
      occ: occWords,
      occLabels,
      r,
      v,
      pop: rank.get(g.design) ?? Number.MAX_SAFE_INTEGER,
      order,
    };
  });
  return { docs, vocab: [...vocab], vocabSet: vocab, codes };
}

/** Optimal-string-alignment distance, bailing out once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur.push(d);
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
    prev2.splice(0, prev2.length, ...prev);
    prev = cur;
  }
  return prev[b.length];
}

/** The shopper's own word → vocabulary words it should hit, with a match
 *  quality: exact 1, prefix 0.85 (typing "valen…"), small typo 0.7. A word
 *  the library already uses matches only itself ("thank" must not pull in
 *  every Thanksgiving design). Typos must keep the first letter and only
 *  count on longer words — "father" is not a typo of "rather". */
function expandWord(tok: string, index: SearchIndex): Map<string, number> {
  const out = new Map<string, number>();
  if (index.vocabSet.has(tok)) {
    out.set(tok, 1);
    return out;
  }
  if (/^\d+$/.test(tok)) return out;
  const maxTypos = tok.length >= 8 ? 2 : tok.length >= 5 ? 1 : 0;
  for (const v of index.vocab) {
    if (tok.length >= 4 && v.startsWith(tok)) out.set(v, 0.85);
    else if (
      maxTypos &&
      v[0] === tok[0] &&
      editDistance(tok, v, maxTypos) <= maxTypos
    ) {
      out.set(v, 0.7);
    }
  }
  return out;
}

function parseQuery(query: string, index: SearchIndex): Concept[] {
  let q = ` ${normalizeText(query)} `;
  for (const [re, rep] of PHRASES) q = q.replace(re, rep);

  const concepts: Concept[] = [];
  const noAge = NOT_AN_AGE.test(q);
  let ageTaken = false;
  for (const re of AGE_PATTERNS) {
    q = q.replace(re, (m, num: string) => {
      const n = Number(num);
      if (n < 1 || n > 120) return m; // "250th" stays a plain word
      if (!noAge && !ageTaken) {
        concepts.push(ageConcept(n));
        ageTaken = true;
      }
      return " ";
    });
  }

  const raw = [...new Set(wordsOf(q))];
  const meaningful = raw.filter((x) => !STOPWORDS.has(x));
  // Nothing but stopwords ("happy") → search those words literally; next
  // to an age ("happy 40th") they're just filler.
  for (const tok of meaningful.length || concepts.length ? meaningful : raw) {
    const code = index.codes.has(tok) ? tok : undefined;
    const stem = stemWord(tok);
    const syn = SYNONYMS.get(tok) ?? SYNONYMS.get(stem);
    // A word with curated synonyms already says what it means — only
    // unknown words get prefix/typo matching.
    const terms: Term[] = [{ t: "w", w: stem, wt: 1, fuzzy: !syn }];
    if (syn) terms.push(...syn);
    let boosts: Term[] = [];
    // A bare number reads as an age too ("5" → birthdays, kids first) —
    // on top of any literal title match ("2026", "1776").
    const n = /^\d{1,3}$/.test(tok) ? Number(tok) : 0;
    if (n >= 1 && n <= 120 && !noAge && !ageTaken) {
      const age = ageConcept(n, 0.8);
      terms.push(...age.terms);
      boosts = age.boosts;
      ageTaken = true;
    }
    concepts.push({ terms, boosts, code });
  }
  return concepts;
}

function termHits(term: Term, doc: SearchDoc, index: SearchIndex, cache: Map<string, Map<string, number>>): Partial<Record<Field, number>> {
  switch (term.t) {
    case "w": {
      const key = `${term.fuzzy ? "~" : "="}${term.w}`;
      let words = cache.get(key);
      if (!words) {
        words = term.fuzzy ? expandWord(term.w, index) : new Map([[term.w, 1]]);
        cache.set(key, words);
      }
      const hits: Partial<Record<Field, number>> = {};
      for (const f of ["title", "occ", "r", "v"] as Field[]) {
        let best = 0;
        for (const x of doc[f]) best = Math.max(best, words.get(x) ?? 0);
        if (best) hits[f] = FIELD_WEIGHT[f] * best * term.wt;
      }
      return hits;
    }
    case "occ":
      return doc.occLabels.has(term.label) ? { occ: FIELD_WEIGHT.occ * term.wt } : {};
    case "r":
      return doc.r.has(term.tag) ? { r: FIELD_WEIGHT.r * term.wt } : {};
    case "v":
      return doc.v.has(term.tag) ? { v: FIELD_WEIGHT.v * term.wt } : {};
    case "re":
      return term.re.test(doc.titleText) ? { title: term.wt } : {};
  }
}

/** Score of one concept against one design: per field, the best term hit
 *  (so a word and its synonym can't double-count the same field). */
function conceptScore(c: Concept, doc: SearchDoc, index: SearchIndex, cache: Map<string, Map<string, number>>): number {
  if (c.code && doc.code === c.code) return 10; // exact design code
  const best: Partial<Record<Field, number>> = {};
  for (const term of c.terms) {
    const hits = termHits(term, doc, index, cache);
    for (const f of Object.keys(hits) as Field[]) {
      best[f] = Math.max(best[f] ?? 0, hits[f]!);
    }
  }
  let s = Object.values(best).reduce((a, b) => a + (b ?? 0), 0);
  if (s > 0) {
    for (const b of c.boosts) {
      const hits = termHits(b, doc, index, cache);
      if (Object.keys(hits).length) s += b.wt;
    }
  }
  return s;
}

export type SearchResult = {
  exact: string[]; // designs matching every concept, best first
  close: string[]; // best partial matches (the rest), best first
};

/** Rank the index for a query. `allow` restricts candidates (an open aisle). */
export function searchLibrary(
  index: SearchIndex,
  query: string,
  opts: { allow?: (design: string) => boolean; closeLimit?: number } = {},
): SearchResult {
  const concepts = parseQuery(query, index);
  if (!concepts.length) return { exact: [], close: [] };
  const cache = new Map<string, Map<string, number>>();
  const rows: { doc: SearchDoc; scores: number[] }[] = [];
  const best = concepts.map(() => 0);
  for (const doc of index.docs) {
    if (opts.allow && !opts.allow(doc.design)) continue;
    const scores = concepts.map((c) => conceptScore(c, doc, index, cache));
    if (!scores.some((s) => s > 0)) continue;
    rows.push({ doc, scores });
    scores.forEach((s, i) => (best[i] = Math.max(best[i], s)));
  }
  // Each concept counts equally — scored against its own best match — so
  // "birthday for my boss" can't be swamped by whichever word happens to
  // hit more fields. Rounded so near-equal matches tie and popularity
  // decides between them.
  const hits = rows.map(({ doc, scores }) => ({
    doc,
    matched: scores.filter((s) => s > 0).length,
    score:
      Math.round(
        scores.reduce((sum, s, i) => sum + (best[i] ? s / best[i] : 0), 0) * 1000,
      ) / 1000,
  }));
  const rankHits = (a: (typeof hits)[number], b: (typeof hits)[number]) =>
    b.matched - a.matched ||
    b.score - a.score ||
    a.doc.pop - b.doc.pop ||
    a.doc.order - b.doc.order;
  hits.sort(rankHits);
  return {
    exact: hits.filter((h) => h.matched === concepts.length).map((h) => h.doc.design),
    close: hits
      .filter((h) => h.matched < concepts.length)
      .slice(0, opts.closeLimit ?? 24)
      .map((h) => h.doc.design),
  };
}

// Session-scoped cache: re-entering the library ("Change graphic") must be
// instant, not a ~1.6MB refetch — Vercel serves /public JSON with
// must-revalidate, so the browser re-downloads on every mount otherwise.
const jsonCache = new Map<string, unknown>();

export async function loadJson<T>(url: string): Promise<T | null> {
  if (jsonCache.has(url)) return jsonCache.get(url) as T;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const v = (await r.json()) as T;
    jsonCache.set(url, v);
    return v;
  } catch {
    return null;
  }
}
