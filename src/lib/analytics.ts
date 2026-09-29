/**
 * Funnel analytics. GA4 uses the SAME property as pinatagrams.com
 * (G-TF4J3S84QY) so builder traffic lands in the store's existing reports.
 * The Meta pixel gets only its standard events (PageView / AddToCart /
 * InitiateCheckout); PostHog gets everything, plus autocapture + replay.
 * Purchases are tracked by Shopify's own checkout, not here.
 *
 * Everything is OFF unless this is a production build on a *.pinatagrams.com
 * host — localhost, `next dev` and *.vercel.app previews used to send real
 * events to these production ids. Off = track() is a no-op (a console.debug
 * line in development so events can still be eyeballed).
 */

import type { PostHog, SessionRecordingOptions } from "posthog-js";
import { GA_ID, META_PIXEL_ID, POSTHOG_HOST, POSTHOG_KEY } from "./analytics-config";

// The ids live in a browser-free module so server routes can share them.
export { GA_ID, META_PIXEL_ID, POSTHOG_HOST, POSTHOG_KEY };

type Gtag = (...args: unknown[]) => void;
type Fbq = (...args: unknown[]) => void;

declare global {
  interface Window {
    gtag?: Gtag;
    fbq?: Fbq;
  }
}

/** True only for real shoppers: a production build on *.pinatagrams.com. */
export function analyticsEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase();
  return host === "pinatagrams.com" || host.endsWith(".pinatagrams.com");
}

function devLog(event: string, props?: Record<string, unknown>): void {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[analytics off]", event, props ?? {});
  }
}

/** Dimensions on EVERY event — landing pageview and autocapture included:
 *  - store_host: the variant dimension. The HOSTNAME is available
 *    synchronously before any event fires (the async-fetched profile name
 *    would miss the landing pageview — the funnel's denominator); map
 *    hostname → variant at analysis time via the hub's variants table.
 *  - flow_version: which build flow rendered (<body data-flow>, "v1" when
 *    absent). */
export function superProps(): Record<string, string> {
  try {
    const flow = document.body?.dataset.flow ?? "";
    return {
      store_host: window.location.hostname,
      flow_version: /^v\d+$/.test(flow) ? flow : "v1",
    };
  } catch {
    return {};
  }
}

/* --- PostHog: lazy-loaded -----------------------------------------------------
 * posthog-js is ~75 KB gzipped — too heavy for every route's first load. It
 * loads on the shopper's first interaction, or once the browser is idle
 * after the page's own load, whichever comes first. Events captured before
 * then wait in a small in-memory queue (keeping their original time and URL)
 * and flush the moment PostHog initializes.
 * -------------------------------------------------------------------------- */

// Session replay privacy, enforced in code (client settings win over the
// project's): every input is masked (gift messages, addresses, emails,
// codes); nothing that can show a customer's photo is recorded — the editor
// canvas and data:/blob: images (uploads, custom-art previews); text that
// echoes a message or an address is masked. Mark anything else with the
// class `ph-no-capture` (block) or the attribute `data-ph-mask` (mask text).
const REPLAY_PRIVACY: SessionRecordingOptions = {
  maskAllInputs: true,
  blockSelector:
    'canvas, img[src^="data:"], img[src^="blob:"], .ph-no-capture',
  maskTextSelector:
    ".flap-message, .cart-msg, .cart-detail dd, .ship-to-addr, .addr-card, .addr-sug, [data-ph-mask]",
};

type Queued = { event: string; props: Record<string, unknown>; at: number };
const PH_QUEUE_MAX = 100;

let ph: PostHog | null = null;
let phState: "idle" | "loading" | "ready" | "failed" = "idle";
const phQueue: Queued[] = [];

function phCapture(event: string, props: Record<string, unknown>): void {
  if (!POSTHOG_KEY) return;
  if (ph) {
    try {
      ph.capture(event, props);
    } catch {}
    return;
  }
  if (phState === "failed") return;
  if (phQueue.length < PH_QUEUE_MAX) {
    phQueue.push({
      event,
      // Snapshot where it happened — it may flush after a client-side
      // route change.
      props: {
        ...props,
        $current_url: window.location.href,
        $pathname: window.location.pathname,
      },
      at: Date.now(),
    });
  }
  scheduleAnalyticsLoad();
}

function loadPosthog(): void {
  if (phState !== "idle") return;
  phState = "loading";
  import("posthog-js")
    .then(({ default: posthog }) => {
      if (!posthog.__loaded) {
        posthog.init(POSTHOG_KEY, {
          api_host: POSTHOG_HOST,
          // Pageviews are manual — the landing one arrives through the
          // queue, SPA route changes through trackPageView — so each counts
          // exactly once alongside GA/Meta. Autocapture stays on (default).
          capture_pageview: false,
          capture_pageleave: true,
          session_recording: REPLAY_PRIVACY,
        });
      }
      // Session-scoped on purpose: PostHog's cookie spans *.pinatagrams.com,
      // and a persistent register() would stamp this app's store_host onto
      // events from sibling sites sharing the project.
      posthog.register_for_session(superProps());
      ph = posthog;
      phState = "ready";
      for (const q of phQueue.splice(0)) {
        try {
          posthog.capture(q.event, q.props, { timestamp: new Date(q.at) });
        } catch {}
      }
    })
    .catch(() => {
      phState = "failed";
      phQueue.length = 0;
    });
}

function whenIdle(cb: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(cb, { timeout: 3000 });
    return () => window.cancelIdleCallback(id);
  }
  const t = window.setTimeout(cb, 1500); // Safari: no requestIdleCallback
  return () => window.clearTimeout(t);
}

let loadArmed = false;

/** Arm the lazy PostHog load (idempotent): the first interaction, or idle
 *  after the page's load event — never competing with the first paint. */
export function scheduleAnalyticsLoad(): void {
  if (loadArmed || !POSTHOG_KEY || !analyticsEnabled()) return;
  loadArmed = true;
  const INTERACTIONS = ["pointerdown", "keydown", "touchstart", "scroll"];
  let cancelIdle = () => {};
  const go = () => {
    for (const e of INTERACTIONS) window.removeEventListener(e, go, true);
    window.removeEventListener("load", onLoad);
    cancelIdle();
    loadPosthog();
  };
  const onLoad = () => {
    cancelIdle = whenIdle(go);
  };
  for (const e of INTERACTIONS) {
    window.addEventListener(e, go, { capture: true, passive: true });
  }
  if (document.readyState === "complete") onLoad();
  else window.addEventListener("load", onLoad, { once: true });
}

/** PostHog's ids for checkout forensics (order customAttributes) without a
 *  static posthog-js import — null until PostHog has loaded (or when
 *  analytics are off); never forces the load. */
export function posthogIds(): { distinctId: string; sessionId: string } | null {
  if (!ph) return null;
  try {
    return { distinctId: ph.get_distinct_id(), sessionId: ph.get_session_id() };
  } catch {
    return null;
  }
}

let started = false;

/** Called once by <Analytics/> on mount: queues the landing $pageview (with
 *  the super-props the old first pageview lacked) and arms the lazy load. */
export function startAnalytics(): void {
  if (started || !analyticsEnabled()) return;
  started = true;
  phCapture("$pageview", superProps());
  scheduleAnalyticsLoad();
}

/** Fan a funnel event out to GA4 + PostHog (Meta gets only its standard
 *  events — AddToCart/InitiateCheckout/PageView — via the helpers below).
 *  One call per moment in flow code; never throws. */
export function track(event: string, props?: Record<string, unknown>): void {
  if (!analyticsEnabled()) return devLog(event, props);
  const p = { ...superProps(), ...(props ?? {}) };
  try {
    window.gtag?.("event", event, p);
  } catch {}
  phCapture(event, p);
}

export function trackPageView(path: string): void {
  if (!analyticsEnabled()) return devLog("page_view", { path });
  const sp = superProps();
  try {
    window.gtag?.("event", "page_view", { page_path: path, ...sp });
  } catch {}
  try {
    window.fbq?.("track", "PageView");
  } catch {}
  phCapture("$pageview", sp);
}

/* --- Meta de-duplication -------------------------------------------------------
 * Since 2026-09-17 a Conversions API Gateway is attached to the pixel (its
 * config's "openbridge" block, every domain): fbevents re-sends each browser
 * event to it and it reaches Meta again as a server event, so raw "events
 * received" doubled (InitiateCheckout per draft 0.96 → 1.97). Meta
 * de-duplicates pairs sharing an event name + eventID, and both copies carry
 * the id set here — ad results didn't double. The id is returned to the
 * caller too, so a future server-side (Conversions API) send can reuse it.
 * Raw counts stay ~2× until the gateway is removed or blocks this host.
 * -------------------------------------------------------------------------- */

function newEventId(prefix: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}.${crypto.randomUUID()}`;
    }
  } catch {}
  return `${prefix}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
}

function trackCommerce(
  gaEvent: string,
  metaEvent: string,
  valueCents: number | null,
  eventId: string,
): void {
  const value = valueCents !== null ? valueCents / 100 : undefined;
  if (!analyticsEnabled()) return devLog(gaEvent, { value, eventId });
  const sp = superProps();
  try {
    window.gtag?.("event", gaEvent, { currency: "USD", value, ...sp });
  } catch {}
  try {
    window.fbq?.("track", metaEvent, { currency: "USD", value }, { eventID: eventId });
  } catch {}
  phCapture(gaEvent, { currency: "USD", value, ...sp, meta_event_id: eventId });
}

/** Returns the Meta eventID it sent (pass `eventId` to reuse one). */
export function trackAddToCart(
  valueCents: number | null,
  opts?: { eventId?: string },
): string {
  const eventId = opts?.eventId ?? newEventId("atc");
  trackCommerce("add_to_cart", "AddToCart", valueCents, eventId);
  return eventId;
}

/** Returns the Meta eventID it sent (pass `eventId` to reuse one). */
export function trackBeginCheckout(
  valueCents: number | null,
  opts?: { eventId?: string },
): string {
  const eventId = opts?.eventId ?? newEventId("ic");
  trackCommerce("begin_checkout", "InitiateCheckout", valueCents, eventId);
  return eventId;
}

/* --- Web vitals ----------------------------------------------------------------
 * LCP / INP / CLS from Next's useReportWebVitals (analytics.tsx), sent for
 * a sample of page loads as one `web_vitals` event per metric. Traffic is
 * low (~230 landers/day), so half of loads still yields a stable weekly
 * p75 per flow_version without flooding either tool.
 * -------------------------------------------------------------------------- */

const VITALS = new Set(["LCP", "INP", "CLS"]);
const VITALS_SAMPLE_RATE = 0.5;
let vitalsSampled: boolean | null = null;

export function reportWebVitals(metric: {
  name: string;
  value: number;
  id: string;
  rating?: string;
  navigationType?: string;
}): void {
  if (!VITALS.has(metric.name)) return;
  vitalsSampled ??= Math.random() < VITALS_SAMPLE_RATE;
  if (!vitalsSampled) return;
  track("web_vitals", {
    metric: metric.name,
    // CLS is a unitless score; LCP/INP are milliseconds
    value:
      metric.name === "CLS"
        ? Math.round(metric.value * 1000) / 1000
        : Math.round(metric.value),
    rating: metric.rating,
    navigation_type: metric.navigationType,
    metric_id: metric.id,
    path: window.location.pathname,
  });
}
