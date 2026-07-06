"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphicChoice } from "@/lib/flow";
import {
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
  SHELF_OCCASIONS,
  VIBES,
  type LibraryGraphic,
  type PopularRanking,
  type TagIndex,
} from "@/lib/library-data";

/**
 * Gift-finding library. Default view = shelves (next holiday, Popular right
 * now, This season, top occasions); search or an aisle pick flips to a
 * filtered grid.
 *
 * Browsing = two-level AISLES: one row of broad categories (Birthdays first —
 * the #1 use case gets one tap), tapping an aisle opens its sub-chips.
 * Holidays sort by the calendar starting from today, so the next holiday is
 * always the first chip. Chips show counts; empty ones don't render.
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
  | "occasions"
  | "holidays"
  | "family"
  | "friends"
  | "pets"
  | "vibe";

// "All …" sub-chip sentinel (the union of the aisle's sub-filters).
const ALL = "__all__";

const AISLES: { id: Aisle; label: string; needsTags?: boolean }[] = [
  { id: "birthdays", label: "🎂 Birthdays" },
  { id: "occasions", label: "🎉 Occasions" },
  { id: "holidays", label: "🎄 Holidays" },
  { id: "family", label: "👪 Family", needsTags: true },
  { id: "friends", label: "🧑‍🤝‍🧑 Friends & work", needsTags: true },
  { id: "pets", label: "🐾 Pets", needsTags: true },
  { id: "vibe", label: "✨ Vibe", needsTags: true },
];

// Shopify's CDN resizes on the fly — a 360px thumb is ~10x lighter than the
// print-resolution original, which is what makes shelf scrolling feel instant.
function thumbUrl(u: string, width = 360): string {
  if (!u.includes("cdn.shopify.com")) return u;
  return u + (u.includes("?") ? "&" : "?") + `width=${width}`;
}

function Card({
  g,
  onPick,
  eager = false,
}: {
  g: LibraryGraphic;
  onPick: (g: LibraryGraphic) => void;
  eager?: boolean;
}) {
  // Art only — no product name. The graphic sells itself; the title stays
  // available to screen readers and as a hover tooltip.
  const src = g.art ?? g.thumb;
  return (
    <button
      className="library-card"
      onClick={() => onPick(g)}
      title={g.title}
      aria-label={g.title}
    >
      {src ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={thumbUrl(src)}
          alt={g.title}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
        />
      ) : null}
    </button>
  );
}

export default function GraphicLibrary({
  onPick,
  onBack,
}: {
  onPick: (g: GraphicChoice) => void;
  onBack: () => void;
}) {
  const [graphics, setGraphics] = useState<LibraryGraphic[] | null>(null);
  const [tags, setTags] = useState<TagIndex>({});
  const [popular, setPopular] = useState<PopularRanking>([]);
  const [bdayExtra, setBdayExtra] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState(false);

  // Re-entering (e.g. "Change graphic") resumes EXACTLY where the shopper
  // left off: same aisle, same sub-pick, same search, same scroll.
  const restored = useRef(loadLibraryState());
  const isAisle = (v: string | null): v is Aisle =>
    AISLES.some((a) => a.id === v);
  const [query, setQuery] = useState(restored.current?.q ?? "");
  const [aisle, setAisle] = useState<Aisle | null>(
    isAisle(restored.current?.a ?? null) ? (restored.current!.a as Aisle) : null,
  );
  const [sub, setSub] = useState<string | null>(restored.current?.s ?? null);

  useEffect(() => {
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
      setGraphics(
        manifest.graphics.filter(
          (g) => !EXCLUDED_PREFIXES.has(g.design.replace(/[0-9]+$/, "")),
        ),
      );
      if (tagFile?.tags) setTags(tagFile.tags);
      if (popularFile?.ranking) setPopular(popularFile.ranking);
      if (collections?.birthday) setBdayExtra(new Set(collections.birthday));
      // Put the shopper back at their scroll position once the (uniform-
      // height) cards have reserved their layout space.
      const y = restored.current?.y ?? 0;
      if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
    });
  }, []);

  // Remember the view on every change; pick() below also captures scroll.
  useEffect(() => {
    saveLibraryState({ q: query, a: aisle, s: sub, y: window.scrollY });
  }, [query, aisle, sub]);

  const pick = (g: LibraryGraphic) => {
    saveLibraryState({ q: query, a: aisle, s: sub, y: window.scrollY });
    onPick({
      type: "shopify",
      design: g.design,
      title: g.title,
      thumb: g.thumb,
      art: g.art,
    });
  };

  const hasTags = Object.keys(tags).length > 0;

  const pickAisle = (id: Aisle) => {
    if (aisle === id) {
      setAisle(null);
      setSub(null);
    } else {
      setAisle(id);
      setSub(null);
    }
  };

  // Shelf "See all →" jumps into the right aisle for its occasion.
  const jumpToOccasion = (label: string) => {
    if (label === "Birthday") {
      setAisle("birthdays");
      setSub(null);
    } else if (HOLIDAY_LABELS.has(label)) {
      setAisle("holidays");
      setSub(label);
    } else {
      setAisle("occasions");
      setSub(label);
    }
  };

  const recipientsOf = (g: LibraryGraphic) => tags[g.design]?.r ?? [];
  const vibesOf = (g: LibraryGraphic) => tags[g.design]?.v ?? [];

  // One matcher shared by the grid filter AND the per-subcategory shelves.
  const subMatches = useMemo(() => {
    return (g: LibraryGraphic, a: Aisle, key: string): boolean => {
      const o = occasionOf(g.design);
      const r = recipientsOf(g);
      switch (a) {
        case "birthdays":
          return o === "Birthday" || bdayExtra.has(g.design);
        case "occasions":
          return o === key;
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
      if (aisle === "birthdays") return subMatches(g, aisle, ALL);
      if (!sub) return true; // aisle open, nothing picked yet → shelves below
      return subMatches(g, aisle, sub);
    };
  }, [aisle, sub, subMatches]);

  const filtering =
    query.trim() !== "" || aisle === "birthdays" || (aisle !== null && sub !== null);

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
    if (!aisle || aisle === "birthdays") return [];
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
    switch (aisle) {
      case "occasions":
        return [...occasionCounts.entries()]
          .filter(
            ([o]) => o !== "Birthday" && !HOLIDAY_LABELS.has(o),
          )
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
  }, [aisle, graphics, occasionCounts, recipientCounts, vibeCounts]);

  const shown = useMemo(() => {
    if (!graphics) return [];
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    return graphics.filter((g) => {
      if (!inAisle(g)) return false;
      if (tokens.length === 0) return true;
      const o = occasionOf(g.design);
      const t = tags[g.design];
      const hay = `${g.title} ${o} ${g.design} ${(t?.r ?? []).join(" ")} ${(t?.v ?? []).join(" ")}`.toLowerCase();
      return tokens.every((tok) => hay.includes(tok));
    });
  }, [graphics, tags, query, inAisle]);

  const shelves = useMemo(() => {
    if (!graphics || filtering) return [];
    const out: {
      title: string;
      items: LibraryGraphic[];
      seeAll?: string;
    }[] = [];

    // Next holiday within ~6 weeks that we have designs for — pinned first.
    const next = holidaysFromToday().find(
      (h) => h.days <= 45 && (occasionCounts.get(h.label) ?? 0) > 0,
    );
    if (next) {
      out.push({
        title: `${next.label} is coming`,
        items: graphics
          .filter((g) => occasionOf(g.design) === next.label)
          .slice(0, 12),
        seeAll: next.label,
      });
    }

    if (popular.length > 0) {
      const items = popular
        .map((p) => byDesign.get(p.design))
        .filter((g): g is LibraryGraphic => !!g)
        .slice(0, 12);
      if (items.length) out.push({ title: "Popular right now", items });
    }

    const month = new Date().getMonth() + 1;
    const seasonal = graphics.filter((g) =>
      (tags[g.design]?.m ?? []).includes(month),
    );
    if (seasonal.length)
      out.push({ title: "This season", items: seasonal.slice(0, 12) });

    for (const o of SHELF_OCCASIONS) {
      if (o === next?.label) continue; // already pinned up top
      const items = graphics.filter((g) => occasionOf(g.design) === o);
      if (items.length)
        out.push({ title: o, items: items.slice(0, 12), seeAll: o });
    }
    return out;
  }, [graphics, tags, popular, byDesign, filtering, occasionCounts]);

  // Aisle open, nothing picked yet → a Netflix-style shelf PER subcategory
  // (Halloween row, Thanksgiving row, …) so the whole aisle is browsable
  // before committing to a sub-chip.
  const aisleShelves = useMemo(() => {
    if (!graphics || !aisle || aisle === "birthdays" || sub || query.trim()) {
      return [];
    }
    return subChips
      .filter(([key]) => key !== ALL)
      .map(([key, label]) => ({
        key,
        title: label,
        items: graphics.filter((g) => subMatches(g, aisle, key)).slice(0, 12),
      }))
      .filter((s) => s.items.length > 0);
  }, [graphics, aisle, sub, query, subChips, subMatches]);

  // Human summary of the active pick for the grid header.
  const filterSummary = useMemo(() => {
    if (aisle === "birthdays") return "Birthdays";
    if (!aisle || !sub) return null;
    const chip = subChips.find(([k]) => k === sub);
    return chip ? chip[1] : null;
  }, [aisle, sub, subChips]);

  return (
    <div>
      <p className="note">
        <button className="btn mini" onClick={onBack}>
          ← Back
        </button>
      </p>

      {failed && (
        <div className="notice warn">
          The graphic library didn&apos;t load — try again in a moment, or
          design your own.
        </div>
      )}
      {!graphics && !failed && <p className="note">Loading graphics…</p>}

      {graphics && (
        <>
          <input
            type="search"
            className="library-search"
            placeholder="Search — birthday, thank you, dog, Halloween…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="facet-row aisle-row">
            <div className="facet-scroll">
              {AISLES.filter((a) => !a.needsTags || hasTags).map((a) => (
                <button
                  key={a.id}
                  className={"chip" + (aisle === a.id ? " active" : "")}
                  onClick={() => pickAisle(a.id)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          {subChips.length > 0 && (
            <div className="facet-row sub-row">
              <div className="facet-scroll">
                {subChips.map(([key, label, n]) => (
                  <button
                    key={key}
                    className={"chip sub" + (sub === key ? " active" : "")}
                    onClick={() => setSub(sub === key ? null : key)}
                  >
                    {label} · {n}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!filtering && aisleShelves.length > 0 ? (
            <div className="shelves">
              {aisleShelves.map((s) => (
                <section key={s.key} className="shelf">
                  <div className="shelf-head">
                    <h3>{s.title}</h3>
                    <button className="btn mini" onClick={() => setSub(s.key)}>
                      See all →
                    </button>
                  </div>
                  <div className="shelf-row">
                    {s.items.map((g) => (
                      <Card key={g.design} g={g} onPick={pick} eager />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : !filtering ? (
            <div className="shelves">
              {shelves.map((s) => (
                <section key={s.title} className="shelf">
                  <div className="shelf-head">
                    <h3>{s.title}</h3>
                    {s.seeAll && (
                      <button
                        className="btn mini"
                        onClick={() => jumpToOccasion(s.seeAll!)}
                      >
                        See all →
                      </button>
                    )}
                  </div>
                  <div className="shelf-row">
                    {s.items.map((g) => (
                      <Card key={g.design} g={g} onPick={pick} eager />
                    ))}
                  </div>
                </section>
              ))}
              <p className="note">
                Or search above — every one of our {graphics.length} graphics
                is in here.
              </p>
            </div>
          ) : shown.length === 0 ? (
            <div className="notice info">
              Nothing matches{query ? ` “${query}”` : ""} — try another word,
              a different aisle, or design your own graphic.
            </div>
          ) : (
            <>
              <p className="note">
                {shown.length} graphic{shown.length === 1 ? "" : "s"}
                {filterSummary ? ` · ${filterSummary}` : ""}
              </p>
              <div className="library-grid">
                {shown.map((g) => (
                  <Card key={g.design} g={g} onPick={pick} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
