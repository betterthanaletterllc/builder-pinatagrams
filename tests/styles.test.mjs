import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { pickEmbedStyle } from "../src/lib/embed.ts";
import { getCatalog, NOT_YET_OFFERED, offeredStyles, styleOffered } from "../src/lib/hub.ts";
import { EXCLUDED_PREFIXES, isOfferedDesign } from "../src/lib/library-data.ts";

/*
 * Nathan, 2026-11-15: "Chonky and checkered should not appear on the
 * builder. chonky never should because it is a completely different product
 * and has different options and checkered shouldn't until we have a photo".
 *
 * Both are active styles in the hub (it stocks and counts them), so the
 * builder itself leaves them out — everywhere it reads the hub's styles.
 *
 * The ids below are the hub's own, read from its public catalog on
 * 2026-11-15. A test cannot know what the hub will call a style tomorrow:
 * after a change here, look at the live style sheet.
 */

const style = (id, extra = {}) => ({
  id,
  name: id,
  imageUrl: `https://hub.example/bodies/${id}.png`,
  boxImageUrl: `https://hub.example/catalog/boxes/${id}.webp`,
  logoZone: { x: 0.2, y: 0.6, w: 0.6, h: 0.3 },
  inStock: true,
  ...extra,
});

// What the hub served on 2026-11-15, in its order: [id, name]. The names
// matter — the Chonky is left out by its name as well as by its id.
const HUB_STYLES = [
  ["standard", "Standard"], ["googly", "Googly"], ["tropical", "Tropical"], ["pride", "Pride"],
  ["nurse", "Nurse"], ["doctor", "Doctor"], ["grad", "Grad"], ["star-spangled", "Star Spangled"],
  ["reindeer", "Reindeer"], ["vampire", "Vampire"], ["camo", "Camo"], ["white-uni", "White Uni"],
  ["pink-uni", "Pink Uni"], ["red", "Red"], ["blue", "Blue"], ["purple", "Purple"],
  ["orange", "Orange"], ["green", "Green"], ["money", "Money"], ["checkered", "Checkered"],
  ["chonky", "Chonky"],
];
const hubStyles = () => HUB_STYLES.map(([id, name]) => style(id, { name }));
const OFFERED_IDS = HUB_STYLES.map(([id]) => id).filter((id) => id !== "chonky" && id !== "checkered");

test("the Chonky and the Checkered are not among the builder's styles", () => {
  const offered = offeredStyles(hubStyles()).map((s) => s.id);
  // nothing else goes, and the hub's order is kept
  assert.deepEqual(offered, OFFERED_IDS);
  assert.equal(offered.length, 19);
});

test("in stock or not, with a photo or not, however the id is written", () => {
  const offered = offeredStyles([
    style("chonky", { inStock: false }),
    style("Chonky"),
    style(" CHECKERED "),
    style("checkered", { boxImageUrl: null, logoZone: null }),
    style("googly"),
  ]);
  assert.deepEqual(offered.map((s) => s.id), ["googly"]);
});

test("never the Chonky: any hub style whose id or name says so", () => {
  // a second Chonky does not walk in the way the first did
  for (const s of [
    { id: "chonky-pink", name: "Pink Chonky" },
    { id: "big-donkey", name: "Chonky Donkey" },
    { id: "chonky_xl", name: "XL" },
    { id: "chonky2", name: "The second one" },
    { id: "the-chonky", name: "The big one" },
    { id: "xl", name: "CHONKY (holiday)" },
  ]) {
    assert.equal(styleOffered(s), false, JSON.stringify(s));
  }
  // …but it is the word, not the letters
  for (const s of [
    { id: "chonk", name: "Chonk" },
    { id: "chonkyish", name: "Chonkyish" },
    { id: "googly", name: "Googly" },
  ]) {
    assert.equal(styleOffered(s), true, JSON.stringify(s));
  }
});

test("not yet the Checkered: that one hub id, and only it", () => {
  assert.deepEqual([...NOT_YET_OFFERED], ["checkered"]);
  assert.equal(styleOffered({ id: "checkered", name: "Checkered" }), false);
  // "red" is inside "checkered"; a style merely named like it is another style
  for (const s of [
    { id: "red", name: "Red" },
    { id: "checkered-flag", name: "Checkered Flag" },
    { id: "racing", name: "Checkered racing" },
  ]) {
    assert.equal(styleOffered(s), true, JSON.stringify(s));
  }
});

test("a row that is not a style is left for the code that always dealt with it", () => {
  const odd = [style("googly"), { id: null }, {}, null, undefined, style("chonky")];
  assert.deepEqual(
    offeredStyles(odd).map((s) => s?.id ?? null),
    ["googly", null, null, null, null],
  );
  assert.deepEqual(offeredStyles([]), []);
  assert.equal(styleOffered(null), true);
});

/* --- the catalog every page reads ------------------------------------------- */

const hubCatalog = () => ({
  bodyStyles: hubStyles(),
  asOf: "2026-11-15T00:00:00.000Z",
});

async function withHub(respond, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => respond();
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test("getCatalog — what every page and the staff embed read — has neither", async () => {
  const host = "styles-test-a.example";
  const catalog = await withHub(() => ok(hubCatalog()), () => getCatalog({ host }));
  assert.deepEqual(catalog.bodyStyles.map((s) => s.id), OFFERED_IDS);
  assert.equal(catalog.stale, undefined);
});

test("nor does the copy served when the hub is down", async () => {
  const host = "styles-test-b.example";
  await withHub(() => ok(hubCatalog()), () => getCatalog({ host }));
  const stale = await withHub(
    () => ({ ok: false, status: 503, json: async () => ({}) }),
    () => getCatalog({ host }),
  );
  assert.ok(stale.stale, "the last good copy was not served");
  assert.deepEqual(stale.bodyStyles.map((s) => s.id), OFFERED_IDS);
});

test("a hub that lists only those two leaves the builder with no styles, not with them", async () => {
  const only = { bodyStyles: [style("chonky"), style("checkered")], asOf: "x" };
  const catalog = await withHub(() => ok(only), () => getCatalog({ host: "styles-test-c.example" }));
  assert.deepEqual(catalog.bodyStyles, []);
});

test("?style=chonky or checkered finds no style of that body among the offered ones", () => {
  // pickEmbedStyle hands back its usual default when it finds none. The
  // journey and the sample page start on that default; the staff editor
  // also drops the default's box (the source guard further down), because a
  // Chonky's label on a Googly's box would be the wrong picture.
  const offered = offeredStyles(hubStyles());
  for (const wanted of ["chonky", "CHONKY", "checkered", "Checkered"]) {
    const got = pickEmbedStyle(offered, wanted);
    assert.equal(got?.id, "googly", wanted);
    assert.notEqual(got?.name.toLowerCase(), wanted.toLowerCase());
  }
  // a body that is offered is still found
  assert.equal(pickEmbedStyle(offered, "tropical")?.id, "tropical");
  assert.equal(pickEmbedStyle(offered, "STAR SPANGLED")?.id, "star-spangled");
});

/* --- every other reader of the hub's styles ---------------------------------- */

const SRC = new URL("../src/", import.meta.url);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const sources = sourceFiles(SRC).map((path) => ({
  // relative to this repo's src/, wherever the checkout itself lives
  path: decodeURIComponent(path.href.slice(SRC.href.length)),
  text: readFileSync(path, "utf8"),
}));
const source = (path) => {
  const hit = sources.find((f) => f.path === path);
  assert.ok(hit, `${path} is gone — this guard needs a look`);
  return hit.text;
};

test("source guard: code that fetches the hub's catalog itself filters the styles too", () => {
  // Anything outside lib/hub that fetches the catalog (by either spelling of
  // its address) AND looks at its styles. Today: checkout — the money path
  // fetches the live catalog itself — and the first journey's style
  // switcher. A new one has to be added here, deliberately.
  const direct = sources
    .filter(({ path }) => path !== "lib/hub.ts")
    .filter(({ text }) => /catalogUrl\(|api\/public\/catalog/.test(text))
    .filter(({ text }) => /\bbodyStyles\b/.test(text))
    .map((f) => f.path)
    .sort();
  assert.deepEqual(direct, ["app/api/checkout/route.ts", "app/design/design-flow.tsx"]);

  const checkout = source("app/api/checkout/route.ts");
  // The table every line is validated against is built from the offered styles…
  assert.match(checkout, /const styleById = new Map\(offeredStyles\(catalog\.bodyStyles\)\.map\(/);
  // …it is the only place checkout reads the hub's styles (the other mention
  // is the "is this a catalog at all" check)…
  assert.equal(checkout.split("catalog.bodyStyles").length - 1, 2, "checkout reads the hub's styles somewhere else");
  // …and a line whose style is not in that table is refused.
  assert.match(checkout, /const style = typeof l\?\.styleId === "string" \? styleById\.get\(l\.styleId\) : undefined;/);
  assert.match(checkout, /if \(!style\) flag\("style_unavailable"/);

  assert.match(
    source("app/design/design-flow.tsx"),
    /setSwitcherStyles\(withBoxZones\(offeredStyles\(\(await r\.json\(\)\)\.bodyStyles \?\? \[\]\)\)\)/,
  );
});

test("source guard: the staff editor gives a body that is not offered no box", () => {
  const page = source("app/embed/design/page.tsx");
  assert.match(page, /const noBox = !!wanted && !styleOffered\(\{ id: wanted, name: wanted \}\);/);
  assert.match(page, /style=\{noBox \? \{ \.\.\.editorStyle, boxImageUrl: null, logoZone: null \} : editorStyle\}/);
});

test("source guard: a piñata in progress whose style left gets another body, out loud", () => {
  const flow = source("v2/design/design-flow-v2.tsx");
  const at = flow.indexOf("if (!hydrated || !draft || stylesById.has(draft.styleId)) return;");
  assert.ok(at !== -1, "the journey no longer checks the piñata in progress against the offered styles");
  const effect = flow.slice(at, at + 400);
  assert.ok(effect.includes("patch({ styleId: data.preset.styleId });"));
  assert.ok(effect.includes("showToast(STYLE_GONE_NOTE);"));
  // one wording, on a page load and on "Edit"
  const restore = source("v2/lib/restore.ts");
  assert.match(restore, /note = STYLE_GONE_NOTE;/);
  const said = /export const STYLE_GONE_NOTE =\s*"([^"]+)";/.exec(restore)?.[1];
  assert.ok(said, "the note's wording was not found");
  // It is said for a style that left as well as for one that sold out.
  assert.equal(/sold out/i.test(said), false, said);
  assert.match(said, /isn't available anymore/);
});

/* --- the design library ------------------------------------------------------ */

const manifest = JSON.parse(readFileSync(new URL("../public/graphics.json", import.meta.url), "utf8"));

test("the Chonky's own store listing is not a design to pick", () => {
  assert.equal(isOfferedDesign("CHONKY01"), false);
  assert.equal(isOfferedDesign(" chonky01 "), false);
  // Every listing the store sells on a Chonky body is out of the library…
  const onChonky = manifest.products.filter((p) => /chonky/i.test(p.bodyStyle ?? ""));
  assert.ok(onChonky.length >= 1, "the store snapshot no longer has the Chonky Donkey");
  for (const p of onChonky) assert.equal(isOfferedDesign(p.design), false, p.design);
  // …and so is anything titled after it.
  const titled = manifest.graphics.filter((g) => /chonky/i.test(g.title));
  assert.ok(titled.length >= 1);
  for (const g of titled) assert.equal(isOfferedDesign(g.design), false, `${g.design} "${g.title}"`);
});

test("everything else in the store snapshot is still a design, checkers and all", () => {
  // The Checkered BODY is what is waiting for a photo; designs with checkers
  // in them, and the ones the store sells on that body, stay.
  for (const design of ["HBD14", "HBD30", "HBD31", "BACKTOSCHOOL09", "SPORTS04"]) {
    assert.ok(manifest.graphics.some((g) => g.design === design), `${design} left the store snapshot`);
    assert.equal(isOfferedDesign(design), true, design);
  }
  // Of the whole snapshot, the rule leaves out exactly one listing.
  const leftOut = manifest.graphics.filter((g) => !isOfferedDesign(g.design)).map((g) => g.design);
  assert.deepEqual(leftOut, ["CHONKY01"]);
  // (The client one-offs are not in this snapshot; their prefixes stay on the list.)
  assert.deepEqual([...EXCLUDED_PREFIXES].sort(), ["BRYNNEIL", "BSG", "CHONKY", "RETENTION"]);
});

test("source guard: every place a store design is shown, and checkout, use that one rule", () => {
  // the occasion strips, best sellers and ?design= (v2, server side)
  assert.match(source("v2/lib/catalog-server.ts"), /\(g\) => !!g\.art && isOfferedDesign\(g\.design\),/);
  // the whole library and its search
  assert.match(source("app/design/graphic-library.tsx"), /\(g\) => isOfferedDesign\(g\.design\),/);
  // the first journey's ?design=
  assert.match(source("app/design/design-flow.tsx"), /if \(!isOfferedDesign\(code\)\) return null;/);
  // checkout: a cart saved while the listing was still a tile
  const checkout = source("app/api/checkout/route.ts");
  const at = checkout.indexOf("if (!isOfferedDesign(design))");
  assert.ok(at !== -1, "checkout no longer refuses a store listing the library leaves out");
  assert.ok(checkout.slice(at, at + 200).includes('code: "graphic_unavailable"'));
  // Whatever loads the store snapshot — today those three — applies the rule.
  const readers = sources.filter(({ text }) => /["'`][^"'`]*graphics\.json["'`]/.test(text));
  assert.deepEqual(
    readers.map((f) => f.path).sort(),
    ["app/design/design-flow.tsx", "app/design/graphic-library.tsx", "v2/lib/catalog-server.ts"],
  );
  for (const { path, text } of readers) {
    assert.ok(text.includes("isOfferedDesign("), `${path} reads the store snapshot without the rule`);
  }
  // Nobody spells the prefix rule by hand any more.
  for (const { path, text } of sources) {
    if (path === "lib/library-data.ts") continue;
    assert.equal(text.includes("EXCLUDED_PREFIXES"), false, `${path} applies the exclusion list itself`);
  }
});
