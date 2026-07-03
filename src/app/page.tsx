import { getCatalog, HUB_URL } from "@/lib/hub";
import BuilderPreview from "./builder-preview";

// Always render against the live hub — no build-time snapshot yet, and the
// build must succeed even when the hub is unreachable (see catch below).
export const dynamic = "force-dynamic";

export default async function Home() {
  try {
    const catalog = await getCatalog();
    return (
      <main>
        <h1>Build a Piñatagram</h1>
        <p className="sub">Step One: Pick a body style</p>
        <BuilderPreview bodyStyles={catalog.bodyStyles} />
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
