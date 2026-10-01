import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * Address suggestions from Google Places (New), proxied so the API key never
 * reaches the browser. Two calls per typing session, sharing one session
 * token (Google bills the session, not each keystroke):
 *   GET /api/address?q=<typed>&session=<uuid>        → { suggestions }
 *   GET /api/address?place=<placeId>&session=<uuid>  → { address }
 * No GOOGLE_PLACES_API_KEY → 503, and the field falls back to Photon
 * (OpenStreetMap) on its own. Restrict the key to the Places API (New).
 */

export const dynamic = "force-dynamic";

const KEY = () => process.env.GOOGLE_PLACES_API_KEY || "";
const TIMEOUT_MS = 4_000;
const SESSION_RE = /^[A-Za-z0-9_-]{8,36}$/; // Google: at most 36 chars
const PLACE_RE = /^[A-Za-z0-9_-]{8,300}$/;

type Component = { longText?: string; shortText?: string; types?: string[] };

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  const key = KEY();
  if (!key) return json({ error: "not_configured" }, 503);
  // ~a dozen keystrokes per address, a few addresses per visit.
  if (!rateLimit(`address:${clientIp(req)}`, 120, 60_000))
    return json({ error: "rate_limited" }, 429);

  const url = new URL(req.url);
  const session = url.searchParams.get("session") ?? "";
  if (!SESSION_RE.test(session)) return json({ error: "bad_session" }, 400);
  const place = url.searchParams.get("place");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);

  try {
    if (place) {
      if (!PLACE_RE.test(place)) return json({ error: "bad_place" }, 400);
      // Ending the session with a Details call is what makes Google bill it
      // as one session. displayName makes it a Details PRO call on purpose:
      // a Pro ending makes every keystroke in the session free (an
      // Essentials ending bills the first 12), and Pro's 5,000 free a month
      // then covers 5,000 picked addresses outright.
      const r = await fetch(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(place)}?sessionToken=${encodeURIComponent(session)}`,
        {
          headers: {
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": "addressComponents,displayName",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        },
      );
      if (!r.ok) return json({ error: "upstream" }, 502);
      const j = (await r.json()) as { addressComponents?: Component[] };
      const parts = j.addressComponents ?? [];
      const get = (type: string, short = false) => {
        const c = parts.find((p) => p.types?.includes(type));
        return (short ? c?.shortText : c?.longText) ?? "";
      };
      if (get("country", true) !== "US") return json({ address: null });
      const number = get("street_number");
      const route = get("route", true);
      return json({
        address: {
          number,
          street: route,
          city:
            get("locality") ||
            get("postal_town") ||
            get("sublocality_level_1") ||
            get("neighborhood") ||
            get("administrative_area_level_3"),
          province: get("administrative_area_level_1", true),
          zip: get("postal_code"),
        },
      });
    }

    if (q.length < 5) return json({ suggestions: [] });
    const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat",
      },
      body: JSON.stringify({
        input: q,
        sessionToken: session,
        includedRegionCodes: ["us"],
        includedPrimaryTypes: ["street_address", "premise", "subpremise", "route"],
        languageCode: "en",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!r.ok) return json({ error: "upstream" }, 502);
    const j = (await r.json()) as {
      suggestions?: {
        placePrediction?: {
          placeId?: string;
          structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
        };
      }[];
    };
    const suggestions = (j.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => !!p?.placeId && !!p.structuredFormat?.mainText?.text)
      .slice(0, 6)
      .map((p) => ({
        id: p.placeId!,
        main: p.structuredFormat!.mainText!.text!,
        // "Springfield, IL, USA" → "Springfield, IL"
        secondary: (p.structuredFormat!.secondaryText?.text ?? "").replace(/,\s*USA$/, ""),
      }));
    return json({ suggestions });
  } catch {
    return json({ error: "upstream" }, 502);
  }
}
