import { getCatalog, HUB_URL, priceUrl, type HubPrice } from "@/lib/hub";
import BuilderPreview from "./builder-preview";

// Always render against the live hub — no build-time snapshot yet, and the
// build must succeed even when the hub is unreachable (see catch below).
export const dynamic = "force-dynamic";

// The B2C sticker price shown on every style card (all bodies price the
// same; add-ons ride on top). Null on any hiccup — cards just omit it.
async function b2cUnitCents(): Promise<number | null> {
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
    return Number.isFinite(p.unitPriceCents) && p.unitPriceCents > 0
      ? p.unitPriceCents
      : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  try {
    const [catalog, priceCents] = await Promise.all([
      getCatalog(),
      b2cUnitCents(),
    ]);
    return (
      <main>
        <h1 className="step-h1">Step One: Pick a body style</h1>
        <BuilderPreview bodyStyles={catalog.bodyStyles} priceCents={priceCents} />
      </main>
    );
  } catch {
    return (
      <main>
        <div className="error-box">
          <strong>The catalog is unavailable right now.</strong>
          <p className="note">
            Couldn&apos;t reach the hub at {HUB_URL}. If you&apos;re developing
            locally, start the admin app first: <code>cd ../admin && npm run dev</code>.
          </p>
        </div>
      </main>
    );
  }
}
