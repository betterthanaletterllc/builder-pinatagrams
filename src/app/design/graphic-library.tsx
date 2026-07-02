"use client";

import { useEffect, useMemo, useState } from "react";
import type { GraphicChoice } from "@/lib/flow";

/**
 * The ready-made front-graphic library, organized for GIFT-FINDING: a live
 * search box plus occasion chips derived from each design code's prefix
 * (HBD01 → Birthday, SYMP12 → Sympathy…). Fed by /graphics.json — a snapshot
 * of the live Shopify catalog; becomes a hub `/api/public/graphics` endpoint
 * once the admin.btal app gets the read_products scope.
 */

type LibraryGraphic = {
  design: string;
  title: string;
  thumb: string | null;
  art: string | null;
};

// Client-specific one-off designs that shouldn't appear in a public library.
const EXCLUDED_PREFIXES = new Set(["BSG", "BRYNNEIL", "RETENTION"]);

// Design-code prefix → customer-facing occasion. Several prefixes can share
// an occasion (the School group). Unknown prefixes land in "More fun".
const OCCASIONS: Record<string, string> = {
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
};

const FALLBACK_OCCASION = "More fun";

function occasionOf(design: string): string {
  const prefix = design.replace(/[0-9]+$/, "");
  return OCCASIONS[prefix] ?? FALLBACK_OCCASION;
}

export default function GraphicLibrary({
  onPick,
  onBack,
}: {
  onPick: (g: GraphicChoice) => void;
  onBack: () => void;
}) {
  const [graphics, setGraphics] = useState<LibraryGraphic[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [occasion, setOccasion] = useState<string | null>(null);

  useEffect(() => {
    fetch("/graphics.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) =>
        setGraphics(
          (data.graphics ?? []).filter(
            (g: LibraryGraphic) =>
              !EXCLUDED_PREFIXES.has(g.design.replace(/[0-9]+$/, "")),
          ),
        ),
      )
      .catch(() => setFailed(true));
  }, []);

  // Occasion chips, biggest categories first ("More fun" always last).
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

  const shown = useMemo(() => {
    if (!graphics) return [];
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    return graphics.filter((g) => {
      const o = occasionOf(g.design);
      if (occasion && o !== occasion) return false;
      if (tokens.length === 0) return true;
      const hay = `${g.title} ${o} ${g.design}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [graphics, query, occasion]);

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
            autoFocus
          />

          <div className="chips occasion-chips">
            <button
              className={"chip" + (occasion === null ? " active" : "")}
              onClick={() => setOccasion(null)}
            >
              All ({graphics.length})
            </button>
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

          {shown.length === 0 ? (
            <div className="notice info">
              Nothing matches{query ? ` “${query}”` : ""} — try another word,
              a different occasion, or design your own graphic.
            </div>
          ) : (
            <>
              <p className="note">
                {shown.length} graphic{shown.length === 1 ? "" : "s"}
                {occasion ? ` · ${occasion}` : ""}
              </p>
              <div className="library-grid">
                {shown.map((g) => (
                  <button
                    key={g.design}
                    className="library-card"
                    onClick={() =>
                      onPick({
                        type: "shopify",
                        design: g.design,
                        title: g.title,
                        thumb: g.thumb,
                        art: g.art,
                      })
                    }
                  >
                    {/* the actual front graphic (print art), not the boxed
                        product photo — the customer is choosing a graphic */}
                    {g.art || g.thumb ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={g.art ?? g.thumb ?? ""}
                        alt={g.title}
                        loading="lazy"
                      />
                    ) : null}
                    <span>{g.title}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
