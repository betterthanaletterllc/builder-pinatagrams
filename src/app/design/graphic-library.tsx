"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphicChoice } from "@/lib/flow";
import type { HubGraphicCategory, HubGraphicEntry } from "@/lib/hub";
import { track } from "@/lib/analytics";
import {
  BIRTHDAY_SUB_MIN,
  BIRTHDAY_SUBS,
  buildSearchIndex,
  byPopularity,
  cdnThumb,
  EXCLUDED_PREFIXES,
  FALLBACK_OCCASION,
  FAMILY_RECIPIENTS,
  FRIEND_RECIPIENTS,
  HOLIDAY_LABELS,
  holidaysFromToday,
  loadJson,
  loadLibraryState,
  occasionOf,
  PET_RECIPIENTS,
  saveLibraryState,
  searchLibrary,
  SHELF_OCCASIONS,
  VIBES,
  type LibraryGraphic,
  type PopularRanking,
  type TagIndex,
} from "@/lib/library-data";
import { isSchoolDesign, occasionDef, type OccasionId } from "@/v2/lib/occasions";
import { useLongPress } from "@/v2/ui/long-press";
import QuickLook from "@/v2/ui/quick-look";

/**
 * Gift-finding library. Default view = shelves (next holiday, Popular right
 * now, This season, top occasions); search or an aisle pick flips to a
 * filtered grid.
 *
 * Browsing = two-level AISLES: one row of broad categories (Birthdays first —
 * the #1 use case gets one tap), tapping an aisle opens its sub-chips.
 * Holidays sort by the calendar starting from today, so the next holiday is
 * always the first chip. Chips show counts; empty ones don't render.
 *
 * Every list is ordered by 12-month popularity (best sellers first), and a
 * piece of art appears at most once per view.
 */

type Manifest = { graphics: LibraryGraphic[] };
type PopularFile = { ranking: PopularRanking };
type TagFile = { tags: TagIndex };
// Curated collection memberships (mirrors the storefront's collections) —
// catches designs whose CONTENT is birthday but whose code isn't HBD
// (e.g. FAF44 "Happy Birthday Dad" lives in the Birthday collection).
type CollectionsFile = { birthday?: string[] };

type Aisle =
  | "birthdays"
  | "thank-you"
  | "congrats"
  | "love"
  | "get-well"
  | "holidays"
  | "school"
  | "just-because"
  | "more"
  | "family"
  | "friends"
  | "pets"
  | "vibe";

// The occasion aisles ARE builder2's step 1 chips — same names, same order
// (v2/lib/occasions OCCASION_DEFS) — so a shopper who learned the chips
// finds the same words here. Each opens straight onto its full grid.
type OccasionAisle = Exclude<Aisle, "birthdays" | "holidays" | "more" | "family" | "friends" | "pets" | "vibe">;
const OCCASION_AISLES: OccasionAisle[] = [
  "thank-you",
  "congrats",
  "love",
  "get-well",
  "school",
  "just-because",
];
const isOccasionAisle = (a: Aisle | null): a is OccasionAisle =>
  OCCASION_AISLES.includes(a as OccasionAisle);
// Aisles that open on a grid (sub-chips narrow it); the rest open on a
// shelf per sub-category.
const GRID_AISLES = new Set<Aisle>(["birthdays", ...OCCASION_AISLES]);

// Library occasion labels an occasion aisle covers (School & grad also
// takes grad- and teacher-tagged designs — isSchoolDesign).
const aisleLabels = (a: OccasionAisle): string[] => occasionDef(a as OccasionId).library;
// Everything the chips don't cover lands in "More occasions".
const CHIP_LABELS = new Set(["Birthday", ...OCCASION_AISLES.flatMap(aisleLabels)]);
const isMoreLabel = (o: string) => !CHIP_LABELS.has(o) && !HOLIDAY_LABELS.has(o);

// School & grad sub-filters (recipient tags).
const SCHOOL_SUBS: [string, string, (r: string[], o: string) => boolean][] = [
  ["grad", "Grads", (r) => r.includes("grad")],
  ["teacher", "Teachers", (r) => r.includes("teacher")],
  [
    "back-to-school",
    "Back to school",
    (r, o) => o === "School" && !r.includes("grad") && !r.includes("teacher"),
  ],
];

// "All …" sub-chip sentinel (the union of the aisle's sub-filters).
const ALL = "__all__";

// Per-category teaser size: this many graphics + a "See all" tile fills ~2
// rows of the wrapping grid before the shopper commits to a category.
const PREVIEW = 11;

// Search fallbacks: how many close matches / popular picks to offer, and
// below how many exact results the close matches are offered as well.
const CLOSE_MAX = 12;
const FEW_RESULTS = 4;
// Under this many results, related shelves + a "make your own" card follow.
const RELATED_BELOW = 8;

// library_search fires once the shopper pauses typing, not per keystroke.
const SEARCH_EVENT_DELAY_MS = 800;

// Stable defaults: a fresh [] per render would rebuild the hub search index
// (and re-run the search) on every render.
const NO_HUB_GRAPHICS: HubGraphicEntry[] = [];
const NO_HUB_CATEGORIES: HubGraphicCategory[] = [];

const AISLES: { id: Aisle; label: string; needsTags?: boolean }[] = [
  { id: "birthdays", label: occasionDef("birthday").label },
  { id: "thank-you", label: occasionDef("thank-you").label },
  { id: "congrats", label: occasionDef("congrats").label },
  { id: "love", label: occasionDef("love").label },
  { id: "get-well", label: occasionDef("get-well").label },
  { id: "holidays", label: occasionDef("holidays").label },
  { id: "school", label: occasionDef("school").label },
  { id: "just-because", label: occasionDef("just-because").label },
  { id: "more", label: "More occasions" },
  { id: "family", label: "Family", needsTags: true },
  { id: "friends", label: "Friends & work", needsTags: true },
  { id: "pets", label: "Pets", needsTags: true },
  { id: "vibe", label: "Vibe", needsTags: true },
];

/** The aisle a library occasion label lives in (shelf "See all", related
 *  shelves under a short search). */
function aisleForLabel(label: string): { a: Aisle; s: string | null } {
  if (label === "Birthday") return { a: "birthdays", s: null };
  if (HOLIDAY_LABELS.has(label)) return { a: "holidays", s: label };
  const occ = OCCASION_AISLES.find((a) => aisleLabels(a).includes(label));
  if (occ) return { a: occ, s: null };
  return { a: "more", s: label };
}

const aisleLabel = (a: Aisle) => AISLES.find((x) => x.id === a)?.label ?? "";

// CDN-resized 360px thumbs make shelf scrolling feel instant.
const THUMB_W = 360;
// The art is label-shaped (2.05:1); width/height reserve that box before the
// image arrives, so lazy tiles never shift the grid.
const THUMB_H = 176;
const thumbUrl = (u: string): string => cdnThumb(u, THUMB_W) ?? u;

// The first this-many cards of a grid load at once (search results land
// above the fold; lazy-loading them left a blank grid for seconds).
const EAGER = 6;

function Card({
  g,
  onPick,
  onPeek,
  eager = false,
}: {
  g: LibraryGraphic;
  onPick: (g: LibraryGraphic) => void;
  /** Press-and-hold: the art up close. */
  onPeek?: (g: LibraryGraphic) => void;
  // Only the first cards load eagerly — the rest wait until scrolled near
  // (the default view used to request ~88 thumbnails at once).
  eager?: boolean;
}) {
  // Art only — no product name. The graphic sells itself; the title stays
  // available to screen readers and as a hover tooltip.
  const src = g.art ?? g.thumb;
  const hold = useLongPress<HTMLButtonElement>(() => onPeek?.(g));
  return (
    <button
      className="library-card"
      onClick={() => onPick(g)}
      title={g.title}
      aria-label={g.title}
      {...(onPeek ? hold : {})}
    >
      {src ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={thumbUrl(src)}
          alt={g.title}
          width={THUMB_W}
          height={THUMB_H}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          // the shimmer placeholder (globals .library-card img) stops here
          onLoad={(e) => (e.currentTarget.dataset.loaded = "")}
        />
      ) : null}
    </button>
  );
}

/** The last card of a short result list: their own label instead. */
function MakeOwnCard({ text, onMakeOwn }: { text: string; onMakeOwn: (t: string | null) => void }) {
  return (
    <button className="library-card make-own-card" onClick={() => onMakeOwn(text || null)}>
      <span className="make-own-plus" aria-hidden>
        ＋
      </span>
      <span>{text ? `Put “${clipQuery(text)}” on your own label` : "Make your own label"}</span>
    </button>
  );
}

/** A query short enough to quote back on a button. */
function clipQuery(q: string): string {
  const t = q.trim().replace(/\s+/g, " ");
  return t.length > 28 ? `${t.slice(0, 27)}…` : t;
}

export default function GraphicLibrary({
  onPick,
  restrict = null,
  hubGraphics = NO_HUB_GRAPHICS,
  hubCategories = NO_HUB_CATEGORIES,
  styleId,
  initialView,
  autoFocusSearch = false,
  onMakeOwn,
}: {
  onPick: (g: GraphicChoice) => void;
  /** Opened from a search field: the cursor goes straight into search. */
  autoFocusSearch?: boolean;
  /** "Make your own" from inside the library (no match, a short list) —
   *  with the search words to start the label with, when there are any. */
  onMakeOwn?: (text: string | null) => void;
  // Open on this aisle / sub-filter (no search) instead of where the shopper
  // last left off — builder2's "See all Birthday designs" / "See all".
  initialView?: { aisle: string | null; sub: string | null };
  // Variant knob (hub Builder → Storefronts): "birthday" trims the Shopify
  // library to the Birthday set; "none" drops the Shopify library entirely
  // (a folders-only storefront — just this site's granted hub folders).
  // Both hide the aisle row; search and shelves work within what's left.
  restrict?: "birthday" | "none" | null;
  // Hub-uploaded graphics (admin /catalog): public categories render as
  // shelves up top; private (hidden) ones are search-only. Each entry's
  // bodyStyles must allow the current body.
  hubGraphics?: HubGraphicEntry[];
  hubCategories?: HubGraphicCategory[];
  styleId: string;
}) {
  const [graphics, setGraphics] = useState<LibraryGraphic[] | null>(null);
  const [tags, setTags] = useState<TagIndex>({});
  const [popular, setPopular] = useState<PopularRanking>([]);
  const [bdayExtra, setBdayExtra] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState(false);

  // Re-entering (e.g. "Change graphic") resumes EXACTLY where the shopper
  // left off: same aisle, same sub-pick, same search, same scroll.
  const restored = useRef(
    initialView ? { q: "", a: initialView.aisle, s: initialView.sub, y: 0 } : loadLibraryState(),
  );
  const isAisle = (v: string | null): v is Aisle =>
    AISLES.some((a) => a.id === v);
  const [query, setQuery] = useState(restored.current?.q ?? "");
  // A restricted library has no aisle row — ignore any restored aisle/sub
  // (they'd invisibly filter the trimmed set down to nothing).
  const [aisle, setAisle] = useState<Aisle | null>(
    !restrict && isAisle(restored.current?.a ?? null)
      ? (restored.current!.a as Aisle)
      : null,
  );
  const [sub, setSub] = useState<string | null>(() => {
    if (restrict) return null;
    const s = restored.current?.s ?? null;
    // A Birthdays sub-filter that no longer exists must not silently
    // empty the grid on "Change graphic".
    if (
      restored.current?.a === "birthdays" &&
      s &&
      !BIRTHDAY_SUBS.some((b) => b.key === s)
    ) {
      return null;
    }
    return s;
  });

  const load = useCallback(() => {
    setFailed(false);
    Promise.all([
      loadJson<Manifest>("/graphics.json"),
      loadJson<TagFile>("/library-index.json"),
      loadJson<PopularFile>("/popular.json"),
      loadJson<CollectionsFile>("/collections.json"),
    ]).then(([manifest, tagFile, popularFile, collections]) => {
      if (!manifest) {
        setFailed(true);
        return;
      }
      let list =
        restrict === "none"
          ? []
          : manifest.graphics.filter(
              (g) => !EXCLUDED_PREFIXES.has(g.design.replace(/[0-9]+$/, "")),
            );
      if (restrict === "birthday") {
        const extra = new Set(collections?.birthday ?? []);
        list = list.filter(
          (g) => occasionOf(g.design) === "Birthday" || extra.has(g.design),
        );
      }
      setGraphics(list);
      if (tagFile?.tags) setTags(tagFile.tags);
      if (popularFile?.ranking) setPopular(popularFile.ranking);
      if (collections?.birthday) setBdayExtra(new Set(collections.birthday));
      // Put the shopper back at their scroll position once the (uniform-
      // height) cards have reserved their layout space.
      const y = restored.current?.y ?? 0;
      if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
    });
  }, [restrict]);

  useEffect(() => {
    load();
  }, [load]);

  // Remember the view on every change; pick() below also captures scroll.
  useEffect(() => {
    saveLibraryState({ q: query, a: aisle, s: sub, y: window.scrollY });
  }, [query, aisle, sub]);

  /* --- hub-uploaded graphics (admin /catalog) ---------------------------- */
  // The catalog already served ONLY the folders this storefront may sell
  // (public + granted), so everything here shelves under its folder label.
  // Titles are INTERNAL — cards carry the folder label for tooltips/search;
  // the full print art + sha ride the pick via hubByDesign.
  const hubCatLabel = useMemo(
    () => new Map(hubCategories.map((c) => [c.id, c.label])),
    [hubCategories],
  );
  const hubWearable = useMemo(
    () =>
      hubGraphics.filter(
        (h) =>
          (h.bodyStyles === "all" || h.bodyStyles.includes(styleId)) &&
          (restrict !== "birthday" || h.category === "birthday"),
      ),
    [hubGraphics, styleId, restrict],
  );
  const hubByDesign = useMemo(
    () => new Map(hubWearable.map((h) => [h.design, h])),
    [hubWearable],
  );
  const hubVisible = useMemo(
    () =>
      hubWearable.map(
        (h): LibraryGraphic => ({
          design: h.design,
          // Customer-safe identity: the folder's label, never the internal
          // upload title.
          title: `${hubCatLabel.get(h.category) ?? "Piñatagram"} design`,
          thumb: h.thumb,
          art: h.thumb, // cards render the light thumb, never the print file
          message: null,
        }),
      ),
    [hubWearable, hubCatLabel],
  );

  const pick = (g: LibraryGraphic) => {
    saveLibraryState({ q: query, a: aisle, s: sub, y: window.scrollY });
    const hub = hubByDesign.get(g.design);
    if (hub) {
      onPick({
        type: "hub",
        design: hub.design,
        title: hub.title,
        thumb: hub.thumb,
        art: hub.art,
        artSha256: hub.artSha256,
      });
      return;
    }
    onPick({
      type: "shopify",
      design: g.design,
      title: g.title,
      thumb: g.thumb,
      art: g.art,
      message: g.message ?? null,
    });
  };

  const hasTags = Object.keys(tags).length > 0;

  // 12-month sales rank per design (lower sells more).
  const popRank = useMemo(
    () => new Map(popular.map((p, i) => [p.design, i])),
    [popular],
  );

  const pickAisle = (id: Aisle) => {
    if (aisle === id) {
      setAisle(null);
      setSub(null);
    } else {
      setAisle(id);
      setSub(null);
      track("library_aisle", { aisle: id });
    }
  };

  const pickSub = (key: string) => {
    // Grid aisles open on their full grid, so "All …" = no sub-filter.
    const next =
      (aisle && GRID_AISLES.has(aisle) && key === ALL) || sub === key ? null : key;
    setSub(next);
    if (next && aisle) track("library_aisle", { aisle, sub: next });
  };

  // Shelf "See all →" (and the related shelves under a short search) jump
  // into an aisle, optionally narrowed to one sub-filter.
  const jumpTo = (to: { a: Aisle; s: string | null }) => {
    setQuery("");
    setAisle(to.a);
    setSub(to.s);
    track("library_aisle", {
      aisle: to.a,
      ...(to.s ? { sub: to.s } : {}),
      via: "see_all",
    });
  };
  const jumpToOccasion = (label: string) => jumpTo(aisleForLabel(label));

  // Press-and-hold → the art up close.
  const [peek, setPeek] = useState<LibraryGraphic | null>(null);

  const recipientsOf = (g: LibraryGraphic) => tags[g.design]?.r ?? [];
  const vibesOf = (g: LibraryGraphic) => tags[g.design]?.v ?? [];

  // One matcher shared by the grid filter AND the per-subcategory shelves.
  const subMatches = useMemo(() => {
    return (g: LibraryGraphic, a: Aisle, key: string): boolean => {
      const o = occasionOf(g.design);
      const r = recipientsOf(g);
      switch (a) {
        case "birthdays": {
          if (o !== "Birthday" && !bdayExtra.has(g.design)) return false;
          if (key === ALL) return true;
          const f = BIRTHDAY_SUBS.find((b) => b.key === key);
          return f ? f.test(g, tags[g.design]) : true;
        }
        case "thank-you":
        case "congrats":
        case "love":
        case "get-well":
        case "just-because":
          return key === ALL ? aisleLabels(a).includes(o) : o === key;
        case "school": {
          if (key === ALL) return isSchoolDesign(g.design, r);
          const f = SCHOOL_SUBS.find(([k]) => k === key);
          return f ? isSchoolDesign(g.design, r) && f[2](r, o) : false;
        }
        case "more":
          return key === ALL ? isMoreLabel(o) : o === key;
        case "holidays":
          return key === ALL ? HOLIDAY_LABELS.has(o) : o === key;
        case "family":
          return key === ALL
            ? FAMILY_RECIPIENTS.some(([k]) => r.includes(k))
            : r.includes(key);
        case "friends":
          return key === ALL
            ? FRIEND_RECIPIENTS.some(([k]) => r.includes(k))
            : r.includes(key);
        case "pets":
          return key === ALL
            ? PET_RECIPIENTS.some(([k]) => r.includes(k))
            : r.includes(key);
        case "vibe":
          return vibesOf(g).includes(key);
        default:
          return true;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags, bdayExtra]);

  const inAisle = useMemo(() => {
    return (g: LibraryGraphic): boolean => {
      if (!aisle) return true;
      if (GRID_AISLES.has(aisle)) return subMatches(g, aisle, sub ?? ALL);
      if (!sub) return true; // aisle open, nothing picked yet → shelves below
      return subMatches(g, aisle, sub);
    };
  }, [aisle, sub, subMatches]);

  const filtering =
    query.trim() !== "" ||
    (aisle !== null && GRID_AISLES.has(aisle)) ||
    (aisle !== null && sub !== null);

  const byDesign = useMemo(() => {
    const m = new Map<string, LibraryGraphic>();
    for (const g of graphics ?? []) m.set(g.design, g);
    return m;
  }, [graphics]);

  const occasionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of graphics ?? []) {
      const o = occasionOf(g.design);
      counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    return counts;
  }, [graphics]);

  const recipientCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of graphics ?? []) {
      for (const r of tags[g.design]?.r ?? []) {
        counts.set(r, (counts.get(r) ?? 0) + 1);
      }
    }
    return counts;
  }, [graphics, tags]);

  const vibeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of graphics ?? []) {
      for (const v of tags[g.design]?.v ?? []) {
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }
    return counts;
  }, [graphics, tags]);

  // Sub-chips for the open aisle: [key, label, count], zero-count hidden.
  const subChips = useMemo((): [string, string, number][] => {
    if (!aisle) return [];
    if (aisle === "birthdays") {
      // Derived filters (library-data BIRTHDAY_SUBS); thin ones don't show.
      const bdays = (graphics ?? []).filter((g) =>
        subMatches(g, "birthdays", ALL),
      );
      const chips = BIRTHDAY_SUBS.map((b): [string, string, number] => [
        b.key,
        b.label,
        bdays.filter((g) => b.test(g, tags[g.design])).length,
      ]).filter(([, , n]) => n >= BIRTHDAY_SUB_MIN);
      return chips.length ? [[ALL, "All birthdays", bdays.length], ...chips] : [];
    }
    const fromRecipients = (pairs: [string, string][], allLabel: string) => {
      const chips = pairs
        .map(([k, label]): [string, string, number] => [
          k,
          label,
          recipientCounts.get(k) ?? 0,
        ])
        .filter(([, , n]) => n > 0);
      if (chips.length > 1) {
        const union = (graphics ?? []).filter((g) =>
          pairs.some(([k]) => recipientsOf(g).includes(k)),
        ).length;
        chips.unshift([ALL, allLabel, union]);
      }
      return chips;
    };
    // Several labels under one chip (Love = Valentine's + Anniversary +
    // Wedding): a sub-chip per label, "All" first.
    const fromLabels = (labels: string[], allLabel: string) => {
      const chips = labels
        .map((o): [string, string, number] => [o, o, occasionCounts.get(o) ?? 0])
        .filter(([, , n]) => n > 0);
      if (chips.length < 2) return [];
      const total = chips.reduce((s, [, , n]) => s + n, 0);
      return [[ALL, allLabel, total] as [string, string, number], ...chips];
    };
    switch (aisle) {
      case "thank-you":
      case "congrats":
      case "get-well":
        return [];
      case "love":
        return fromLabels(aisleLabels("love"), "All love");
      case "just-because":
        return fromLabels(aisleLabels("just-because"), "All");
      case "school": {
        const all = (graphics ?? []).filter((g) => subMatches(g, "school", ALL));
        const chips = SCHOOL_SUBS.map(([k, label]): [string, string, number] => [
          k,
          label,
          all.filter((g) => subMatches(g, "school", k)).length,
        ]).filter(([, , n]) => n > 0);
        return chips.length > 1 ? [[ALL, "All school & grad", all.length], ...chips] : [];
      }
      case "more":
        return [...occasionCounts.entries()]
          .filter(([o]) => isMoreLabel(o))
          .sort((a, b) =>
            a[0] === FALLBACK_OCCASION ? 1 :
            b[0] === FALLBACK_OCCASION ? -1 :
            b[1] - a[1],
          )
          .map(([o, n]): [string, string, number] => [o, o, n]);
      case "holidays": {
        const chips = holidaysFromToday()
          .map((h): [string, string, number] => [
            h.label,
            h.label,
            occasionCounts.get(h.label) ?? 0,
          ])
          .filter(([, , n]) => n > 0);
        if (chips.length > 1) {
          const union = (graphics ?? []).filter((g) =>
            HOLIDAY_LABELS.has(occasionOf(g.design)),
          ).length;
          chips.unshift([ALL, "All holidays", union]);
        }
        return chips;
      }
      case "family":
        return fromRecipients(FAMILY_RECIPIENTS, "All family");
      case "friends":
        return fromRecipients(FRIEND_RECIPIENTS, "Everyone");
      case "pets":
        return fromRecipients(PET_RECIPIENTS, "All pets");
      case "vibe":
        return VIBES.map(([k, label]): [string, string, number] => [
          k,
          label,
          vibeCounts.get(k) ?? 0,
        ]).filter(([, , n]) => n > 0);
      default:
        return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aisle, graphics, tags, subMatches, occasionCounts, recipientCounts, vibeCounts]);

  /* --- search (library-data searchLibrary) -------------------------------- */
  const q = query.trim();

  const searchIndex = useMemo(
    () =>
      graphics
        ? buildSearchIndex(graphics, {
            tags,
            ranking: popular,
            extraBirthday: bdayExtra,
          })
        : null,
    [graphics, tags, popular, bdayExtra],
  );
  // Hub graphics join the SEARCH grid (aisles never include them), matched
  // on the customer-facing card title — the folder label. Internal upload
  // titles and H-codes never participate.
  const hubIndex = useMemo(
    () => buildSearchIndex(hubVisible, { hub: true }),
    [hubVisible],
  );
  const hubVisibleByDesign = useMemo(
    () => new Map(hubVisible.map((g) => [g.design, g])),
    [hubVisible],
  );

  const search = useMemo(() => {
    if (!q || !searchIndex) return null;
    const lib = searchLibrary(searchIndex, q, {
      allow: aisle
        ? (d) => {
            const g = byDesign.get(d);
            return !!g && inAisle(g);
          }
        : undefined,
      closeLimit: CLOSE_MAX,
    });
    const hub = aisle
      ? { exact: [], close: [] }
      : searchLibrary(hubIndex, q, { closeLimit: CLOSE_MAX });
    const pickFrom = (m: Map<string, LibraryGraphic>, ds: string[]) =>
      ds.map((d) => m.get(d)).filter((g): g is LibraryGraphic => !!g);
    // Hub folders lead, exactly as their shelves do on the default view.
    return {
      exact: [
        ...pickFrom(hubVisibleByDesign, hub.exact),
        ...pickFrom(byDesign, lib.exact),
      ],
      close: [
        ...pickFrom(hubVisibleByDesign, hub.close),
        ...pickFrom(byDesign, lib.close),
      ].slice(0, CLOSE_MAX),
    };
  }, [q, searchIndex, hubIndex, aisle, inAisle, byDesign, hubVisibleByDesign]);

  // Nothing even partially matches ("wine") → the best sellers (within the
  // open aisle, if any) instead of a dead end.
  const searchFallback = useMemo(() => {
    if (!search || search.exact.length || search.close.length || !graphics) {
      return [];
    }
    const pool = aisle ? graphics.filter(inAisle) : graphics;
    const picks = byPopularity(pool, popRank).slice(0, CLOSE_MAX);
    return picks.length ? picks : hubVisible.slice(0, CLOSE_MAX);
  }, [search, graphics, aisle, inAisle, popRank, hubVisible]);

  // A short result list ("retirement" = 2) never dead-ends in white space:
  // under it, shelves from the occasions those results belong to, plus a
  // "make your own" card in the grid itself.
  const related = useMemo(() => {
    if (!search || !graphics || aisle) return [];
    const exact = search.exact;
    if (exact.length === 0 || exact.length >= RELATED_BELOW) return [];
    const shown = new Set(
      [...exact, ...(exact.length < FEW_RESULTS ? search.close : [])].map((g) => g.design),
    );
    const targets: { a: Aisle; s: string | null }[] = [];
    for (const g of exact) {
      if (hubVisibleByDesign.has(g.design)) continue;
      const to = aisleForLabel(occasionOf(g.design));
      // Get well mixes get-well, condolence and cancer support: never
      // offered as "more like this" ("sorry" means apology designs).
      if (to.a === "get-well") continue;
      if (!targets.some((x) => x.a === to.a && x.s === to.s)) targets.push(to);
      if (targets.length === 2) break;
    }
    return targets
      .map((to) => {
        const all = byPopularity(
          graphics.filter((g) => subMatches(g, to.a, GRID_AISLES.has(to.a) ? ALL : (to.s ?? ALL))),
          popRank,
        );
        const items = all.filter((g) => !shown.has(g.design)).slice(0, PREVIEW);
        for (const g of items) shown.add(g.design);
        const name = GRID_AISLES.has(to.a) ? aisleLabel(to.a) : (to.s ?? aisleLabel(to.a));
        return {
          to: GRID_AISLES.has(to.a) ? { a: to.a, s: null } : to,
          title: `More ${name} designs`,
          items,
          total: all.length,
        };
      })
      .filter((s) => s.items.length > 0);
  }, [search, graphics, aisle, hubVisibleByDesign, subMatches, popRank]);

  // Aisle grid (no search): best sellers first.
  const aisleGrid = useMemo(
    () =>
      !graphics || q ? [] : byPopularity(graphics.filter(inAisle), popRank),
    [graphics, q, inAisle, popRank],
  );

  // Funnel signal for what shoppers look for and don't find — once the
  // typing pauses, never per keystroke, and not again for a query restored
  // from "Change graphic".
  const loggedQuery = useRef(restored.current?.q?.trim() ?? "");
  const exactCount = search?.exact.length ?? 0;
  useEffect(() => {
    if (!q || !search) return;
    const t = window.setTimeout(() => {
      if (loggedQuery.current === q) return;
      loggedQuery.current = q;
      const qq = q.slice(0, 64);
      track("library_search", { q: qq, results: exactCount });
      if (exactCount === 0) track("library_zero_results", { q: qq });
    }, SEARCH_EVENT_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [q, search, exactCount]);

  // Every served folder = a shelf pinned ABOVE the standard shelves (the
  // catalog already filtered to what this storefront may sell, so granted
  // restricted folders shelve here exactly like public ones).
  const hubShelves = useMemo(() => {
    if (filtering) return [];
    return hubCategories
      .map((c) => {
        const items = hubVisible.filter(
          (g) => hubByDesign.get(g.design)?.category === c.id,
        );
        return {
          title: c.label,
          items,
          total: items.length,
          seeAll: undefined as string | undefined,
          // See-all for a hub category = search its label (public hub
          // matching includes the category label, so the grid shows all).
          seeAllQuery: c.label,
        };
      })
      .filter((s) => s.items.length > 0);
  }, [hubCategories, hubVisible, hubByDesign, filtering]);

  const shelves = useMemo(() => {
    if (!graphics || filtering) return [];
    const out: {
      title: string;
      items: LibraryGraphic[];
      total: number;
      seeAll?: { a: Aisle; s: string | null };
    }[] = [];
    // One piece of art shows once per view: each shelf previews the best
    // sellers no earlier shelf has shown ("Halloween is coming" and "This
    // season" used to lead with the same art). "See all N" still counts —
    // and opens — every design in the category.
    const seen = new Set<string>();
    const add = (
      title: string,
      all: LibraryGraphic[],
      seeAll?: { a: Aisle; s: string | null },
    ) => {
      const items = all.filter((g) => !seen.has(g.design)).slice(0, PREVIEW);
      if (!items.length) return;
      for (const g of items) seen.add(g.design);
      out.push({ title, items, total: all.length, seeAll });
    };
    const ofOccasion = (label: string) =>
      byPopularity(
        graphics.filter((g) => occasionOf(g.design) === label),
        popRank,
      );

    // Next holiday within ~6 weeks that we have designs for — pinned first.
    const next = holidaysFromToday().find(
      (h) => h.days <= 45 && (occasionCounts.get(h.label) ?? 0) > 0,
    );
    if (next) {
      add(`${next.label} is coming`, ofOccasion(next.label), aisleForLabel(next.label));
    }

    if (popular.length > 0) {
      add(
        "Popular right now",
        popular
          .map((p) => byDesign.get(p.design))
          .filter((g): g is LibraryGraphic => !!g),
      );
    }

    // The rest of the season — the pinned holiday already has its shelf.
    const month = new Date().getMonth() + 1;
    add(
      "This season",
      byPopularity(
        graphics.filter(
          (g) =>
            (tags[g.design]?.m ?? []).includes(month) &&
            occasionOf(g.design) !== next?.label,
        ),
        popRank,
      ),
    );

    // A shelf per top occasion chip, named exactly as the chip.
    for (const o of SHELF_OCCASIONS) {
      if (o === next?.label) continue; // already pinned up top
      const to = aisleForLabel(o);
      if (!GRID_AISLES.has(to.a)) {
        add(o, ofOccasion(o), to);
        continue;
      }
      add(
        aisleLabel(to.a),
        byPopularity(
          graphics.filter((g) => subMatches(g, to.a, ALL)),
          popRank,
        ),
        { a: to.a, s: null },
      );
    }
    return out;
  }, [graphics, tags, popular, popRank, byDesign, filtering, occasionCounts, subMatches]);

  // Aisle open, nothing picked yet → a Netflix-style shelf PER subcategory
  // (Halloween row, Thanksgiving row, …) so the whole aisle is browsable
  // before committing to a sub-chip. Same once-per-view rule as the
  // default shelves (vibes overlap: most punny designs are also funny).
  const aisleShelves = useMemo(() => {
    if (!graphics || !aisle || GRID_AISLES.has(aisle) || sub || q) {
      return [];
    }
    const seen = new Set<string>();
    return subChips
      .filter(([key]) => key !== ALL)
      .map(([key, label]) => {
        const all = byPopularity(
          graphics.filter((g) => subMatches(g, aisle, key)),
          popRank,
        );
        const items = all.filter((g) => !seen.has(g.design)).slice(0, PREVIEW);
        for (const g of items) seen.add(g.design);
        return { key, title: label, items, total: all.length };
      })
      .filter((s) => s.items.length > 0);
  }, [graphics, aisle, sub, q, subChips, subMatches, popRank]);

  // Human summary of the active pick for the grid header.
  const filterSummary = useMemo(() => {
    if (!aisle) return null;
    const chip = sub ? subChips.find(([k]) => k === sub) : null;
    if (GRID_AISLES.has(aisle)) {
      return chip ? `${aisleLabel(aisle)} · ${chip[1]}` : aisleLabel(aisle);
    }
    return chip ? chip[1] : null;
  }, [aisle, sub, subChips]);

  // Cards share the pick + press-and-hold handlers; the first few of every
  // grid load at once.
  const card = (g: LibraryGraphic, i: number, eagerAll = false) => (
    <Card
      key={g.design}
      g={g}
      onPick={pick}
      onPeek={setPeek}
      eager={eagerAll || i < EAGER}
    />
  );
  const makeOwnCard = onMakeOwn ? <MakeOwnCard text={q} onMakeOwn={onMakeOwn} /> : null;
  const designs = (n: number) => `${n} design${n === 1 ? "" : "s"}`;

  return (
    <div>
      {/* Search is there from the first frame (the designs load behind it),
          so a shopper who came here to search can start typing at once. */}
      <input
        type="search"
        className="library-search"
        placeholder="Search designs — try “dog”"
        aria-label="Search designs"
        enterKeyHint="search"
        autoFocus={autoFocusSearch}
        value={query}
        onChange={(e) => {
          const v = e.target.value;
          setQuery(v);
          // Typing searches the WHOLE library — drop any active
          // aisle/sub so results aren't secretly narrowed by a chip.
          if (v.trim()) {
            setAisle(null);
            setSub(null);
          }
        }}
      />
      <p className="note library-tip">Tip: press and hold a design to see it up close.</p>

      {failed && (
        <div className="notice warn">
          <p>
            The designs didn&apos;t load. Check your connection and try
            again — or make your own.
          </p>
          <button className="btn" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {!graphics && !failed && (
        <div className="library-grid" aria-busy="true" aria-label="Loading designs">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className="library-card library-skeleton" />
          ))}
        </div>
      )}

      {graphics && (
        <>
          {!restrict && (
            <div className="facet-row aisle-row">
              <div className="facet-scroll">
                {AISLES.filter((a) => !a.needsTags || hasTags).map((a) => (
                  <button
                    key={a.id}
                    className={"chip" + (aisle === a.id ? " active" : "")}
                    aria-pressed={aisle === a.id}
                    onClick={() => pickAisle(a.id)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {subChips.length > 0 && (
            <div className="facet-row sub-row">
              <div className="facet-scroll">
                {subChips.map(([key, label, n]) => {
                  const on =
                    aisle && GRID_AISLES.has(aisle) && key === ALL
                      ? sub === null
                      : sub === key;
                  return (
                    <button
                      key={key}
                      className={"chip sub" + (on ? " active" : "")}
                      aria-pressed={on}
                      onClick={() => pickSub(key)}
                    >
                      {label} · {n}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {!filtering && aisleShelves.length > 0 ? (
            <div className="shelves">
              {aisleShelves.map((s, si) => (
                <section key={s.key} className="shelf">
                  <div className="shelf-head">
                    <h3>{s.title}</h3>
                  </div>
                  <div className="library-grid">
                    {s.items.map((g, i) => card(g, i, si === 0))}
                    {s.total > PREVIEW && (
                      <button
                        className="library-card see-all"
                        onClick={() => pickSub(s.key)}
                      >
                        <span>See all {s.total} →</span>
                      </button>
                    )}
                  </div>
                </section>
              ))}
            </div>
          ) : !filtering ? (
            <div className="shelves">
              {[...hubShelves, ...shelves].map((s, si) => (
                <section key={`${si}-${s.title}`} className="shelf">
                  <div className="shelf-head">
                    <h3>{s.title}</h3>
                  </div>
                  <div className="library-grid">
                    {s.items.slice(0, PREVIEW).map((g, i) => card(g, i, si === 0))}
                    {s.total > PREVIEW &&
                      (() => {
                        const seeAllQuery = (s as { seeAllQuery?: string }).seeAllQuery;
                        if (seeAllQuery)
                          return (
                            <button
                              className="library-card see-all"
                              onClick={() => setQuery(seeAllQuery)}
                            >
                              <span>See all {s.total} →</span>
                            </button>
                          );
                        const to = (s as { seeAll?: { a: Aisle; s: string | null } }).seeAll;
                        if (to)
                          return (
                            <button
                              className="library-card see-all"
                              onClick={() => jumpTo(to)}
                            >
                              <span>See all {s.total} →</span>
                            </button>
                          );
                        return null;
                      })()}
                  </div>
                </section>
              ))}
              {graphics.length > 0 && (
                <p className="note">
                  Or search above — every one of our {designs(graphics.length)} is
                  in here.
                </p>
              )}
            </div>
          ) : search && search.exact.length === 0 ? (
            // Never a dead end: their own label (a name search is the
            // strongest sign they want one), then the best partial matches,
            // else best sellers.
            <>
              <div className="notice info library-nomatch">
                <p>No design matches “{clipQuery(q)}”.</p>
                {onMakeOwn && (
                  <button className="btn primary" onClick={() => onMakeOwn(q)}>
                    Put “{clipQuery(q)}” on your own label →
                  </button>
                )}
              </div>
              <p className="note">
                {search.close.length ? "Close matches" : "Our most popular designs"}
              </p>
              <div className="library-grid">
                {(search.close.length ? search.close : searchFallback).map((g, i) => card(g, i))}
              </div>
            </>
          ) : search ? (
            <>
              <p className="note">
                {designs(search.exact.length)}
                {filterSummary ? ` · ${filterSummary}` : ""}
              </p>
              <div className="library-grid">
                {search.exact.map((g, i) => card(g, i))}
                {search.exact.length < RELATED_BELOW && makeOwnCard}
              </div>
              {/* A near-miss ("dad birthday" = 1 design) gets the close
                  matches too, so a narrow search still has somewhere to go. */}
              {search.exact.length < FEW_RESULTS && search.close.length > 0 && (
                <>
                  <p className="note">More ideas close to “{q}”</p>
                  <div className="library-grid">
                    {search.close.map((g, i) => card(g, i))}
                  </div>
                </>
              )}
              {related.length > 0 && (
                <div className="shelves">
                  {related.map((s) => (
                    <section key={s.title} className="shelf">
                      <div className="shelf-head">
                        <h3>{s.title}</h3>
                      </div>
                      <div className="library-grid">
                        {s.items.map((g, i) => card(g, i))}
                        {s.total > s.items.length && (
                          <button
                            className="library-card see-all"
                            onClick={() => jumpTo(s.to)}
                          >
                            <span>See all {s.total} →</span>
                          </button>
                        )}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </>
          ) : aisleGrid.length === 0 ? (
            <div className="notice info library-nomatch">
              <p>Nothing here yet — try another category.</p>
              {onMakeOwn && (
                <button className="btn primary" onClick={() => onMakeOwn(null)}>
                  Make your own label →
                </button>
              )}
            </div>
          ) : (
            <>
              <p className="note">
                {designs(aisleGrid.length)}
                {filterSummary ? ` · ${filterSummary}` : ""}
              </p>
              <div className="library-grid">{aisleGrid.map((g, i) => card(g, i))}</div>
            </>
          )}
        </>
      )}

      <QuickLook
        art={peek ? (cdnThumb(peek.art ?? peek.thumb, 1400) ?? null) : null}
        name={peek?.title ?? ""}
        onUse={() => {
          const g = peek;
          setPeek(null);
          if (g) pick(g);
        }}
        onClose={() => setPeek(null)}
      />
    </div>
  );
}
