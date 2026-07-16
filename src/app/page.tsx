import { formatCents, getCatalog, HUB_URL, priceUrl, type HubPrice } from "@/lib/hub";
import BuilderPreview from "./builder-preview";

// Always render against the live hub — no build-time snapshot yet, and the
// build must succeed even when the hub is unreachable (see catch below).
export const dynamic = "force-dynamic";

// The DELIVERED price (unit + shipping) shown in the hero and on every style
// card — one honest number that never grows between landing and invoice.
// Null on any hiccup — the hero/cards just omit it.
async function b2cDeliveredCents(): Promise<number | null> {
  try {
    const res = await fetch(
      priceUrl({
        qty: 1,
        fill: "filled",
        bodyType: "standard",
        graphicType: "custom",
        mode: "individual",
        carrier: "standard",
      }),
      { next: { revalidate: 300 } },
    );
    if (!res.ok) return null;
    const p: HubPrice = await res.json();
    return Number.isFinite(p.unitDeliveredCents) && p.unitDeliveredCents > 0
      ? p.unitDeliveredCents
      : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  try {
    const [catalog, priceCents] = await Promise.all([
      getCatalog(),
      b2cDeliveredCents(),
    ]);
    // Hero visual: the standard piñata's studio shot (hub-controlled, same
    // image the link previews use); any style's image as a fallback.
    const heroImg =
      catalog.bodyStyles.find((s) => s.id === "standard")?.imageUrl ??
      catalog.bodyStyles.find((s) => s.imageUrl)?.imageUrl ??
      null;
    return (
      <main>
        {/* Compact hero: sell first, the picker right below IS the CTA.
            NO smash copy — the candy comes out and the piñata gets kept. */}
        <section className="hero">
          <div className="hero-copy">
            <h1>The sweetest gift!</h1>
            <p className="hero-sub">
              Design a custom piñata — we stuff it with candy and fly it
              right to their door. They pull out the treats and keep the
              cute piñata.
            </p>
            <p className="hero-trust">
              {priceCents != null && (
                <span className="hero-price">
                  From {formatCents(priceCents)} — shipping included
                </span>
              )}
              {/* Real Loox numbers (store-wide, verified 2026-07-16):
                  2,044 reviews, 4.82 weighted average. Count rounded DOWN
                  so the claim stays true as reviews grow. */}
              <span className="hero-stars">★ 4.8 · 2,000+ reviews</span>
              <span>Arrives on the day you pick</span>
              <span>300,000+ piñatas delivered</span>
            </p>
          </div>
          {heroImg && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              className="hero-img"
              src={heroImg}
              alt="A Piñatagram piñata"
            />
          )}
        </section>

        {/* The numbered step row — a first-time visitor sees the whole
            journey at a glance ("6 quick steps"). Body is active; the rest
            unlock in the flow. */}
        <nav className="chips home-chips" aria-label="How it works">
          <span className="chip active">
            <span className="chip-num">1 ·</span> Body
          </span>
          <span className="chip locked">
            <span className="chip-num">2 ·</span> Graphic
          </span>
          <span className="chip locked">
            <span className="chip-num">3 ·</span> Message
          </span>
          <span className="chip locked">
            <span className="chip-num">4 ·</span> Filling
          </span>
          <span className="chip locked">
            <span className="chip-num">5 ·</span> Delivery
          </span>
          <span className="chip locked">
            <span className="chip-num">6 ·</span> Send to
          </span>
        </nav>
        <h2 className="start-h2">Start here — pick a body style</h2>
        <BuilderPreview bodyStyles={catalog.bodyStyles} priceCents={priceCents} />
      </main>
    );
  } catch {
    const isProd = process.env.VERCEL_ENV === "production";
    return (
      <main>
        <div className="error-box">
          <strong>Our builder is taking a quick breather.</strong>
          {isProd ? (
            <p className="note">
              We couldn&apos;t load the piñata catalog just now — please refresh
              in a moment. If it keeps happening,{" "}
              <a href="mailto:nathan@pinatagrams.com">let us know</a> and
              we&apos;ll sort it out.
            </p>
          ) : (
            <p className="note">
              Couldn&apos;t reach the hub at {HUB_URL}. If you&apos;re developing
              locally, start the admin app first:{" "}
              <code>cd ../admin && npm run dev</code>.
            </p>
          )}
        </div>
      </main>
    );
  }
}
