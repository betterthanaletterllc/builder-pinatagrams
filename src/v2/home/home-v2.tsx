import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatYmd, resolveDeliveryConfig } from "@/lib/delivery";
import {
  formatCents,
  getCatalog,
  getReviews,
  resolveBuilderPricing,
  resolveHubGraphics,
  type HubReview,
} from "@/lib/hub";
import { cdnThumb } from "@/lib/library-data";
import { resolveVariantProfile } from "@/lib/variant";
import VariantBoot from "@/app/variant-boot";
import HubDown from "../chrome/hub-down";
import PendingBanner from "../chrome/pending-banner";
import { bestSellers, libraryCount, occasionStrips } from "../lib/catalog-server";
import { cutoffTonight, soonest } from "../lib/dates";
import { b2cPrice, requestContext, trustFrom } from "../lib/server";
import { clipText, PINATA_HEIGHT_IN, scopeText } from "../lib/text";
import { ButtonLink, ChipLink } from "../ui/controls";
import { Check, ChevronRight, Star, Tag, Truck, Users } from "../ui/icons";
import { CORPORATE_URL } from "@/lib/links";
import Stars from "../ui/stars";
import s from "./home.module.css";

/**
 * v2 home (builder2): promise first — soonest arrival, the delivered price
 * and the rating sit above the headline, before any effort; an inline hero
 * replaces the v1 landing overlay. Everything links INTO the four-step flow
 * with a preset (occasion / design / body), resolved there server-side.
 * Same hub data as v1's home: catalog, price, reviews.
 */
export default async function HomeV2({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const variantParam = Array.isArray(searchParams.variant)
    ? searchParams.variant[0]
    : searchParams.variant;
  const { host, previewVariant } = await requestContext(variantParam);

  let catalog;
  try {
    catalog = await getCatalog({ host, previewVariant });
  } catch {
    return <HubDown />;
  }
  const [price, reviews] = await Promise.all([
    b2cPrice(),
    // Extra headroom so the strip still finds 4 five-star-or-verified cards
    // after filtering; null on any hiccup → the review UI is simply absent.
    getReviews({ limit: 12 }),
  ]);

  const variant = resolveVariantProfile(catalog.variant);
  // A storefront without a landing (a client store whose own site already
  // made the pitch, e.g. froggle) opens straight on the builder — never on
  // the generic Piñatagrams home. The query (UTMs, a discount) rides along.
  if (!variant.showLanding) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      for (const one of [v].flat()) if (one != null) q.append(k, one);
    }
    redirect(q.size ? `/design?${q}` : "/design");
  }
  const pricing = resolveBuilderPricing(catalog.pricing);
  const deliveryCfg = resolveDeliveryConfig(catalog.delivery);
  const tiered = variant.pricing === "tiered";
  // page.tsx's rule, verbatim: tiered = "From" the Classic (included) +
  // the cheapest carrier; flat = the ONE all-in delivered price.
  const priceCents = price
    ? tiered
      ? price.unitPriceCents +
        (variant.carriers.includes("usps")
          ? Math.min(price.shipPerUnitCents, pricing.uspsShipPerUnitCents)
          : price.shipPerUnitCents)
      : price.unitDeliveredCents
    : null;
  const priceText =
    priceCents !== null ? `${tiered ? "From " : ""}${formatCents(priceCents)} delivered` : null;

  // The headline promise stays FedEx (the guaranteed day) even where USPS is
  // offered; "order by midnight" only when tonight really is the cutoff.
  const arrive = formatYmd(soonest(deliveryCfg, "fedex"));
  const promise = cutoffTonight(deliveryCfg, "fedex")
    ? `Order by midnight CT — arrives ${arrive}`
    : `Arrives as soon as ${arrive}`;
  const trust = trustFrom(reviews);

  const styles = catalog.bodyStyles.filter((b) => b.inStock);
  const hero = (catalog.landing?.images ?? []).find((i) => i.url);
  const heroFallback = styles.find((b) => b.boxImageUrl);

  // Best sellers this storefront actually sells, in sales order; occasion
  // chips only where the storefront has designs for them.
  const best = bestSellers(variant, 8);
  const designCount = libraryCount(variant, resolveHubGraphics(catalog.hubGraphics));
  const occasions = occasionStrips(variant);
  const reviewPicks: HubReview[] = reviews
    ? reviews.reviews.filter((r) => r.rating === 5 || r.verified).slice(0, 4)
    : [];
  const pitch =
    variant.landingLines?.[0] ??
    `A ${PINATA_HEIGHT_IN}-inch piñata packed with goodies, your design on the box and your message on the inside flap delivered straight to their door.`;

  return (
    <main className={s.home}>
      {/* Remembers a non-production ?variant= preview for client surfaces
          and flags unresolved hosts loudly. Renders nothing. */}
      <VariantBoot
        variantName={variant.name}
        resolvedVia={variant.resolvedVia}
        preview={!!previewVariant}
      />
      <PendingBanner />

      <section className={s.hero} aria-labelledby="home-title">
        <div className={s.heroCopy}>
          <ul className={s.promise} aria-label="Delivery, price and rating">
            <li>
              <Truck size={18} />
              <span>{promise}</span>
            </li>
            {priceText && (
              <li>
                <Tag size={16} />
                <strong>{priceText}</strong>
              </li>
            )}
            {trust && (
              <li>
                <Star size={16} className={s.star} />
                <span>
                  {trust.rating.toFixed(1)} {scopeText(trust.label)}
                </span>
              </li>
            )}
          </ul>
          <h1 id="home-title" className={s.title}>
            Send the party!
          </h1>
          <p className={s.pitch}>{pitch}</p>
          <div className={s.ctaRow}>
            <ButtonLink href="/design" size="lg">
              Send a Piñatagram
            </ButtonLink>
          </div>
          <ul className={s.assurances}>
            <li>
              <Check size={16} /> Made to order, just for them
            </li>
            <li>
              <Check size={16} /> Choose your delivery date!
            </li>
          </ul>
        </div>
        <div className={s.heroMedia}>
          {hero ? (
            <Image
              src={hero.url}
              alt={hero.label || "A Piñatagram in its box"}
              width={1080}
              height={1080}
              sizes="(min-width: 1024px) 520px, 92vw"
              priority
              className={s.heroImg}
            />
          ) : heroFallback?.boxImageUrl ? (
            <Image
              src={heroFallback.boxImageUrl}
              alt={`A ${heroFallback.name} Piñatagram in its box`}
              width={1080}
              height={1080}
              sizes="(min-width: 1024px) 520px, 92vw"
              priority
              className={s.heroImg}
            />
          ) : null}
        </div>
      </section>

      {occasions.length > 0 && (
        <section className={s.section} aria-labelledby="home-occasions">
          <h2 id="home-occasions" className={s.h2}>
            What are you celebrating?
          </h2>
          <ul className={s.chips}>
            {occasions.map((o) => (
              <li key={o.id}>
                <ChipLink href={`/design?occasion=${o.id}`}>{o.label}</ChipLink>
              </li>
            ))}
          </ul>
        </section>
      )}

      {best.length > 0 && (
        <section className={s.section} aria-labelledby="home-best">
          <div className={s.sectionHead}>
            <h2 id="home-best" className={s.h2}>
              Best sellers
            </h2>
            <Link href="/design" className={s.more}>
              See all {designCount.toLocaleString("en-US")} designs
              <ChevronRight size={18} />
            </Link>
          </div>
          <ul className={s.designRow}>
            {best.map((g, i) => (
              <li key={g.design}>
                <Link href={`/design?design=${g.design}`} className={s.designTile}>
                  {/* Shopify CDN art, resized by the CDN itself (next/image
                      isn't configured for cdn.shopify.com). 2.05:1 label. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={cdnThumb(g.art ?? g.thumb, 480) ?? ""}
                    alt={g.title}
                    width={480}
                    height={234}
                    loading={i < 2 ? "eager" : "lazy"}
                    decoding="async"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {styles.length > 0 && (
        <section className={s.section} aria-labelledby="home-bodies">
          <div className={s.sectionHead}>
            <h2 id="home-bodies" className={s.h2}>
              Choose your piñata
            </h2>
            {priceText && <p className={s.sectionNote}>{priceText}</p>}
          </div>
          <ul className={s.bodyGrid}>
            {styles.map((b) => (
              <li key={b.id}>
                <Link href={`/design?style=${b.id}`} className={s.bodyCard}>
                  <span className={s.bodyArt}>
                    <Image
                      src={b.cutoutUrl ?? `/pinatas/${b.id}.png`}
                      alt=""
                      width={400}
                      height={400}
                      sizes="(min-width: 1024px) 140px, 30vw"
                    />
                  </span>
                  <span className={s.bodyName}>{b.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {reviews && reviewPicks.length > 0 && (
        <section className={s.section} aria-labelledby="home-reviews">
          <div className={s.sectionHead}>
            <h2 id="home-reviews" className={s.h2}>
              What senders say
            </h2>
            <p className={s.agg}>
              <Stars rating={reviews.aggregate.rating} />
              <span>
                <strong>{reviews.aggregate.rating.toFixed(1)}</strong> ·{" "}
                {reviews.aggregate.count.toLocaleString("en-US")} reviews
              </span>
              {/* brand-pooled rating — the scope label stays with the number */}
              <span className={s.scope}>{reviews.scope.label}</span>
            </p>
          </div>
          <ul className={s.reviews}>
            {reviewPicks.map((r) => {
              const photo = (r.media ?? []).find((m) => m.kind === "photo" && m.url);
              return (
                <li key={r.id} className={s.review}>
                  <div className={s.reviewTop}>
                    <Stars rating={r.rating} size={15} />
                    <span className={s.srOnly}>{r.rating} out of 5 stars</span>
                    {r.verified && <span className={s.reviewBadge}>Verified buyer</span>}
                  </div>
                  <div className={s.reviewMain}>
                    {photo && (
                      <Image
                        className={s.reviewPhoto}
                        src={photo.url}
                        alt={`Customer photo from ${r.name}`}
                        width={112}
                        height={112}
                        sizes="56px"
                      />
                    )}
                    <div>
                      {r.title && <p className={s.reviewTitle}>{r.title}</p>}
                      {/* user-generated: JSX-escaped text only */}
                      <p className={s.reviewBody}>{clipText(r.body)}</p>
                    </div>
                  </div>
                  <p className={s.reviewFoot}>
                    <span>{r.name}</span>
                    {/* FTC disclosure — visible wherever an incentivized
                        review renders */}
                    {r.incentivized && (
                      <span className={s.rewardBadge}>Received a reward for this review</span>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
          <p>
            <Link className={s.more} href="/reviews">
              See all {reviews.aggregate.count.toLocaleString("en-US")} reviews
              <ChevronRight size={18} />
            </Link>
          </p>
        </section>
      )}

      <section className={`${s.section} ${s.corporate}`} aria-labelledby="home-corp">
        <Users size={28} />
        <div>
          <h2 id="home-corp" className={s.h2}>
            Sending to a team or lots of people?
          </h2>
          <p className={s.corpText}>
            Corporate gifting has its own home: bulk pricing, one invoice, many addresses.
          </p>
        </div>
        <ButtonLink href={CORPORATE_URL} variant="secondary">
          Corporate gifting
        </ButtonLink>
      </section>
    </main>
  );
}
