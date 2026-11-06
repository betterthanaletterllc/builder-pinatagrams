import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  checkoutUrlWithOppref,
  openAiCheckoutUrl,
  opprefFromCookies,
  trackOpenAiCommerce,
  trackOpenAiPageView,
} from "../src/lib/openai-ads.ts";

const previousMode = process.env.NODE_ENV;
let calls;
beforeEach(() => {
  process.env.NODE_ENV = "production";
  calls = [];
  globalThis.window = {
    location: { hostname: "builder.pinatagrams.com", pathname: "/design" },
    oaiq: (...args) => calls.push(args),
  };
  globalThis.document = { cookie: "" };
});
afterEach(() => {
  if (previousMode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousMode;
  delete globalThis.window;
  delete globalThis.document;
});

const invoice = "https://pinatagram.myshopify.com/123/invoices/example?key=preserved#payment";

test("preserves the exact opaque click ID through URL encoding", () => {
  const id = "click+/=._-";
  const result = new URL(checkoutUrlWithOppref(invoice, `other=x; __oppref=${encodeURIComponent(id)}`));
  assert.equal(result.searchParams.get("oppref"), id);
  assert.equal(result.searchParams.get("key"), "preserved");
  assert.equal(result.hash, "#payment");
  assert.equal(result.pathname, "/123/invoices/example");
});

test("reads cookies across page visits without requiring oppref in the current URL", () => {
  document.cookie = "__oppref=real_click_from_landing";
  assert.equal(new URL(openAiCheckoutUrl(invoice)).searchParams.get("oppref"), "real_click_from_landing");
  document.cookie = "__oppref=new_click";
  assert.equal(new URL(openAiCheckoutUrl(invoice)).searchParams.get("oppref"), "new_click");
});

test("consent revocation removes stale attribution from a resumed link", () => {
  document.cookie = "";
  const result = openAiCheckoutUrl(`${invoice}&ignored=1`.replace("#payment", "&oppref=old#payment"));
  assert.equal(new URL(result).searchParams.has("oppref"), false);
});

test("does not substitute URL or localStorage values when the SDK cookie is absent", () => {
  window.location.search = "?oppref=not_consented";
  assert.equal(openAiCheckoutUrl(invoice), invoice);
});

test("blocked cookie access never blocks checkout or retains an old click", () => {
  Object.defineProperty(document, "cookie", { get() { throw new Error("blocked"); } });
  assert.equal(openAiCheckoutUrl(invoice), invoice);
  assert.equal(new URL(openAiCheckoutUrl("https://www.pinatagrams.com/checkouts/test?oppref=old")).search, "");
});

test("rejects malformed, blank, control-character and preview identifiers", () => {
  for (const raw of ["", "%", "preview_mock", "%20", "line%0Abreak"]) {
    assert.equal(opprefFromCookies(`__oppref=${raw}`), undefined);
  }
  assert.equal(opprefFromCookies("not__oppref=wrong; __oppref=right"), "right");
});

test("does not leak click identifiers outside the store's HTTPS checkout hosts", () => {
  for (const url of [
    "https://pinatagram.myshopify.com.evil.example/invoice",
    "https://another-store.myshopify.com/invoice",
    "https://example.com/invoice",
    "http://www.pinatagrams.com/invoice",
    "https://name:password@www.pinatagrams.com/invoice",
    "javascript:alert(1)", "not a URL",
  ]) assert.equal(checkoutUrlWithOppref(url, "__oppref=click"), url);
});

test("decorates every supported Shopify invoice hostname", () => {
  for (const host of ["pinatagrams.com", "www.pinatagrams.com", "pinatagram.myshopify.com", "checkout.shopify.com"]) {
    assert.equal(new URL(checkoutUrlWithOppref(`https://${host}/checkout`, "__oppref=click")).searchParams.get("oppref"), "click");
  }
});

test("events use integer cents and the same unique ID, not dollar values", () => {
  trackOpenAiCommerce("items_added", 5000, "cart-1");
  trackOpenAiCommerce("checkout_started", 5000, "checkout-1");
  assert.deepEqual(calls, [
    ["measure", "items_added", { type: "contents", amount: 5000, currency: "USD" }, { event_id: "cart-1" }],
    ["measure", "checkout_started", { type: "contents", amount: 5000, currency: "USD" }, { event_id: "checkout-1" }],
  ]);
});

test("unknown or invalid display prices are omitted rather than misreported", () => {
  for (const amount of [null, NaN, Infinity, -1, 50.5]) trackOpenAiCommerce("checkout_started", amount, "test");
  for (const call of calls) assert.deepEqual(call[2], { type: "contents" });
});

test("page events identify builder pages without collecting gift or address fields", () => {
  trackOpenAiPageView("/design");
  assert.deepEqual(calls[0], ["measure", "page_viewed", {
    type: "contents", contents: [{ id: "builder:/design", name: "Piñatagrams Builder", content_type: "page" }],
  }]);
});

test("development and Vercel previews send no production events or click IDs", () => {
  for (const [mode, hostname] of [["development", "builder.pinatagrams.com"], ["production", "builder-preview.vercel.app"], ["production", "pinatagrams.com.evil.example"]]) {
    process.env.NODE_ENV = mode;
    window.location.hostname = hostname;
    document.cookie = "__oppref=click";
    trackOpenAiPageView("/design");
    trackOpenAiCommerce("checkout_started", 5000, "test");
    assert.equal(openAiCheckoutUrl(invoice), invoice);
  }
  assert.equal(calls.length, 0);
});

test("a blocked or throwing pixel does not interrupt the shopping flow", () => {
  window.oaiq = () => { throw new Error("blocked"); };
  assert.doesNotThrow(() => trackOpenAiPageView("/design"));
  assert.doesNotThrow(() => trackOpenAiCommerce("checkout_started", 5000, "test"));
});

test("bootstrap queues initialization and one landing page view before loading the SDK", async () => {
  delete window.oaiq;
  const scripts = [];
  document.head = { appendChild: (script) => scripts.push(script) };
  document.createElement = () => ({});
  const { startOpenAiAnalytics } = await import("../src/lib/openai-ads.ts?bootstrap-test");
  startOpenAiAnalytics("test_pixel");
  startOpenAiAnalytics("test_pixel");
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, "https://bzrcdn.openai.com/sdk/oaiq.min.js");
  assert.equal(scripts[0].async, true);
  assert.equal(window.oaiq.q.length, 2);
  assert.deepEqual(window.oaiq.q[0], ["init", { pixelId: "test_pixel" }]);
  assert.equal(window.oaiq.q[1][1], "page_viewed");
});
