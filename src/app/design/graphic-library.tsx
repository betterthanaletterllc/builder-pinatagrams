"use client";

import { useEffect, useState } from "react";
import type { GraphicChoice } from "@/lib/flow";

/**
 * The ready-made front-graphic library. Fed by /graphics.json — a snapshot of
 * the live Shopify catalog (design products, deduped by design code). Becomes
 * a hub `/api/public/graphics` endpoint once the admin.btal app gets the
 * read_products scope.
 */

type LibraryGraphic = {
  design: string;
  title: string;
  thumb: string | null;
  art: string | null;
};

export default function GraphicLibrary({
  onPick,
  onBack,
}: {
  onPick: (g: GraphicChoice) => void;
  onBack: () => void;
}) {
  const [graphics, setGraphics] = useState<LibraryGraphic[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/graphics.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => setGraphics(data.graphics ?? []))
      .catch(() => setFailed(true));
  }, []);

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
        <div className="library-grid">
          {graphics.map((g) => (
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
              {/* show the actual front graphic (the print art), not the
                  boxed product photo — the customer is choosing a graphic */}
              {g.art || g.thumb ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={g.art ?? g.thumb ?? ""} alt={g.title} loading="lazy" />
              ) : null}
              <span>{g.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
