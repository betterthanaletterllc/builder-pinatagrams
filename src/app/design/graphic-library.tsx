"use client";

import { useEffect, useMemo, useState } from "react";
import type { GraphicChoice } from "@/lib/flow";
import {
  EXCLUDED_PREFIXES,
  FALLBACK_OCCASION,
  loadJson,
  occasionOf,
  RECIPIENTS,
  SHELF_OCCASIONS,
  VIBES,
  type LibraryGraphic,
  type PopularRanking,
  type TagIndex,
} from "@/lib/library-data";

/**
 * Gift-finding library. Default view = shelves (Popular right now, This
 * season, top occasions); any search/facet flips to a filtered grid. Facets
 * answer the three questions a gift-giver asks: who's it for, what's the
 * occasion, what's the vibe. Tags + popularity are optional data files —
 * without them the shelves quietly reduce to occasions only.
 */

type Manifest = { graphics: LibraryGraphic[] };
type PopularFile = { ranking: PopularRanking };
type TagFile = { tags: TagIndex };

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
  const [failed, setFailed] = useState(false);

  const [query, setQuery] = useState("");
  const [occasion, setOccasion] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<string | null>(null);
  const [vibe, setVibe] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      loadJson<Manifest>("/graphics.json"),
      loadJson<TagFile>("/library-index.json"),
      loadJson<PopularFile>("/popular.json"),
    ]).then(([manifest, tagFile, popularFile]) => {
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
    });
  }, []);

  const pick = (g: LibraryGraphic) =>
    onPick({
      type: "shopify",
      design: g.design,
      title: g.title,
      thumb: g.thumb,
      art: g.art,
    });

  const filtering =
    query.trim() !== "" || occasion !== null || recipient !== null || vibe !== null;

  const byDesign = useMemo(() => {
    const m = new Map<string, LibraryGraphic>();
    for (const g of graphics ?? []) m.set(g.design, g);
    return m;
  }, [graphics]);

  const shown = useMemo(() => {
    if (!graphics) return [];
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    return graphics.filter((g) => {
      const o = occasionOf(g.design);
      const t = tags[g.design];
      if (occasion && o !== occasion) return false;
      if (recipient && !(t?.r ?? []).includes(recipient)) return false;
      if (vibe && !(t?.v ?? []).includes(vibe)) return false;
      if (tokens.length === 0) return true;
      const hay = `${g.title} ${o} ${g.design} ${(t?.r ?? []).join(" ")} ${(t?.v ?? []).join(" ")}`.toLowerCase();
      return tokens.every((tok) => hay.includes(tok));
    });
  }, [graphics, tags, query, occasion, recipient, vibe]);

  const shelves = useMemo(() => {
    if (!graphics || filtering) return [];
    const out: { title: string; items: LibraryGraphic[]; seeAll?: string }[] = [];

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
      const items = graphics.filter((g) => occasionOf(g.design) === o);
      if (items.length)
        out.push({ title: o, items: items.slice(0, 12), seeAll: o });
    }
    return out;
  }, [graphics, tags, popular, byDesign, filtering]);

  const occasions = useMemo(() => {
    if (!graphics) return [];
    const counts = new Map<string, number>();
    for (const g of graphics) {
      const o = occasionOf(g.design);
      counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) =>
      a[0] === FALLBACK_OCCASION ? 1 :
      b[0] === FALLBACK_OCCASION ? -1 :
      b[1] - a[1],
    );
  }, [graphics]);

  const hasTags = Object.keys(tags).length > 0;

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

          {hasTags && (
            <div className="facet-row">
              <span className="facet-label">Who&apos;s it for?</span>
              <div className="facet-scroll">
                {RECIPIENTS.map(([key, label]) => (
                  <button
                    key={key}
                    className={"chip" + (recipient === key ? " active" : "")}
                    onClick={() => setRecipient(recipient === key ? null : key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="facet-row">
            <span className="facet-label">Occasion</span>
            <div className="facet-scroll">
              {occasions.map(([o, n]) => (
                <button
                  key={o}
                  className={"chip" + (occasion === o ? " active" : "")}
                  onClick={() => setOccasion(occasion === o ? null : o)}
                >
                  {o} ({n})
                </button>
              ))}
            </div>
          </div>

          {hasTags && (
            <div className="facet-row">
              <span className="facet-label">Vibe</span>
              <div className="facet-scroll">
                {VIBES.map(([key, label]) => (
                  <button
                    key={key}
                    className={"chip" + (vibe === key ? " active" : "")}
                    onClick={() => setVibe(vibe === key ? null : key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!filtering ? (
            <div className="shelves">
              {shelves.map((s) => (
                <section key={s.title} className="shelf">
                  <div className="shelf-head">
                    <h3>{s.title}</h3>
                    {s.seeAll && (
                      <button
                        className="btn mini"
                        onClick={() => setOccasion(s.seeAll!)}
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
              a different occasion, or design your own graphic.
            </div>
          ) : (
            <>
              <p className="note">
                {shown.length} graphic{shown.length === 1 ? "" : "s"}
                {occasion ? ` · ${occasion}` : ""}
                {recipient ? ` · for ${recipient}` : ""}
                {vibe ? ` · ${vibe}` : ""}
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
