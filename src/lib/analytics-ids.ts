/**
 * The browser's analytics identities, read at checkout so the server can
 * stamp them on the order (order-level custom attributes, never the note)
 * and a paid order can be joined back to the session that built it.
 *
 * Every read is defensive and independent: a missing cookie, a blocked
 * store, or a PostHog that hasn't loaded yet (it may be lazy-loaded) just
 * leaves that id out — this never throws and never blocks checkout.
 */

export type AnalyticsIds = {
  phDistinctId?: string;
  phSessionId?: string;
  gaClientId?: string;
  fbp?: string;
  fbc?: string;
};

// PostHog rotates a session after 30 idle minutes (its default); an older
// persisted session id would join the order to the wrong session.
const PH_SESSION_IDLE_MS = 30 * 60 * 1000;
// _fbc embeds the ad's fbclid, which can run long
const MAX_LEN = 500;

type PosthogLike = {
  get_distinct_id?: () => unknown;
  get_session_id?: () => unknown;
};

function clean(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  // ids are opaque tokens — anything with whitespace/control chars or of
  // absurd length isn't one
  return s && s.length <= MAX_LEN && !/[\s\u0000-\u001f]/.test(s) ? s : undefined;
}

function cookie(name: string): string | undefined {
  try {
    for (const part of document.cookie.split(";")) {
      const i = part.indexOf("=");
      if (i < 0 || part.slice(0, i).trim() !== name) continue;
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return part.slice(i + 1).trim();
      }
    }
  } catch {}
  return undefined;
}

/** GA4 client id from the `_ga` cookie ("GA1.1.123456789.1690000000" →
 *  "123456789.1690000000" — the last two dot-separated fields). */
function gaClientId(): string | undefined {
  const raw = cookie("_ga");
  if (!raw) return undefined;
  const parts = raw.split(".");
  if (parts.length < 4) return undefined;
  const id = parts.slice(-2).join(".");
  return /^\d+\.\d+$/.test(id) ? id : undefined;
}

/** Meta browser / click ids, verbatim ("fb.1.<ts>.<random|fbclid>"). */
function metaId(name: "_fbp" | "_fbc"): string | undefined {
  const v = clean(cookie(name));
  return v && v.startsWith("fb.") ? v : undefined;
}

/** PostHog's persisted state: `ph_<token>_posthog`, JSON, in localStorage
 *  (default "localStorage+cookie" persistence) or the same-named cookie. */
function posthogPersisted(): Record<string, unknown> | undefined {
  const parse = (raw: string | null | undefined) => {
    if (!raw) return undefined;
    try {
      const j = JSON.parse(raw);
      return j && typeof j === "object" ? (j as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const isPh = (k: string) => /^ph_.+_posthog$/.test(k);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && isPh(k)) {
        const j = parse(localStorage.getItem(k));
        if (j?.distinct_id) return j;
      }
    }
  } catch {}
  try {
    for (const part of document.cookie.split(";")) {
      const i = part.indexOf("=");
      if (i < 0 || !isPh(part.slice(0, i).trim())) continue;
      let v = part.slice(i + 1).trim();
      try {
        v = decodeURIComponent(v);
      } catch {}
      const j = parse(v);
      if (j?.distinct_id) return j;
    }
  } catch {}
  return undefined;
}

function posthogIds(): Pick<AnalyticsIds, "phDistinctId" | "phSessionId"> {
  let distinct: string | undefined;
  let session: string | undefined;
  // A live instance, if one is exposed on window, knows best.
  try {
    const ph = (window as unknown as { posthog?: PosthogLike }).posthog;
    if (ph && typeof ph === "object") {
      if (typeof ph.get_distinct_id === "function") distinct = clean(ph.get_distinct_id());
      if (typeof ph.get_session_id === "function") session = clean(ph.get_session_id());
    }
  } catch {}
  if (!distinct || !session) {
    const p = posthogPersisted();
    distinct ??= clean(p?.distinct_id);
    // $sesid = [lastActivityMs, sessionId, sessionStartMs]
    const sesid = p?.$sesid;
    if (!session && Array.isArray(sesid)) {
      const last = sesid[0];
      const fresh = typeof last === "number" && Date.now() - last < PH_SESSION_IDLE_MS;
      if (fresh) session = clean(sesid[1]);
    }
  }
  return {
    ...(distinct ? { phDistinctId: distinct } : {}),
    ...(session ? { phSessionId: session } : {}),
  };
}

/** Whatever ids this browser has right now; absent ones are omitted. */
export function readAnalyticsIds(): AnalyticsIds {
  if (typeof window === "undefined") return {};
  const ga = gaClientId();
  const fbp = metaId("_fbp");
  const fbc = metaId("_fbc");
  return {
    ...posthogIds(),
    ...(ga ? { gaClientId: ga } : {}),
    ...(fbp ? { fbp } : {}),
    ...(fbc ? { fbc } : {}),
  };
}
