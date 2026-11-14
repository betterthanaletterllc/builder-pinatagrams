import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  EMBED_HEADER,
  EMBED_SOURCE,
  EMBED_VERSION,
  embedDesignMessage,
  embedFrameAncestors,
  embedMessage,
  embedParentOrigins,
  isEmbedPath,
  isEmbedRequest,
  pickEmbedStyle,
  readInit,
} from "../src/lib/embed.ts";

const PAPER = "https://paper.betterthanaletter.com";

test("only /embed and what is under it is the embed", () => {
  for (const p of ["/embed", "/embed/design", "/embed/design/"]) assert.equal(isEmbedPath(p), true, p);
  for (const p of ["/", "/design", "/embedded", "/api/art/upload", "/cart", "/design/embed"]) {
    assert.equal(isEmbedPath(p), false, p);
  }
});

test("in production only Paper may frame it", () => {
  assert.deepEqual(embedParentOrigins(true), [PAPER]);
  assert.equal(embedFrameAncestors(true), `frame-ancestors ${PAPER}`);
});

test("off production Paper's dev server may too, and nothing wider", () => {
  assert.deepEqual(embedParentOrigins(false), [PAPER, "http://localhost:3000"]);
  const policy = embedFrameAncestors(false);
  assert.equal(policy.includes("*"), false);
  assert.equal(policy.includes("'self'"), false);
});

test("the layout reads the middleware's header, and only the value 1 counts", () => {
  const h = (v) => ({ get: (name) => (name === EMBED_HEADER ? v : null) });
  assert.equal(isEmbedRequest(h("1")), true);
  assert.equal(isEmbedRequest(h("0")), false);
  assert.equal(isEmbedRequest(h(null)), false);
  assert.equal(isEmbedRequest(h("true")), false);
});

test("an init is read only from an allowed origin, in this version", () => {
  const init = { source: EMBED_SOURCE, v: EMBED_VERSION, type: "init", design: { version: 2 } };
  assert.deepEqual(readInit(PAPER, init, [PAPER])?.design, { version: 2 });
  assert.equal(readInit("https://evil.example", init, [PAPER]), null);
  assert.equal(readInit(PAPER, { ...init, v: 2 }, [PAPER]), null);
  assert.equal(readInit(PAPER, { ...init, source: "someone-else" }, [PAPER]), null);
  assert.equal(readInit(PAPER, { ...init, type: "design" }, [PAPER]), null);
  assert.equal(readInit(PAPER, "init", [PAPER]), null);
  assert.equal(readInit(PAPER, null, [PAPER]), null);
});

test("an init without a design means a blank label", () => {
  const init = { source: EMBED_SOURCE, v: EMBED_VERSION, type: "init" };
  assert.equal(readInit(PAPER, init, [PAPER])?.design, null);
});

test("the messages the embed sends carry the source and version", () => {
  assert.deepEqual(embedMessage("ready"), { source: EMBED_SOURCE, v: 1, type: "ready" });
  assert.deepEqual(embedMessage("close"), { source: EMBED_SOURCE, v: 1, type: "close" });
  assert.deepEqual(
    embedDesignMessage({
      artUrl: "https://x.public.blob.vercel-storage.com/builder-art/abc/front.jpg",
      sha256: "a".repeat(64),
      designUrl: "https://x.public.blob.vercel-storage.com/builder-art/abc/design.json",
      preview: "data:image/png;base64,AAAA",
    }),
    {
      source: EMBED_SOURCE,
      v: 1,
      type: "design",
      art: {
        url: "https://x.public.blob.vercel-storage.com/builder-art/abc/front.jpg",
        sha256: "a".repeat(64),
      },
      designUrl: "https://x.public.blob.vercel-storage.com/builder-art/abc/design.json",
      preview: "data:image/png;base64,AAAA",
    },
  );
});

test("the box shown is the body asked for, by id or by printed name", () => {
  const styles = [
    { id: "classic", name: "Classic" },
    { id: "googly", name: "Googly" },
    { id: "green", name: "Green Machine" },
  ];
  assert.equal(pickEmbedStyle(styles, "green")?.id, "green");
  assert.equal(pickEmbedStyle(styles, "GREEN MACHINE")?.id, "green");
  assert.equal(pickEmbedStyle(styles, " Classic ")?.id, "classic");
  // unknown or missing: the usual default, else the first there is
  assert.equal(pickEmbedStyle(styles, "no-such-body")?.id, "googly");
  assert.equal(pickEmbedStyle(styles, null)?.id, "googly");
  assert.equal(pickEmbedStyle(styles.slice(0, 1), undefined)?.id, "classic");
  assert.equal(pickEmbedStyle([], "green"), null);
});

test("the embed module imports nothing: the edge middleware loads it", () => {
  const source = readFileSync(new URL("../src/lib/embed.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(source), false);
});

test("the middleware sets the framing rule on the embed only", () => {
  const source = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
  // one place sets a Content-Security-Policy, and it is inside `if (embed)`
  assert.equal(source.split("Content-Security-Policy").length - 1, 1);
  const at = source.indexOf("Content-Security-Policy");
  const guard = source.lastIndexOf("if (embed) {", at);
  assert.ok(guard !== -1 && at - guard < 400, "the header is set inside the embed branch");
  assert.ok(source.includes('headers.set(EMBED_HEADER, embed ? "1" : "0")'));
});

test("analytics are off on the embed", () => {
  const source = readFileSync(new URL("../src/lib/analytics.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export function analyticsEnabled"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.includes("if (isEmbedPath(window.location.pathname)) return false;"));
});

/* --- /embed/sample: the journey's step one, and "this piñata" ----------------- */

const {
  embedBodyToken,
  embedChoiceMessage,
  embedGraphicFor,
} = await import("../src/lib/embed.ts");

test("the body is named as checkout names it in a line's SKU", () => {
  assert.equal(embedBodyToken("googly"), "GOOGLY");
  assert.equal(embedBodyToken("checkered"), "CHECKERED");
  assert.equal(embedBodyToken("white-uni"), "WHITE UNICORN");
  assert.equal(embedBodyToken("pink-uni"), "PINK UNICORN");
  // spaces, never hyphens: Paper's parser splits a SKU on its LAST hyphen
  assert.equal(embedBodyToken("some-new-style"), "SOME NEW STYLE");

  // Checkout holds the other copy of this rule; the two must not drift.
  const checkout = readFileSync(new URL("../src/app/api/checkout/route.ts", import.meta.url), "utf8");
  const table = /const SKU_SUFFIX_SPECIAL: Record<string, string> = \{([^}]*)\};/.exec(checkout);
  assert.ok(table, "checkout's table of special body names was not found");
  const special = [...table[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(([, id, name]) => [id, name]);
  assert.ok(special.length >= 2);
  for (const [id, name] of special) assert.equal(embedBodyToken(id), name, id);
  assert.match(checkout, /styleId\.toUpperCase\(\)\.replace\(\/-\/g, " "\)/);
});

test("a pick is reported in the journey's three shapes, and not before it can be", () => {
  // A store design: its print file on the store's CDN.
  assert.deepEqual(
    embedGraphicFor({ type: "shopify", design: "HBD01", title: "Confetti Birthday", art: "https://cdn.shopify.com/s/files/1/1116/8788/files/HBD01_front.png" }),
    { kind: "shopify", design: "HBD01", title: "Confetti Birthday", art: "https://cdn.shopify.com/s/files/1/1116/8788/files/HBD01_front.png" },
  );
  assert.equal(embedGraphicFor({ type: "shopify", design: "HBD01", title: "x", art: null }), null);

  // A hub graphic: its print file and the sha256 of it.
  assert.deepEqual(
    embedGraphicFor({ type: "hub", design: "H0001", title: "Logo", art: "https://x.public.blob.vercel-storage.com/library/graphics/H0001.png", artSha256: "a".repeat(64) }),
    { kind: "hub", design: "H0001", title: "Logo", art: { url: "https://x.public.blob.vercel-storage.com/library/graphics/H0001.png", sha256: "a".repeat(64) } },
  );
  assert.equal(embedGraphicFor({ type: "hub", design: "H0001", title: "Logo", art: "https://x/y.png", artSha256: null }), null);

  // A design made in the editor: only once its print file is staged.
  assert.equal(embedGraphicFor({ type: "custom" }), null);
  assert.equal(embedGraphicFor({ type: "custom", art: "https://x/front.png", artSha256: null }), null);
  assert.deepEqual(
    embedGraphicFor({ type: "custom", art: "https://x/front.png", artSha256: "b".repeat(64), designUrl: "https://x/design.json" }),
    { kind: "custom", art: { url: "https://x/front.png", sha256: "b".repeat(64) }, designUrl: "https://x/design.json" },
  );
});

test("the choice message names the body, the front and the card the message prints on", () => {
  const graphic = { kind: "shopify", design: "HBD01", title: "Confetti Birthday", art: "https://cdn.shopify.com/a.png" };
  assert.deepEqual(
    embedChoiceMessage({
      style: { id: "pink-uni", name: "Pink Unicorn" },
      graphic,
      messageCard: "https://cdn.shopify.com/card.svg",
      preview: "https://cdn.shopify.com/thumb.png",
    }),
    {
      source: EMBED_SOURCE,
      v: EMBED_VERSION,
      type: "choice",
      style: { id: "pink-uni", name: "Pink Unicorn", body: "PINK UNICORN" },
      graphic,
      messageCard: "https://cdn.shopify.com/card.svg",
      preview: "https://cdn.shopify.com/thumb.png",
    },
  );
});

test("the sample page is under /embed, so it gets the framing rule and no chrome", () => {
  assert.equal(isEmbedPath("/embed/sample"), true);
  const page = readFileSync(new URL("../src/app/embed/sample/embed-sample.tsx", import.meta.url), "utf8");
  // It is built from the journey's own step-one components, not copies of them.
  for (const part of ["@/v2/design/stage", "@/v2/design/step-design", "@/v2/design/sheets", "@/v2/design/editor-view"]) {
    assert.ok(page.includes(part), `the sample page no longer uses ${part}`);
  }
  // No cart, no checkout, no analytics calls.
  for (const banned of ["saveCart", "startCheckout", "trackV2", "trackAddToCart"]) {
    assert.equal(page.includes(banned), false, `the sample page uses ${banned}`);
  }
});
