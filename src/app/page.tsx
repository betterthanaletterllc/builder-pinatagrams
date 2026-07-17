import { getCatalog, HUB_URL, priceUrl, type HubPrice } from "@/lib/hub";
import BuilderPreview from "./builder-preview";
import LandingOverlay from "./landing-overlay";

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
    // Landing overlay photos: the hub-managed shots (admin /pricing →
    // "Landing page", first three active), in order — one per pitch line.
    const landingImgs = (catalog.landing?.images ?? [])
      .filter((i) => i.url)
      .slice(0, 3);
    return (
      <main>
        {/* Full-screen scrollable pitch OVER the builder; "Build my Piñata"
            dismisses to the picker below. NO smash copy — the candy comes
            out and the piñata gets kept. */}
        <LandingOverlay logo={catalog.landing?.logo} images={landingImgs} />
        <h1 className="visually-hidden">
          Piñatagrams — personalized mini piñatas, delivered
        </h1>

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
            <span className="chip-num">5 ·</span> Add-ons
          </span>
          <span className="chip locked">
            <span className="chip-num">6 ·</span> Delivery
          </span>
          <span className="chip locked">
            <span className="chip-num">7 ·</span> Send to
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
