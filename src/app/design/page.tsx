import Link from "next/link";
import { getCatalog, type HubBodyStyle, type LogoZone } from "@/lib/hub";
import DesignFlow from "./design-flow";

export const dynamic = "force-dynamic";

export default async function DesignPage({
  searchParams,
}: {
  searchParams: Promise<{ style?: string }>;
}) {
  const { style } = await searchParams;

  let match: HubBodyStyle | null = null;
  let box: { interiorUrl: string | null; messageZone: LogoZone | null } | null =
    null;
  let hubDown = false;
  try {
    const catalog = await getCatalog();
    match = catalog.bodyStyles.find((s) => s.id === style && s.inStock) ?? null;
    box = catalog.box ?? null;
  } catch {
    // Hub unreachable — the flow still works; the style is re-validated
    // server-side at order time anyway.
    hubDown = true;
  }

  if (!style || (!match && !hubDown)) {
    return (
      <main>
        <div className="error-box">
          <strong>Pick a body style first.</strong>
          <p className="note">
            <Link href="/">Back to the style picker</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Design your {match ? match.name : style} piñata</h1>
      <DesignFlow
        style={{
          id: style,
          name: match?.name ?? style,
          boxImageUrl: match?.boxImageUrl ?? null,
          logoZone: match?.logoZone ?? null,
        }}
        boxInterior={box}
      />
    </main>
  );
}
