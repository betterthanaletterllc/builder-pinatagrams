#!/usr/bin/env node
// Checks public/graphics.json against what Paper can actually print.
//
// Every library `art` URL becomes the draft order's `_frontGraphic` line
// attribute. Builder lines (CUSTOM-* SKUs) go through Paper's builder-art
// snapshot (apps/backend/src/server/utils/builder-art), which only accepts
// https://cdn.shopify.com/ (or the builder blob) and only image/png,
// image/jpeg or image/webp bodies — an SVG or a non-URL value is refused and
// the line's FRONT becomes the DO-NOT-FULFILL sentinel label. Paper's print
// view itself renders SVG fine: theme orders print the product's
// graphics/front metafield as-is, SVG included. The gate is builder-only.
//
//   node scripts/check-graphics.mjs          # structural checks, no network
//   node scripts/check-graphics.mjs --live   # also HEAD every art URL and
//                                            # compare the served content-type
//
// Exit code 1 when any entry fails; naming warnings never fail the run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, "../public/graphics.json");
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));

const ART_HOST_RE = /^https:\/\/cdn\.shopify\.com\//;
// Mirrors Paper's ALLOWED_ART_CONTENT_TYPES (apps/backend/src/server/utils/builder-art).
const RASTER_EXT = new Set(["png", "jpg", "jpeg", "webp"]);
const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// Front files whose NAME says "message" but whose CONTENT is the front art.
// Verified 2026-10-16 by opening each PNG next to the design's 2023
// *_front_graphic.svg / *_message_graphic.svg pair: identical to the front.
// Shopify's graphics/front metafield points at these same files, so Paper has
// printed them as fronts since 2024-10-13. Leave them until the files are
// re-uploaded under *_front.png names — do NOT "fix" them to the SVGs: the
// builder-art snapshot gate would turn every builder order into a sentinel.
const VERIFIED_FRONT_DESPITE_NAME = new Set([
  "HBD01-GOOGLY_message.png",
  "HBD06-STANDARD_message.png",
  "ANNI01-TROPICAL_message.png",
  "WED02-BRIDE_message.png",
  "WED03-PINK_UNICORN_message.png",
]);

const live = process.argv.includes("--live");
const fileName = (url) => (url ?? "").split("?")[0].split("/").pop() ?? "";
const ext = (url) => fileName(url).split(".").pop()?.toLowerCase() ?? "";

const errors = [];
const warnings = [];
const graphics = manifest.graphics ?? [];

for (const g of graphics) {
  const where = `${g.design} (${g.title})`;
  if (typeof g.art !== "string" || !g.art) {
    errors.push(`${where}: art is missing`);
    continue;
  }
  if (!ART_HOST_RE.test(g.art)) errors.push(`${where}: art host is not cdn.shopify.com — ${g.art}`);
  if (!RASTER_EXT.has(ext(g.art)))
    errors.push(`${where}: art is .${ext(g.art) || "?"}, Paper's builder-art snapshot accepts png/jpg/webp only — ${fileName(g.art)}`);
  const name = fileName(g.art);
  if (/message/i.test(name) && !VERIFIED_FRONT_DESPITE_NAME.has(name))
    warnings.push(`${where}: front art file is named like a message card — ${name} (open it and confirm it is the front)`);
}

// Same design code twice would make the checkout's by-design lookup ambiguous.
const seen = new Map();
for (const g of graphics) {
  if (seen.has(g.design)) errors.push(`${g.design}: listed twice (${seen.get(g.design)} / ${g.title})`);
  seen.set(g.design, g.title);
}

if (live) {
  const batch = 8;
  const list = graphics.filter((g) => typeof g.art === "string" && ART_HOST_RE.test(g.art));
  for (let i = 0; i < list.length; i += batch) {
    await Promise.all(
      list.slice(i, i + batch).map(async (g) => {
        try {
          const res = await fetch(g.art, { method: "HEAD", signal: AbortSignal.timeout(15000) });
          const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
          if (!res.ok) errors.push(`${g.design}: art returns HTTP ${res.status} — ${fileName(g.art)}`);
          else if (!RASTER_TYPES.has(type)) errors.push(`${g.design}: art is served as ${type} — ${fileName(g.art)}`);
        } catch (e) {
          errors.push(`${g.design}: HEAD failed (${e instanceof Error ? e.message : e}) — ${fileName(g.art)}`);
        }
      }),
    );
    process.stderr.write(`\rchecked ${Math.min(i + batch, list.length)}/${list.length}`);
  }
  process.stderr.write("\n");
}

console.log(`graphics.json: ${graphics.length} library designs, ${(manifest.products ?? []).length} products (generated ${manifest.generatedAt ?? "?"})`);
for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`FAIL  ${e}`);
console.log(`${errors.length} failing, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);
