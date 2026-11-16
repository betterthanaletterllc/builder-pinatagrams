import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { embedBodyToken } from "../src/lib/embed.ts";
import { offeredStyles } from "../src/lib/hub.ts";
import {
  createVariantBook,
  customSkuFor,
  sellableStyles,
  VARIANTS_KEEP_MS,
  VARIANTS_TTL_MS,
  withSellableStyles,
} from "../src/lib/sellable.ts";

/*
 * Nathan, 2026-11-15, asked whether the builder should show only the styles
 * it can sell — after two styles ticked active in the hub had sat in the
 * picker with nobody able to buy one: "Yes, build that".
 *
 * A style is sold as the Custom Built Piñatagram product's CUSTOM-{BODY}
 * variant, so "can sell" is "the store has that variant".
 *
 * Both lists below were read on 2026-11-15: the hub's public catalog, in its
 * order ([id, name]), and the SKUs of the product's 19 variants in the store.
 * A test cannot know what either will hold tomorrow: after a change here,
 * look at the live style sheet.
 */
const HUB_STYLES = [
  ["standard", "Standard"], ["googly", "Googly"], ["tropical", "Tropical"], ["pride", "Pride"],
  ["nurse", "Nurse"], ["doctor", "Doctor"], ["grad", "Grad"], ["star-spangled", "Star Spangled"],
  ["reindeer", "Reindeer"], ["vampire", "Vampire"], ["camo", "Camo"], ["white-uni", "White Uni"],
  ["pink-uni", "Pink Uni"], ["red", "Red"], ["blue", "Blue"], ["purple", "Purple"],
  ["orange", "Orange"], ["green", "Green"], ["money", "Money"], ["checkered", "Checkered"],
  ["chonky", "Chonky"],
];
const STORE_SKUS = [
  "CUSTOM-STANDARD", "CUSTOM-GOOGLY", "CUSTOM-TROPICAL", "CUSTOM-PRIDE", "CUSTOM-NURSE",
  "CUSTOM-DOCTOR", "CUSTOM-GRAD", "CUSTOM-STAR SPANGLED", "CUSTOM-REINDEER", "CUSTOM-VAMPIRE",
  "CUSTOM-CAMO", "CUSTOM-WHITE UNICORN", "CUSTOM-PINK UNICORN", "CUSTOM-RED", "CUSTOM-BLUE",
  "CUSTOM-PURPLE", "CUSTOM-ORANGE", "CUSTOM-GREEN", "CUSTOM-MONEY",
];

const style = (id, name = id) => ({ id, name, imageUrl: null, boxImageUrl: null, logoZone: null, inStock: true });
const hubStyles = () => HUB_STYLES.map(([id, name]) => style(id, name));
const variants = (skus) => new Map(skus.map((sku, i) => [sku, `gid://shopify/ProductVariant/${i + 1}`]));
const STORE = variants(STORE_SKUS);
const ids = (styles) => styles.map((s) => s.id);
const SOLD_IDS = HUB_STYLES.map(([id]) => id).filter((id) => id !== "checkered" && id !== "chonky");

/* --- the SKU a body is sold under --------------------------------------------- */

test("every style the builder lists today is one the store has a variant for, and the other way round", () => {
  const skus = SOLD_IDS.map(customSkuFor);
  // each of the 19 has its variant…
  for (const [i, sku] of skus.entries()) assert.ok(STORE.has(sku), `${SOLD_IDS[i]} → ${sku} is not in the store`);
  // …no two share one, and no variant in the store is left without a style
  assert.equal(new Set(skus).size, 19);
  assert.deepEqual([...skus].sort(), [...STORE_SKUS].sort());
});

test("the SKU is CUSTOM- and the body as Paper names it: spaces, never hyphens", () => {
  assert.equal(customSkuFor("googly"), "CUSTOM-GOOGLY");
  assert.equal(customSkuFor("star-spangled"), "CUSTOM-STAR SPANGLED");
  assert.equal(customSkuFor("white-uni"), "CUSTOM-WHITE UNICORN");
  assert.equal(customSkuFor("pink-uni"), "CUSTOM-PINK UNICORN");
  // Paper's parser splits a SKU on its LAST hyphen: there is exactly one
  for (const id of [...HUB_STYLES.map(([id]) => id), "some-new-style"]) {
    const sku = customSkuFor(id);
    assert.equal(sku.split("-").length, 2, sku);
    // the embed's copy of the rule (what Paper is told for a sample) agrees
    assert.equal(sku, `CUSTOM-${embedBodyToken(id)}`, id);
  }
});

/* --- which styles are listed --------------------------------------------------- */

test("with the store's list, the hub's 21 styles come down to the 19 it can sell", () => {
  // the sellable rule alone drops the two with no variant…
  assert.deepEqual(ids(sellableStyles(hubStyles(), STORE)), SOLD_IDS);
  // …and so does it after the by-name rule has had its say (what the pages do)
  assert.deepEqual(ids(sellableStyles(offeredStyles(hubStyles()), STORE)), SOLD_IDS);
});

test("a style ticked active in the hub is not listed until the store has its variant", () => {
  const withNew = [...hubStyles(), style("glitter", "Glitter")];
  assert.equal(ids(sellableStyles(withNew, STORE)).includes("glitter"), false);
  const storeWithIt = variants([...STORE_SKUS, "CUSTOM-GLITTER"]);
  assert.deepEqual(ids(sellableStyles(offeredStyles(withNew), storeWithIt)), [...SOLD_IDS, "glitter"]);
});

test("a variant alone does not bring back a style the builder leaves out by name", () => {
  // Checkered needs its photos too (lib/hub's list); the Chonky is never sold here.
  const storeWithBoth = variants([...STORE_SKUS, "CUSTOM-CHECKERED", "CUSTOM-CHONKY"]);
  assert.deepEqual(ids(sellableStyles(offeredStyles(hubStyles()), storeWithBoth)), SOLD_IDS);
});

test("a style whose variant is deleted goes from the list", () => {
  const without = variants(STORE_SKUS.filter((sku) => sku !== "CUSTOM-MONEY"));
  assert.deepEqual(ids(sellableStyles(hubStyles(), without)), SOLD_IDS.filter((id) => id !== "money"));
});

test("a SKU matches exactly, as it must at checkout", () => {
  const odd = variants(["Custom-Googly", "CUSTOM-GOOGLY ", "CUSTOM_TROPICAL", "CUSTOM-STAR-SPANGLED", "CUSTOM-PRIDE"]);
  assert.deepEqual(ids(sellableStyles(hubStyles(), odd)), ["pride"]);
});

test("the store's list not known: every style is listed, as before", () => {
  const styles = hubStyles();
  const listed = sellableStyles(styles, null);
  assert.deepEqual(ids(listed), ids(styles));
  assert.notEqual(listed, styles, "the caller's own array was handed back");
});

test("a row that is not a style cannot be sold", () => {
  const rows = [style("googly"), { id: null }, {}, null, undefined, style("red")];
  assert.deepEqual(sellableStyles(rows, STORE).map((s) => s.id), ["googly", "red"]);
  assert.deepEqual(sellableStyles([], STORE), []);
});

/* --- the catalog the pages read ------------------------------------------------ */

test("the catalog handed in is never changed — lib/hub keeps it as its last good copy", () => {
  const catalog = { bodyStyles: [...hubStyles(), style("glitter")], asOf: "x" };
  const before = ids(catalog.bodyStyles);
  const out = withSellableStyles(catalog, STORE);
  assert.notEqual(out.catalog, catalog);
  assert.deepEqual(ids(catalog.bodyStyles), before);
  assert.deepEqual(ids(out.catalog.bodyStyles), SOLD_IDS);
  assert.equal(out.catalog.asOf, "x");
  assert.deepEqual(ids(out.leftOut), ["checkered", "chonky", "glitter"]);
  assert.equal(out.disbelieved, false);
});

test("nothing to leave out, or the list not known: the very same catalog", () => {
  const catalog = { bodyStyles: offeredStyles(hubStyles()), asOf: "x" };
  for (const list of [STORE, null]) {
    const out = withSellableStyles(catalog, list);
    assert.equal(out.catalog, catalog);
    assert.deepEqual(out.leftOut, []);
    assert.equal(out.disbelieved, false);
  }
});

test("a store list that matches none of the styles is not believed: the picker is not emptied", () => {
  const catalog = { bodyStyles: hubStyles(), asOf: "x" };
  const renamed = variants(STORE_SKUS.map((sku) => sku.replace("CUSTOM-", "BUILT-")));
  const out = withSellableStyles(catalog, renamed);
  assert.equal(out.catalog, catalog);
  assert.equal(out.disbelieved, true);
  assert.deepEqual(out.leftOut, []);
  // a catalog with no styles at all is not a disagreement
  const none = withSellableStyles({ bodyStyles: [], asOf: "x" }, STORE);
  assert.equal(none.disbelieved, false);
  assert.deepEqual(none.catalog.bodyStyles, []);
});

/* --- the store's list, remembered ---------------------------------------------- */

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

/** A store that answers when the test says so, and a clock the test moves. */
function fakeStore(start = 1_000_000) {
  const asked = [];
  const clock = { t: start };
  const book = createVariantBook(
    () => {
      const d = deferred();
      asked.push(d);
      return d.promise;
    },
    { now: () => clock.t },
  );
  /** Let the question reach the store, then answer the latest one. */
  const answer = async (value) => {
    await tick();
    asked[asked.length - 1].resolve(value);
    await tick();
  };
  return { asked, clock, book, answer };
}

test("checkout's list is asked for once, then kept ten minutes", async () => {
  const { asked, clock, book, answer } = fakeStore();
  const first = book.current();
  await answer(STORE);
  assert.equal(await first, STORE);
  clock.t += VARIANTS_TTL_MS - 1;
  assert.equal(await book.current(), STORE);
  assert.equal(asked.length, 1);
  // ten minutes on, the store is asked again
  clock.t += 1;
  const second = book.current();
  const newer = variants([...STORE_SKUS, "CUSTOM-GLITTER"]);
  await answer(newer);
  assert.equal(await second, newer);
  assert.equal(asked.length, 2);
});

test("callers that ask at the same moment share one question", async () => {
  const { asked, book, answer } = fakeStore();
  const all = [book.current(), book.current(), book.forDisplay(50), book.recheck()];
  await answer(STORE);
  for (const got of await Promise.all(all)) assert.equal(got, STORE);
  assert.equal(asked.length, 1);
});

test("a store that cannot be read is null to checkout, and is not remembered", async () => {
  for (const fail of [(d) => d.resolve(null), (d) => d.reject(new Error("timeout"))]) {
    const { asked, book } = fakeStore();
    const first = book.current();
    await tick();
    fail(asked[0]);
    assert.equal(await first, null);
    // the next checkout asks again, and gets the answer
    const second = book.current();
    await tick();
    assert.equal(asked.length, 2);
    asked[1].resolve(STORE);
    assert.equal(await second, STORE);
  }
});

test("a lookup that throws before it even asks is a store that cannot be read", async () => {
  const book = createVariantBook(() => {
    throw new Error("no keys");
  });
  assert.equal(await book.current(), null);
  assert.equal(await book.forDisplay(10), null);
  assert.equal(await book.recheck(), null);
});

test("an empty answer is real to checkout, but never kept and never shown", async () => {
  const { asked, book, answer } = fakeStore();
  const first = book.current();
  await answer(new Map());
  assert.equal((await first).size, 0);
  // not kept: an empty list kept ten minutes would hide every style after the fix
  const shown = book.forDisplay(50);
  await answer(new Map());
  assert.equal(await shown, null);
  assert.equal(asked.length, 2);
});

test("before refusing a body, checkout asks again — unless the list is seconds old", async () => {
  const { asked, clock, book, answer } = fakeStore();
  const first = book.current();
  await answer(STORE);
  await first;
  // four seconds on: the answer just given stands
  clock.t += 4_000;
  assert.equal(await book.recheck(), STORE);
  assert.equal(asked.length, 1);
  // six seconds on: a variant added since is found
  clock.t += 2_000;
  const again = book.recheck();
  const newer = variants([...STORE_SKUS, "CUSTOM-GLITTER"]);
  await answer(newer);
  assert.equal(await again, newer);
  assert.equal(asked.length, 2);
  // and it is what everyone reads from then on
  assert.equal(await book.current(), newer);
  // the store unreadable on the second look: null, for checkout to keep its list
  clock.t += 60_000;
  const third = book.recheck();
  await answer(null);
  assert.equal(await third, null);
  assert.equal(await book.current(), newer);
});

test("a page never waits long: a slow store with nothing known is 'not known'", async () => {
  const { asked, book, answer } = fakeStore();
  const started = Date.now();
  assert.equal(await book.forDisplay(30), null);
  assert.ok(Date.now() - started < 1_000, "the page waited on the store");
  assert.equal(asked.length, 1);
  // the slow answer still lands, for the next page
  await answer(STORE);
  assert.equal(await book.forDisplay(30), STORE);
  assert.equal(asked.length, 1);
});

test("a page with a list past its ten minutes gets a new one if the store is quick", async () => {
  const { asked, clock, book, answer } = fakeStore();
  const first = book.forDisplay(50);
  await answer(STORE);
  assert.equal(await first, STORE);
  clock.t += VARIANTS_TTL_MS + 1;
  const second = book.forDisplay(50);
  const newer = variants(STORE_SKUS.filter((sku) => sku !== "CUSTOM-MONEY"));
  await answer(newer);
  assert.equal(await second, newer);
  assert.equal(asked.length, 2);
});

test("a slow or failing store leaves the pages on what it last said, for a day", async () => {
  const { asked, clock, book, answer } = fakeStore();
  const first = book.forDisplay(50);
  await answer(STORE);
  await first;

  // an hour on, the store is slow: the last list, not "not known"
  clock.t += 60 * 60_000;
  assert.equal(await book.forDisplay(20), STORE);
  assert.equal(asked.length, 2);
  // …and it fails outright: the same
  await answer(null);
  const failing = book.forDisplay(20);
  await answer(null);
  assert.equal(await failing, STORE);
  // checkout, though, never sells from a list past its ten minutes
  const checkout = book.current();
  await answer(null);
  assert.equal(await checkout, null);

  // a day after the last answer, it is too old to go by
  clock.t += VARIANTS_KEEP_MS;
  const stale = book.forDisplay(20);
  await answer(null);
  assert.equal(await stale, null);
});

/* --- where it is wired --------------------------------------------------------- */

const SRC = new URL("../src/", import.meta.url);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const sources = sourceFiles(SRC).map((path) => ({
  path: decodeURIComponent(path.href.slice(SRC.href.length)),
  text: readFileSync(path, "utf8").replace(/\r\n/g, "\n"),
}));
const source = (path) => {
  const hit = sources.find((f) => f.path === path);
  assert.ok(hit, `${path} is gone — this guard needs a look`);
  return hit.text;
};
const calling = (name) =>
  sources
    .filter(({ text }) => new RegExp(`\\b${name}\\(`).test(text))
    .map((f) => f.path)
    .sort();

test("source guard: every page that lists styles to choose from reads the sellable catalog", () => {
  // The journey, both home pages and the sample page Paper frames. A new
  // page that lists styles has to be added here, deliberately.
  assert.deepEqual(calling("getSellableCatalog"), [
    "app/design/page.tsx",
    "app/embed/sample/page.tsx",
    "app/page.tsx",
    "lib/sellable-server.ts",
    "v2/design/design-page-v2.tsx",
    "v2/home/home-v2.tsx",
  ]);
  // The hub's own list is read in two more places only: where it is made
  // sellable, and the staff editor — which shows the box of the body an
  // order already has, sold here or not.
  assert.deepEqual(
    calling("getCatalog").filter((path) => path !== "lib/hub.ts"),
    ["app/embed/design/page.tsx", "lib/sellable-server.ts"],
  );
});

test("source guard: the sellable catalog is the hub's, the store's list, and the pure rule", () => {
  const server = source("lib/sellable-server.ts");
  assert.ok(server.startsWith('import "server-only";'), "the store's keys must never reach a browser bundle");
  assert.match(server, /const book = createVariantBook\(lookupCustomVariants\);/);
  // the page waits on the hub and — only where the store's keys exist — on
  // the store, for a bounded time
  assert.match(server, /getCatalog\(opts\),\n\s*shopifyCreds\(\) \? book\.forDisplay\(DISPLAY_WAIT_MS\) : null,/);
  const wait = /const DISPLAY_WAIT_MS = (\d[\d_]*);/.exec(server)?.[1];
  assert.ok(wait && Number(wait.replace(/_/g, "")) <= 2_000, "a page may wait on the store for two seconds at most");
  assert.match(server, /withSellableStyles\(catalog, variants\)/);
  // checkout and the pages read the same book
  assert.match(server, /export const customVariants = \(\): Promise<VariantsBySku \| null> => book\.current\(\);/);
  assert.match(server, /export const recheckCustomVariants = \(\): Promise<VariantsBySku \| null> => book\.recheck\(\);/);
  // the rule itself stays loadable everywhere, these tests included
  assert.equal(/^\s*import\s/m.test(source("lib/sellable.ts")), false, "lib/sellable grew an import");
});

test("source guard: checkout reads that list, looks twice before refusing a body, and says the way out", () => {
  const checkout = source("app/api/checkout/route.ts");
  assert.match(checkout, /import \{ customVariants, recheckCustomVariants \} from "@\/lib\/sellable-server";/);
  assert.match(checkout, /const customVariantsP = creds \? customVariants\(\) : Promise\.resolve\(null\);/);
  // no list of its own any more
  assert.equal(/variantCache|customVariantsBySku|CUSTOM_PRODUCT_GID/.test(checkout), false);
  // a body missing from a list that may be minutes old is looked up once more
  assert.match(
    checkout,
    /firstList\?\.size && lines\.some\(\(l\) => !firstList\.has\(customSkuFor\(l\.styleId\)\)\)\n\s*\? \(\(await recheckCustomVariants\(\)\) \?\? firstList\)\n\s*: firstList;/,
  );
  // no list, or an empty one, is the store's trouble — nothing is created
  assert.match(
    checkout,
    /if \(!variantBySku\?\.size \|\| !addonVariants\) \{\n\s*return NextResponse\.json\(\{ error: STORE_UNREACHABLE \}, \{ status: 502 \}\);/,
  );
  // a body with no variant is refused by name, with what to do about it
  const at = checkout.indexOf('code: "style_checkout_unavailable"');
  assert.ok(at !== -1, "checkout no longer refuses a body it has no variant for");
  const refusal = checkout.slice(at, at + 260);
  assert.ok(refusal.includes("can't be ordered right now — swap its style and try again."), refusal);
  // "try again in a minute" was never going to work for a missing variant
  assert.equal(checkout.includes("Checkout is temporarily unavailable for the"), false);
  // and it happens before anything is created in the store
  assert.ok(at < checkout.indexOf("draftOrderCreate(input: $input)"));
});
