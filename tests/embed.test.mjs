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
