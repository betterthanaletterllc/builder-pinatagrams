import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { embedBodyToken } from "../src/lib/embed.ts";
import { offeredStyles } from "../src/lib/hub.ts";
import {
  checkoutVariantVerdict,
  createVariantBook,
  customSkuFor,
  DISPLAY_RETRY_MS,
  SEEN_IN_STORE,
  sellableNote,
  sellableStyles,
  styleSkus,
  VARIANTS_KEEP_MS,
  VARIANTS_TTL_MS,
  variantsForCheckout,
  variantsForDisplay,
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
 * order ([id, name]), and the SKUs of the product's 19 variants in the store
 * (compared character for character with what customSkuFor gives). A test
 * cannot know what either will hold tomorrow: after a change here, look at
 * the live style sheet.
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
/** What the pages hand the rule: the hub's styles, minus the ones left out by name. */
const listed = (extra = []) => offeredStyles([...hubStyles(), ...extra]);

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
  for (const id of [...HUB_STYLES.map(([id]) => id), "some-new-style", "constructor", "toString"]) {
    const sku = customSkuFor(id);
    assert.equal(sku.split("-").length, 2, sku);
    assert.match(sku, /^CUSTOM-[A-Z0-9 ]+$/, `${id} → ${sku}`);
    // the embed's copy of the rule (what Paper is told for a sample) agrees
    assert.equal(sku, `CUSTOM-${embedBodyToken(id)}`, id);
  }
  assert.deepEqual(styleSkus([style("googly"), {}, null, { id: 7 }, style("white-uni")]), [
    "CUSTOM-GOOGLY",
    "CUSTOM-WHITE UNICORN",
  ]);
});

/* --- which styles are listed --------------------------------------------------- */

test("with the store's list, the hub's 21 styles come down to the 19 it can sell", () => {
  // the sellable rule alone drops the two with no variant…
  assert.deepEqual(ids(sellableStyles(hubStyles(), STORE)), SOLD_IDS);
  // …and so does it after the by-name rule has had its say (what the pages do)
  assert.deepEqual(ids(sellableStyles(listed(), STORE)), SOLD_IDS);
});

test("a style ticked active in the hub is not listed until the store has its variant", () => {
  const withNew = listed([style("glitter", "Glitter")]);
  assert.equal(ids(sellableStyles(withNew, STORE)).includes("glitter"), false);
  const storeWithIt = variants([...STORE_SKUS, "CUSTOM-GLITTER"]);
  assert.deepEqual(ids(sellableStyles(withNew, storeWithIt)), [...SOLD_IDS, "glitter"]);
});

test("a variant alone does not bring back a style the builder leaves out by name", () => {
  // Checkered needs its photos too (lib/hub's list); the Chonky is never sold here.
  const storeWithBoth = variants([...STORE_SKUS, "CUSTOM-CHECKERED", "CUSTOM-CHONKY"]);
  assert.deepEqual(ids(sellableStyles(listed(), storeWithBoth)), SOLD_IDS);
});

test("a style whose variant is deleted goes from the list", () => {
  const without = variants(STORE_SKUS.filter((sku) => sku !== "CUSTOM-MONEY"));
  assert.deepEqual(ids(sellableStyles(hubStyles(), without)), SOLD_IDS.filter((id) => id !== "money"));
});

test("a SKU matches exactly, as it must at checkout — a near miss is no variant", () => {
  const odd = variants(["Custom-Googly", "CUSTOM-GOOGLY ", "CUSTOM_TROPICAL", "CUSTOM-STAR-SPANGLED", "CUSTOM-PRIDE"]);
  assert.deepEqual(ids(sellableStyles(hubStyles(), odd)), ["pride"]);
});

test("the store's list not known: every style is listed, as before", () => {
  const styles = hubStyles();
  const all = sellableStyles(styles, null);
  assert.deepEqual(ids(all), ids(styles));
  assert.notEqual(all, styles, "the caller's own array was handed back");
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
  const catalog = { bodyStyles: listed(), asOf: "x" };
  for (const list of [STORE, SEEN_IN_STORE, null]) {
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

test("a hidden style is named in the server log, with the SKU it needs — and only there", () => {
  const out = withSellableStyles({ bodyStyles: listed([style("glitter"), style("star-burst")]) }, STORE);
  const note = sellableNote(out, 21);
  assert.equal(note.level, "warn");
  assert.match(note.line, /^\[sellable\] not listed/);
  assert.ok(note.line.includes('glitter (needs SKU "CUSTOM-GLITTER")'), note.line);
  assert.ok(note.line.includes('star-burst (needs SKU "CUSTOM-STAR BURST")'), note.line);
  // the same situation has the same key, so it is said once, not per page view
  assert.equal(sellableNote(out, 21).key, note.key);
  // nothing left out: nothing to say
  assert.equal(sellableNote(withSellableStyles({ bodyStyles: listed() }, STORE), 19), null);
  assert.equal(sellableNote({ leftOut: [], disbelieved: false }, 0), null);
  // a list that was not believed is an error, and says what checkout answers
  const loud = sellableNote({ leftOut: [], disbelieved: true }, 19);
  assert.equal(loud.level, "error");
  assert.match(loud.line, /match none of the hub's 19 body styles/);
  // a row that is not a style must not break the log line (it took the page down)
  const odd = sellableNote({ leftOut: [{}, null, { id: 7 }, style("glitter")], disbelieved: false }, 4);
  assert.ok(odd.line.includes("a row with no id"));
  assert.ok(odd.line.includes("glitter"));
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
  /** A book that already holds the store's list. */
  const learn = async (value = STORE) => {
    const got = book.current();
    await answer(value);
    await got;
  };
  return { asked, clock, book, answer, learn };
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

test("checkouts that ask at the same moment share one question, and a page may ride on it", async () => {
  const { asked, book, answer } = fakeStore();
  const all = [book.current(), book.current(), book.recheck()];
  await tick();
  const page = book.refresh();
  assert.ok(page, "the page was not given the open question");
  await answer(STORE);
  for (const got of await Promise.all([...all, page])) assert.equal(got, STORE);
  assert.equal(asked.length, 1);
});

test("a checkout never rides on a page's question", async () => {
  const { asked, book } = fakeStore();
  const page = book.refresh();
  await tick();
  assert.equal(asked.length, 1);
  // the page has gone and its question hangs; an order asks for itself
  const order = book.current();
  await tick();
  assert.equal(asked.length, 2, "checkout joined the page's question");
  asked[1].resolve(STORE);
  assert.equal(await order, STORE);
  // …and the page's question, whenever it ends, breaks nothing
  asked[0].reject(new Error("socket hang up"));
  assert.equal(await page, null);
  assert.equal(await book.current(), STORE);
});

test("a store that cannot be read is null to checkout, and is not remembered", async () => {
  for (const fail of [(d) => d.resolve(null), (d) => d.reject(new Error("timeout"))]) {
    const { asked, book } = fakeStore();
    const first = book.current();
    await tick();
    fail(asked[0]);
    assert.equal(await first, null);
    assert.equal(book.held(), null);
    // the next checkout asks again at once, and gets the answer
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
  assert.equal(await book.recheck(), null);
  assert.equal(book.held(), null);
});

test("an empty answer is real to checkout, but never kept and never shown", async () => {
  const { book, answer } = fakeStore();
  const first = book.current();
  await answer(new Map());
  assert.equal((await first).size, 0);
  // not kept: an empty list kept ten minutes would hide every style after the fix
  assert.equal(book.held(), null);
  const page = book.refresh();
  assert.equal(page, null, "the pages asked a store that had just given no list");
});

test("before refusing a body, checkout asks again — unless the list is seconds old", async () => {
  const { asked, clock, book, answer, learn } = fakeStore();
  await learn();
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
  assert.equal(book.held().variants, newer);
  // the store unreadable on the second look: null, for checkout to keep its list
  clock.t += 60_000;
  const third = book.recheck();
  await answer(null);
  assert.equal(await third, null);
  assert.equal(await book.current(), newer);
});

test("what a page can go by without asking: the last list, for a day", async () => {
  const { clock, book, learn } = fakeStore();
  assert.equal(book.held(), null);
  await learn();
  assert.deepEqual(book.held(), { variants: STORE, stale: false });
  clock.t += VARIANTS_TTL_MS;
  assert.deepEqual(book.held(), { variants: STORE, stale: true });
  clock.t += VARIANTS_KEEP_MS - VARIANTS_TTL_MS - 1;
  assert.equal(book.held().stale, true);
  clock.t += 1;
  assert.equal(book.held(), null, "a list a day old still decided what is listed");
});

test("the pages ask the store only when there is a point", async () => {
  const { asked, clock, book, answer } = fakeStore();
  // nothing held: one question, however many pages
  const a = book.refresh();
  const b = book.refresh();
  await tick();
  assert.ok(a && b);
  assert.equal(asked.length, 1);
  await answer(STORE);
  assert.equal(await a, STORE);
  // a list within its ten minutes: no question at all
  assert.equal(book.refresh(), null);
  clock.t += VARIANTS_TTL_MS - 1;
  assert.equal(book.refresh(), null);
  assert.equal(asked.length, 1);
  // past them: one question, behind the page — the list it holds is still there to go by
  clock.t += 1;
  const behind = book.refresh();
  assert.ok(behind);
  assert.equal(book.held().variants, STORE);
  const newer = variants([...STORE_SKUS, "CUSTOM-GLITTER"]);
  await answer(newer);
  assert.equal(await behind, newer);
  assert.equal(book.held().variants, newer);
  assert.equal(asked.length, 2);
});

test("a store that is down is not asked again on every page view", async () => {
  const { asked, clock, book, answer } = fakeStore();
  const first = book.refresh();
  await answer(null);
  assert.equal(await first, null);
  // five page views in the next half minute: no question
  for (let i = 0; i < 5; i++) {
    clock.t += 5_000;
    assert.equal(book.refresh(), null);
  }
  assert.equal(asked.length, 1);
  // after that the pages try again
  clock.t += DISPLAY_RETRY_MS;
  const again = book.refresh();
  assert.ok(again);
  await answer(STORE);
  assert.equal(await again, STORE);
  assert.equal(asked.length, 2);
  // an order in the meantime would have asked at once: checkout does not back off
  const { asked: asked2, book: book2, answer: answer2 } = fakeStore();
  const failed = book2.refresh();
  await answer2(null);
  await failed;
  const order = book2.current();
  await answer2(STORE);
  assert.equal(await order, STORE);
  assert.equal(asked2.length, 2);
});

test("a hung store costs one page a short wait, not every page", async () => {
  const { asked, clock, book, answer } = fakeStore();
  assert.equal(await book.answerWithin(30), null, "there was no question to wait on");
  book.refresh();
  await tick();
  // the first page waits its 30ms and gives up
  const started = Date.now();
  assert.equal(await book.answerWithin(30), null);
  assert.ok(Date.now() - started >= 20, "the first page did not wait at all");
  // the question has now been open that long: the next pages do not wait again
  clock.t += 30;
  const again = Date.now();
  assert.equal(await book.answerWithin(30), null);
  assert.equal(await book.answerWithin(30), null);
  assert.ok(Date.now() - again < 20, "a later page waited on the same hung question");
  assert.equal(asked.length, 1);
  // the slow answer still lands, for the pages after it
  await answer(STORE);
  assert.equal(book.held().variants, STORE);
});

test("an answer that comes in time is the answer; an empty one is not", async () => {
  const { book, answer } = fakeStore();
  book.refresh();
  const waiting = book.answerWithin(500);
  await answer(STORE);
  assert.equal(await waiting, STORE);

  const { book: book2, answer: answer2 } = fakeStore();
  book2.refresh();
  const waiting2 = book2.answerWithin(500);
  await answer2(new Map());
  assert.equal(await waiting2, null);
});

/* --- which list a page goes by -------------------------------------------------- */

/** A page render, as lib/sellable-server does it: ask if there is a point, then decide. */
async function page(book, styles, waitMs = 30) {
  book.refresh();
  return variantsForDisplay({ book, styles, seen: SEEN_IN_STORE, waitMs });
}

test("the shortcut list is exactly what the store had, and every entry is a style's SKU", () => {
  assert.deepEqual([...SEEN_IN_STORE].sort(), [...STORE_SKUS].sort());
  assert.deepEqual([...SEEN_IN_STORE].sort(), SOLD_IDS.map(customSkuFor).sort());
});

test("a page with a list in hand never waits on the store — fresh or a day old", async () => {
  const { asked, clock, book, answer, learn } = fakeStore();
  await learn();
  assert.deepEqual(await page(book, listed()), { variants: STORE, from: "store" });
  assert.equal(asked.length, 1);
  // eleven minutes on, the store hung: the page goes by the list it has, at once
  clock.t += 11 * 60_000;
  const started = Date.now();
  assert.deepEqual(await page(book, listed(), 2_000), { variants: STORE, from: "last" });
  assert.ok(Date.now() - started < 200, "the page waited on the store");
  assert.equal(asked.length, 2, "the list was not refreshed behind the page");
  // …and the next page has the new one
  const newer = variants(STORE_SKUS.filter((sku) => sku !== "CUSTOM-MONEY"));
  await answer(newer);
  assert.deepEqual(await page(book, listed()), { variants: newer, from: "store" });
});

test("a server that has just started does not wait either, while every listed style is a known one", async () => {
  const { asked, book, answer } = fakeStore();
  const started = Date.now();
  const got = await page(book, listed(), 2_000);
  assert.ok(Date.now() - started < 200, "the page waited on the store");
  assert.equal(got.from, "seen");
  assert.deepEqual(ids(sellableStyles(listed(), got.variants)), SOLD_IDS);
  // the store was asked all the same, behind the page — its answer is the rule from then on
  await tick();
  assert.equal(asked.length, 1);
  const without = variants(STORE_SKUS.filter((sku) => sku !== "CUSTOM-MONEY"));
  await answer(without);
  assert.deepEqual(await page(book, listed()), { variants: without, from: "store" });
});

test("a style the shortcut does not know makes a just-started server ask the store first", async () => {
  const withNew = listed([style("glitter", "Glitter")]);
  // the store answers in time: the new style is listed only if it has its variant
  for (const [store, expectListed] of [
    [STORE, false],
    [variants([...STORE_SKUS, "CUSTOM-GLITTER"]), true],
  ]) {
    const { book, answer } = fakeStore();
    const rendering = page(book, withNew, 1_000);
    await answer(store);
    const got = await rendering;
    assert.equal(got.from, "store");
    assert.equal(ids(sellableStyles(withNew, got.variants)).includes("glitter"), expectListed);
  }
  // the store is slow: not known — every style is listed, as before the rule
  const { book } = fakeStore();
  const got = await page(book, withNew, 30);
  assert.deepEqual(got, { variants: null, from: "unknown" });
  assert.deepEqual(ids(sellableStyles(withNew, got.variants)), ids(withNew));
});

test("with the store just found down, that server does not make its pages wait", async () => {
  const withNew = listed([style("glitter", "Glitter")]);
  const { asked, book, answer } = fakeStore();
  const first = page(book, withNew, 1_000);
  await answer(null);
  assert.equal((await first).from, "unknown");
  const started = Date.now();
  assert.equal((await page(book, withNew, 1_000)).from, "unknown");
  assert.ok(Date.now() - started < 200, "the page waited on a store that had just failed");
  assert.equal(asked.length, 1);
});

/* --- checkout's two decisions ----------------------------------------------------- */

test("checkout looks twice before it refuses a body — and only then", async () => {
  let looks = 0;
  const second = (value) => async () => {
    looks++;
    return value;
  };
  const googly = customSkuFor("googly");
  const glitter = "CUSTOM-GLITTER";
  const newer = variants([...STORE_SKUS, glitter]);
  // every body is on the list: no second look
  assert.equal(await variantsForCheckout(STORE, [googly, googly], second(newer)), STORE);
  assert.equal(looks, 0);
  // one is not: the store is asked once more, and a variant added since is found
  assert.equal(await variantsForCheckout(STORE, [googly, glitter], second(newer)), newer);
  assert.equal(looks, 1);
  // the second look could not be read, or came back empty: the first list stands
  assert.equal(await variantsForCheckout(STORE, [glitter], second(null)), STORE);
  assert.equal(await variantsForCheckout(STORE, [glitter], second(new Map())), STORE);
  assert.equal(looks, 3);
  // no list, or an empty one, to begin with: nothing to look up twice
  assert.equal(await variantsForCheckout(null, [googly], second(newer)), null);
  const empty = new Map();
  assert.equal(await variantsForCheckout(empty, [googly], second(newer)), empty);
  assert.equal(looks, 3);
});

test("what checkout does with the list: go, refuse a piñata by name, or the store's trouble", () => {
  const offeredSkus = SOLD_IDS.map(customSkuFor);
  const googly = customSkuFor("googly");
  const money = customSkuFor("money");
  // every piñata can be sold
  assert.deepEqual(checkoutVariantVerdict({ variants: STORE, offeredSkus, lineSkus: [googly, money, googly] }), {
    go: true,
    missing: [],
  });
  // one body has lost its variant: that piñata is refused, the others are fine
  const withoutMoney = variants(STORE_SKUS.filter((sku) => sku !== money));
  assert.deepEqual(
    checkoutVariantVerdict({ variants: withoutMoney, offeredSkus, lineSkus: [googly, money, money] }),
    { go: true, missing: [money] },
  );
  // the store's trouble, never a piñata's:
  assert.deepEqual(checkoutVariantVerdict({ variants: null, offeredSkus, lineSkus: [googly] }), {
    go: false,
    why: "unreadable",
  });
  assert.deepEqual(checkoutVariantVerdict({ variants: new Map(), offeredSkus, lineSkus: [googly] }), {
    go: false,
    why: "empty",
  });
  // every SKU renamed: telling a Googly buyer to "swap its style" would send them in a circle
  const renamed = variants(STORE_SKUS.map((sku) => sku.replace("CUSTOM-", "BUILT-")));
  assert.deepEqual(checkoutVariantVerdict({ variants: renamed, offeredSkus, lineSkus: [googly] }), {
    go: false,
    why: "matches-nothing",
  });
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

/** The file's code: comments out, line endings and runs of white space evened. */
const code = (text) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");

const sources = sourceFiles(SRC).map((path) => ({
  path: decodeURIComponent(path.href.slice(SRC.href.length)),
  code: code(readFileSync(path, "utf8")),
}));
const source = (path) => {
  const hit = sources.find((f) => f.path === path);
  assert.ok(hit, `${path} is gone — this guard needs a look`);
  return hit.code;
};
const calling = (name) =>
  sources
    .filter((f) => new RegExp(`\\b${name}\\(`).test(f.code))
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

test("source guard: the sellable catalog is built from the tested pieces, and only on a server", () => {
  const server = source("lib/sellable-server.ts");
  assert.ok(server.trimStart().startsWith('import "server-only";'), "the store's keys must never reach a browser bundle");
  assert.ok(server.includes("createVariantBook(lookupCustomVariants)"));
  for (const piece of ["book.refresh()", "keepAliveFor(question)", "variantsForDisplay({", "seen: SEEN_IN_STORE", "withSellableStyles(catalog, variants)", "sellableNote(result,"]) {
    assert.ok(server.includes(piece), `getSellableCatalog no longer uses ${piece}`);
  }
  // without the store's keys it is the hub's catalog, untouched
  assert.ok(server.includes("if (!shopifyCreds()) return getCatalog(opts);"));
  const wait = /const DISPLAY_WAIT_MS = (\d[\d_]*);/.exec(server)?.[1];
  assert.ok(wait && Number(wait.replace(/_/g, "")) <= 2_000, "a page may wait on the store for two seconds at most");
  // the rule itself stays loadable everywhere, these tests included
  assert.equal(/\bimport\b[^;]*\bfrom\b/.test(source("lib/sellable.ts")), false, "lib/sellable grew an import");
});

test("source guard: checkout decides with the tested rules, before anything is created", () => {
  const checkout = source("app/api/checkout/route.ts");
  for (const name of ["checkoutVariantVerdict", "customSkuFor", "variantsForCheckout"]) {
    assert.match(checkout, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "@/lib/sellable";`), name);
  }
  // no list, no SKU rule and no product id of its own any more
  assert.equal(/variantCache|customVariantsBySku|CUSTOM_PRODUCT_GID|SKU_SUFFIX_SPECIAL/.test(checkout), false);
  // the list it goes by: the shared one, looked up once more before a body is refused
  assert.ok(checkout.includes("creds ? customVariants() : Promise.resolve(null)"));
  assert.match(checkout, /variantsForCheckout\( ?await customVariantsP, lineSkus, recheckCustomVariants,? ?\)/);
  // the verdict is asked about every style sold here and every piñata in the cart
  assert.match(checkout, /checkoutVariantVerdict\(\{ variants: variantBySku, offeredSkus: \[\.\.\.styleById\.keys\(\)\]\.map\(customSkuFor\), lineSkus,? \}\)/);
  // the store's trouble: the usual answer, nothing created
  const stop = checkout.indexOf("if (!verdict.go || !variantBySku || !addonVariants)");
  assert.ok(stop !== -1, "checkout no longer stops when the verdict is no-go");
  assert.ok(checkout.slice(stop, stop + 160).includes("{ error: STORE_UNREACHABLE }, { status: 502 }"));
  // a body with no variant: refused by name, with what to do about it
  const refusal = checkout.indexOf('code: "style_checkout_unavailable"');
  assert.ok(refusal !== -1, "checkout no longer refuses a body it has no variant for");
  assert.ok(checkout.slice(refusal - 200, refusal).includes("noVariant.has(customSkuFor(l.styleId))"));
  assert.ok(checkout.slice(refusal, refusal + 260).includes("can't be ordered right now — swap its style and try again."));
  assert.equal(checkout.includes("Checkout is temporarily unavailable for the"), false);
  // all of it before the first thing is written to the store
  const create = checkout.indexOf("draftOrderCreate(input: $input)");
  assert.ok(stop < refusal && refusal < create);
});
