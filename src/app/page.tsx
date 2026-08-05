import { headers } from "next/headers";
import Image from "next/image";
import {
  getCatalog,
  getReviews,
  HUB_URL,
  priceUrl,
  resolveBuilderPricing,
  type HubPrice,
} from "@/lib/hub";
import { normalizeHost, resolveVariantProfile } from "@/lib/variant";
import BuilderPreview from "./builder-preview";
import LandingOverlay from "./landing-overlay";
import VariantBoot from "./variant-boot";

// Always render against the live hub — no build-time snapshot yet, and the
// build must succeed even when the hub is unreachable (see catch below).
export const dynamic = "force-dynamic";

// The base retail price + ship rate, for the "from" price on every style
// card: Classic graphic included, cheapest carrier (USPS). Tiers/add-ons/
// FedEx ride on top in the flow. Null on any hiccup — the cards just omit it.
async function b2cPrice(): Promise<HubPrice | null> {
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
    return Number.isFinite(p.unitPriceCents) && p.unitPriceCents > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Star row (e.g. 4.8 → 96%-wide gold overlay on gray glyphs). Decorative —
 *  the number is always printed beside it, so screen readers skip the stars. */
function Stars({ rating }: { rating: number }) {
  const pct = Math.max(0, Math.min(5, rating)) * 20;
  return (
    <span className="stars" aria-hidden="true">
      <span className="stars-bg">★★★★★</span>
      <span className="stars-fill" style={{ width: `${pct}%` }}>
        ★★★★★
      </span>
    </span>
  );
}

// ~200-char preview of a review body, cut at a word break. Plain text in,
// plain text out — bodies are user-generated and only ever JSX-escaped.
// Cut on code points, not UTF-16 units, so an emoji at the boundary can't
// leave a lone surrogate rendering as U+FFFD.
function clipBody(s: string, max = 200): string {
  const points = [...s];
  if (points.length <= max) return s;
  const cut = points.slice(0, max).join("");
  return `${(cut.replace(/\s+\S*$/, "") || cut).trimEnd()}…`;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string }>;
}) {
  try {
    // The hostname picks the variant profile (hub /pricing → "Builder
    // variants"); ?variant= previews any profile OUTSIDE production only.
    const host = normalizeHost((await headers()).get("host"));
    const previewVariant =
      process.env.VERCEL_ENV !== "production"
        ? ((await searchParams).variant ?? null)
        : null;
    const [catalog, price, reviews] = await Promise.all([
      getCatalog({ host, previewVariant }),
      b2cPrice(),
      // Extra headroom so the strip still finds 4 five-star-or-verified
      // cards after filtering; null on any hiccup → review UI just absent.
      getReviews({ limit: 12 }),
    ]);
    const variant = resolveVariantProfile(catalog.variant);
    const pricing = resolveBuilderPricing(catalog.pricing);
    // Tiered: "from" = Classic graphic (included) + the cheapest carrier.
    // Flat: ONE all-in delivered price — the number IS the price, no "from".
    const priceCents = price
      ? variant.pricing === "tiered"
        ? price.unitPriceCents +
          (variant.carriers.includes("usps")
            ? Math.min(price.shipPerUnitCents, pricing.uspsShipPerUnitCents)
            : price.shipPerUnitCents)
        : price.unitDeliveredCents
      : null;
    // Landing overlay photos: the hub-managed shots (admin /pricing →
    // "Landing page", first three active), in order — one per pitch line.
    const landingImgs = (catalog.landing?.images ?? [])
      .filter((i) => i.url)
      .slice(0, 3);
    // Compact trust row for the overlay — aggregate + the scope label
    // (ratings are brand-pooled; the label travels with the number).
    const trust = reviews
      ? {
          rating: reviews.aggregate.rating,
          count: reviews.aggregate.count,
          label: reviews.scope.label,
        }
      : null;
    // The home strip shows the strongest social proof first: five-star or
    // verified, in the API's (newest-first) order.
    const reviewPicks = reviews
      ? reviews.reviews.filter((r) => r.rating === 5 || r.verified).slice(0, 4)
      : [];
    return (
      <main>
        {/* Remembers a non-production ?variant= preview for client surfaces
            (cart) and flags unresolved hosts loudly. Renders nothing. */}
        <VariantBoot
          variantName={variant.name}
          resolvedVia={variant.resolvedVia}
          preview={!!previewVariant}
        />
        {/* Full-screen scrollable pitch OVER the builder; "Build my Piñata"
            dismisses to the picker below. NO smash copy — the candy comes
            out and the piñata gets kept. Storefronts whose own landing page
            already pitched (campaign funnels) skip straight to the picker. */}
        {variant.showLanding && (
          <LandingOverlay
            logo={catalog.landing?.logo}
            images={landingImgs}
            lines={variant.landingLines}
            trust={trust}
          />
        )}
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
        <BuilderPreview
          bodyStyles={catalog.bodyStyles}
          priceCents={priceCents}
          from={variant.pricing === "tiered"}
          variantParam={previewVariant}
        />

        {/* Social proof from the hub's public reviews API. Server-rendered;
            a failed fetch (reviews null) simply omits the whole section.
            Review text is user-generated — JSX-escaped text only. */}
        {reviews && reviewPicks.length > 0 && (
          <section className="reviews-strip" aria-label="Customer reviews">
            <h2 className="reviews-h2">What senders say</h2>
            <p className="reviews-agg">
              <Stars rating={reviews.aggregate.rating} />
              <span className="reviews-agg-num">
                {reviews.aggregate.rating.toFixed(1)} ·{" "}
                {reviews.aggregate.count.toLocaleString("en-US")} reviews
              </span>
              {/* brand-pooled rating — the scope label stays with the number */}
              <span className="reviews-agg-scope">{reviews.scope.label}</span>
            </p>
            <div className="reviews-grid">
              {reviewPicks.map((r) => {
                const photo = (r.media ?? []).find((m) => m.kind === "photo" && m.url);
                return (
                  <article className="review-card" key={r.id}>
                    <div className="review-top">
                      <Stars rating={r.rating} />
                      {r.verified && (
                        <span className="review-badge">Verified buyer</span>
                      )}
                    </div>
                    <div className="review-main">
                      {photo && (
                        <Image
                          className="review-photo"
                          src={photo.url}
                          alt={`Customer photo from ${r.name}`}
                          width={112}
                          height={112}
                          sizes="56px"
                        />
                      )}
                      <div className="review-text">
                        {r.title && (
                          <strong className="review-title">{r.title}</strong>
                        )}
                        <p className="review-body">{clipBody(r.body)}</p>
                      </div>
                    </div>
                    <footer className="review-foot">
                      <span className="review-name">{r.name}</span>
                      {/* FTC disclosure — must be visible on incentivized
                          reviews wherever they render */}
                      {r.incentivized && (
                        <span className="review-badge incentivized">
                          Received a reward for this review
                        </span>
                      )}
                    </footer>
                  </article>
                );
              })}
            </div>
          </section>
        )}
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
