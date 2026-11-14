import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
      seq: 3,
    }),
    {
      source: EMBED_SOURCE,
      v: EMBED_VERSION,
      type: "choice",
      seq: 3,
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

test("the sample page keeps the box on screen after the pick is sent", () => {
  const page = readFileSync(new URL("../src/app/embed/sample/embed-sample.tsx", import.meta.url), "utf8");
  // Once past its guard for "no body styles at all", the page returns ONE
  // tree: the editor, or the step with the Stage. Nothing about a sent pick
  // can swap the Stage for a flat picture of the label.
  const body = page.slice(page.indexOf("export default function EmbedSample"));
  // every place the component hands back something to draw, however nested
  const screens = body.match(/\breturn\s*\(?\s*</g) ?? [];
  assert.equal(screens.length, 1, "the page has more than one screen");
  assert.equal(body.split("<Stage").length - 1, 1, "the Stage is drawn in exactly one place");
  // The Stage's only alternative is the editor, never a "sent" state…
  assert.match(body, /\{editor \? \(\s*<EditorView[\s\S]*?\) : \(\s*<div className=\{f\.layout\}>/);
  // …and the page draws no picture of its own: no <img>, no flat preview.
  assert.equal(/<img\b/.test(body), false, "the page draws a flat picture");
  assert.equal(page.includes("embed.module.css"), false, "the flat-preview styles are back");
});

/* --- "held" and "pick-state": the two pages keep each other honest ------------- */

const embed = await import("../src/lib/embed.ts");
const { embedPickKey, embedPickState, embedPickStateMessage, readHeld } = embed;

test("a pick is its body and its front; a design changed since is another pick", () => {
  const store = { type: "shopify", design: "HBD01" };
  assert.equal(embedPickKey("googly", store), embedPickKey("googly", { ...store, title: "any" }));
  assert.notEqual(embedPickKey("googly", store), embedPickKey("tropical", store));
  assert.notEqual(embedPickKey("googly", store), embedPickKey("googly", { type: "shopify", design: "HBD05" }));
  // a hub graphic and a store design that share a code are still different picks
  assert.notEqual(embedPickKey("googly", store), embedPickKey("googly", { type: "hub", design: "HBD01" }));

  const made = { type: "custom", artSha256: "a".repeat(64) };
  assert.equal(embedPickKey("googly", made), embedPickKey("googly", { ...made }));
  assert.notEqual(embedPickKey("googly", made), embedPickKey("googly", { type: "custom", artSha256: "b".repeat(64) }));
  // a design whose print file is not staged yet is never the one that was sent
  assert.notEqual(embedPickKey("googly", made), embedPickKey("googly", { type: "custom", artSha256: null }));
  assert.notEqual(embedPickKey("googly", made), embedPickKey("googly", { type: "custom" }));
});

test("what is showing is told against what was sent", () => {
  const sent = embedPickKey("googly", { type: "shopify", design: "HBD01" });
  const other = embedPickKey("camo", { type: "shopify", design: "HBD01" });
  assert.equal(embedPickState({ sentKey: null, nowKey: sent, waiting: false }), "none");
  assert.equal(embedPickState({ sentKey: sent, nowKey: sent, waiting: false }), "current");
  assert.equal(embedPickState({ sentKey: sent, nowKey: other, waiting: false }), "changed");
  // the button was pressed and the design is still saving: that wins, sent before or not
  assert.equal(embedPickState({ sentKey: null, nowKey: other, waiting: true }), "saving");
  assert.equal(embedPickState({ sentKey: sent, nowKey: other, waiting: true }), "saving");
  assert.deepEqual(embedPickStateMessage("changed"), {
    source: EMBED_SOURCE,
    v: EMBED_VERSION,
    type: "pick-state",
    state: "changed",
  });
});

test("only the framing page's own answer about a numbered pick is read", () => {
  const held = { source: EMBED_SOURCE, v: EMBED_VERSION, type: "held", seq: 2, state: "kept" };
  assert.deepEqual(readHeld(PAPER, held, [PAPER]), { seq: 2, state: "kept" });
  assert.deepEqual(readHeld(PAPER, { ...held, state: "failed" }, [PAPER]), { seq: 2, state: "failed" });
  assert.deepEqual(readHeld(PAPER, { ...held, state: "released" }, [PAPER]), { seq: 2, state: "released" });
  assert.equal(readHeld("https://evil.example", held, [PAPER]), null);
  assert.equal(readHeld(PAPER, { ...held, v: 2 }, [PAPER]), null);
  assert.equal(readHeld(PAPER, { ...held, source: "someone-else" }, [PAPER]), null);
  assert.equal(readHeld(PAPER, { ...held, type: "init" }, [PAPER]), null);
  for (const seq of [0, -1, 1.5, "2", null, undefined, Number.NaN]) {
    assert.equal(readHeld(PAPER, { ...held, seq }, [PAPER]), null, String(seq));
  }
  for (const state of ["ok", "", null, undefined, true]) {
    assert.equal(readHeld(PAPER, { ...held, state }, [PAPER]), null, String(state));
  }
  assert.equal(readHeld(PAPER, "held", [PAPER]), null);
  assert.equal(readHeld(PAPER, null, [PAPER]), null);
  // an "init" is not a "held", and the other way round
  assert.equal(readInit(PAPER, held, [PAPER]), null);
});

test("an open editor is something else until its design is used — once something was sent", () => {
  const sent = embedPickKey("googly", { type: "shopify", design: "HBD01" });
  assert.equal(embedPickState({ sentKey: sent, nowKey: sent, waiting: false, editing: true }), "changed");
  assert.equal(embedPickState({ sentKey: sent, nowKey: sent, waiting: false, editing: false }), "current");
  // with nothing sent there is nothing to be different from
  assert.equal(embedPickState({ sentKey: null, nowKey: sent, waiting: false, editing: true }), "none");
  // and a pick waiting for its print file is still "saving"
  assert.equal(embedPickState({ sentKey: sent, nowKey: sent, waiting: true, editing: true }), "saving");
});

test("only the answer about the latest pick changes what is remembered as sent", () => {
  const { embedSentAfterHeld } = embed;
  const sent = { key: "googly|shopify:HBD01", seq: 3, held: "sent" };
  assert.deepEqual(embedSentAfterHeld(sent, { seq: 3, state: "kept" }), { ...sent, held: "kept" });
  assert.deepEqual(embedSentAfterHeld(sent, { seq: 3, state: "failed" }), { ...sent, held: "failed" });
  // a failed pick that Paper then manages to keep (its "Try again") is kept
  assert.deepEqual(
    embedSentAfterHeld({ ...sent, held: "failed" }, { seq: 3, state: "kept" }),
    { ...sent, held: "kept" },
  );
  // let go again: nothing is sent any more
  assert.equal(embedSentAfterHeld(sent, { seq: 3, state: "released" }), null);
  // an answer about an older (or any other) pick changes nothing
  for (const state of ["kept", "failed", "released"]) {
    assert.equal(embedSentAfterHeld(sent, { seq: 2, state }), sent, state);
    assert.equal(embedSentAfterHeld(sent, { seq: 4, state }), sent, state);
  }
  // and with nothing sent there is nothing to answer
  assert.equal(embedSentAfterHeld(null, { seq: 1, state: "kept" }), null);
});

test("a choice is numbered when it is sent, and unnumbered otherwise", () => {
  const graphic = { kind: "shopify", design: "HBD01", title: "Confetti Birthday", art: "https://cdn.shopify.com/a.png" };
  const base = { style: { id: "googly", name: "Googly" }, graphic, messageCard: null, preview: null };
  assert.equal(embedChoiceMessage({ ...base, seq: 7 }).seq, 7);
  assert.equal(embedChoiceMessage(base).seq, null);
});

/* --- /embed/design?side=inside: the card inside the box ------------------------ */

const { embedEditorStyle, embedSide } = await import("../src/lib/embed.ts");

test("only ?side=inside makes the inside card; anything else is the front label", () => {
  assert.equal(embedSide("inside"), "inside");
  assert.equal(embedSide(" Inside "), "inside");
  for (const other of [null, undefined, "", "front", "outside", "insides", "1"]) {
    assert.equal(embedSide(other), "front", String(other));
  }
});

test("the inside card's editor is given no box photo, so it works flat", () => {
  const style = { id: "googly", name: "Googly", boxImageUrl: "https://x/box.png", logoZone: { x: 0.2 }, inStock: true };
  assert.deepEqual(embedEditorStyle(style, "inside"), { ...style, boxImageUrl: null, logoZone: null });
  // the front label's editor gets the style untouched, and nothing is changed in place
  assert.equal(embedEditorStyle(style, "front"), style);
  assert.equal(style.boxImageUrl, "https://x/box.png");

  const page = readFileSync(new URL("../src/app/embed/design/page.tsx", import.meta.url), "utf8");
  assert.ok(page.includes("embedEditorStyle(style, side)"), "the page no longer strips the box photo for the inside card");
});

test("the editor's text box names the card being made — the front, for every shopper", () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const editor = read("../src/app/design/editor.tsx");
  // The default is the front, and the front's words are the ones shoppers have always seen.
  assert.match(editor, /\n  surface = "front",\n/);
  assert.ok(editor.includes('"Type the words for the front"'));
  assert.ok(editor.includes('"Words for the front of the box"'));
  assert.ok(editor.includes('"Type the words for the message graphic"'));

  // Only the staff embed says which card it is; the journey never does.
  assert.ok(read("../src/app/embed/design/embed-design.tsx").includes("surface={side}"));
  const tsx = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) tsx.push(full);
    }
  };
  walk(new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const passers = tsx
    .filter((file) => /\bsurface=\{/.test(readFileSync(file, "utf8")))
    .map((file) => file.replace(/\\/g, "/").replace(/^.*\/src\//, "src/"))
    .sort();
  assert.deepEqual(passers, [
    "src/app/design/editor-shell.tsx", // hands it on
    "src/app/embed/design/embed-design.tsx", // the staff embed
    "src/v2/design/editor-view.tsx", // hands it on
  ]);
});
