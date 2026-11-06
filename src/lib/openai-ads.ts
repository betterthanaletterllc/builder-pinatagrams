/** OpenAI's browser pixel and the attribution bridge into Shopify checkout.
 * Purchases belong to Shopify's connected ChatGPT app, not a second pixel
 * call when a draft is created or the shopper returns to the builder.
 */
type OpenAiQueue = ((...args: unknown[]) => void) & { q?: unknown[][] };

declare global {
  interface Window {
    oaiq?: OpenAiQueue;
  }
}

export function openAiEnabled(): boolean {
  if (process.env.NODE_ENV !== "production" || typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase();
  return host === "pinatagrams.com" || host.endsWith(".pinatagrams.com");
}

let started = false;

export function startOpenAiAnalytics(pixelId: string): void {
  if (started || !pixelId || !openAiEnabled()) return;
  try {
    if (!window.oaiq) {
      const queue: OpenAiQueue = (...args) => { queue.q!.push(args); };
      queue.q = [];
      window.oaiq = queue;
      const script = document.createElement("script");
      script.async = true;
      script.src = "https://bzrcdn.openai.com/sdk/oaiq.min.js";
      document.head.appendChild(script);
    }
    window.oaiq("init", { pixelId });
    started = true;
    trackOpenAiPageView(window.location.pathname);
  } catch {
    // Analytics must never interrupt designing or checkout.
  }
}

export function trackOpenAiPageView(path: string): void {
  if (!openAiEnabled()) return;
  try {
    window.oaiq?.("measure", "page_viewed", {
      type: "contents",
      contents: [{ id: `builder:${path}`, name: "Piñatagrams Builder", content_type: "page" }],
    });
  } catch {}
}

export function trackOpenAiCommerce(
  event: "items_added" | "checkout_started",
  amount: number | null,
  eventId: string,
): void {
  if (!openAiEnabled()) return;
  try {
    window.oaiq?.("measure", event, {
      type: "contents",
      ...(amount !== null && Number.isSafeInteger(amount) && amount >= 0
        ? { amount, currency: "USD" }
        : {}),
    }, { event_id: eventId });
  } catch {}
}

/** Read only the SDK's consent-controlled cookie. Do not recreate an
 * attribution cookie from the URL when consent is denied or storage is
 * blocked. The SDK owns its 30-day expiry and removes it on revocation.
 */
export function opprefFromCookies(cookies: string): string | undefined {
  for (const part of cookies.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0 || part.slice(0, equals).trim() !== "__oppref") continue;
    try {
      const value = decodeURIComponent(part.slice(equals + 1));
      // Preview clicks must not become attributed purchases. Opaque real
      // identifiers are preserved byte-for-byte, including + and =.
      return value && value !== "preview_mock" && !/[\u0000-\u0020\u007f]/.test(value)
        ? value
        : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

const CHECKOUT_HOSTS = new Set([
  "pinatagrams.com", "www.pinatagrams.com", "pinatagram.myshopify.com", "checkout.shopify.com",
]);

/** Pure URL transform, also used by regression tests. Never sends the
 * attribution identifier to a host outside this store's checkout.
 */
export function checkoutUrlWithOppref(invoiceUrl: string, cookies: string): string {
  try {
    const url = new URL(invoiceUrl);
    if (url.protocol !== "https:" || url.username || url.password || !CHECKOUT_HOSTS.has(url.hostname)) {
      return invoiceUrl;
    }
    const oppref = opprefFromCookies(cookies);
    if (!oppref && !url.searchParams.has("oppref")) return invoiceUrl;
    url.searchParams.delete("oppref");
    if (oppref) url.searchParams.set("oppref", oppref);
    return url.toString();
  } catch { return invoiceUrl; }
}

/** Called at navigation time, including resume-payment. Pending orders
 * keep the original invoice URL rather than storing a stale click ID.
 */
export function openAiCheckoutUrl(invoiceUrl: string): string {
  if (!openAiEnabled()) return invoiceUrl;
  try { return checkoutUrlWithOppref(invoiceUrl, document.cookie); }
  catch { return checkoutUrlWithOppref(invoiceUrl, ""); }
}
