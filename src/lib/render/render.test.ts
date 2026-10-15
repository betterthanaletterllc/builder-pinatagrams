import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HubBodyStyle, HubCatalog } from "@/lib/hub";
import { clearImageCache, imageHostAllowed, pngSize } from "./images";
import { LABEL, normalizeMessage, renderProbe, RenderInputError } from "./index";
import { escapeXml, layoutText } from "./text";

/**
 * Drives the renderer directly, offline: fetch is stubbed with small
 * copies of the hub's real assets (box photo as WebP — the format resvg
 * can't decode on its own — interior JPEG, piñata cutout PNG with alpha),
 * and the zones are the Standard style's live placements (2026-10-15).
 */

const FIX = path.join(process.cwd(), "src/lib/render/__fixtures__");
const BLOB = "https://ww0dl7zlgzlp6kuj.public.blob.vercel-storage.com/catalog";

const FIXTURES: Record<string, { file: string; type: string }> = {
  [`${BLOB}/boxes/standard.webp`]: { file: "box.webp", type: "image/webp" },
  [`${BLOB}/cutouts/standard.png`]: { file: "cutout.png", type: "image/png" },
  [`${BLOB}/box-interior.jpg`]: { file: "interior.jpg", type: "image/jpeg" },
};

const style: HubBodyStyle = {
  id: "standard",
  name: "Standard",
  imageUrl: `${BLOB}/bodies/standard.webp`,
  boxImageUrl: `${BLOB}/boxes/standard.webp`,
  logoZone: { h: 0.33125, w: 0.6625, x: 0.1734375, y: 0.6533203125 },
  pinataZone: { h: 0.7194, w: 1, x: 0, y: 0.0607 },
  cutoutUrl: `${BLOB}/cutouts/standard.png`,
  inStock: true,
};

const box: HubCatalog["box"] = {
  interiorUrl: `${BLOB}/box-interior.jpg`,
  messageZone: { h: 0.2004, w: 0.6375, x: 0.1703125, y: 0.742 },
  messageCardPadding: { x: 12, y: 7 },
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** pixels-per-metre from the pHYs chunk, or null when there is none. */
function pngPpm(png: Buffer): number | null {
  let pos = 8;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const name = png.toString("ascii", pos + 4, pos + 8);
    if (name === "pHYs") return png.readUInt32BE(pos + 8);
    pos += 12 + len;
  }
  return null;
}

let fetches = 0;

beforeAll(() => {
  clearImageCache();
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const fx = FIXTURES[url];
    if (!fx) return new Response("not a fixture", { status: 404 });
    fetches++;
    const bytes = readFileSync(path.join(FIX, fx.file));
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-type": fx.type, "content-length": String(bytes.length) },
    });
  });
});

afterAll(() => vi.unstubAllGlobals());

describe("renderProbe", () => {
  it("label: a 2400 × 1170 PNG stamped 300 DPI (8 × 3.9 in)", async () => {
    const out = await renderProbe({ style, message: "Happy Birthday, Sam!", view: "label" });
    expect(out.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(pngSize(out.png)).toEqual({ width: LABEL.w, height: LABEL.h });
    expect(out.width).toBe(2400);
    expect(out.height).toBe(1170);
    expect(pngPpm(out.png)).toBe(Math.round(300 / 0.0254)); // 11811
    expect(fetches).toBe(0); // text only — nothing fetched
  });

  it("box: the WebP box photo composited with the label zone ≥ 1200 px wide", async () => {
    const out = await renderProbe({ style, message: "Happy Birthday, Sam!", view: "box" });
    expect(out.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    // scale = 1200 / (0.6625 × photoW) ⇒ canvas = round(1200 / 0.6625) = 1811
    expect(pngSize(out.png)).toEqual({ width: 1811, height: 1811 });
    expect(out.labelZonePx).toBeGreaterThanOrEqual(1200);
    // A blank canvas + text encodes to ~50 KB; a real photo composite is
    // far bigger — proof the WebP was decoded (via sharp) and drawn.
    expect(out.png.length).toBeGreaterThan(200_000);
    expect(out.ms).toBeLessThan(10_000);
  });

  it("box: the photo is cached per instance (one fetch for two renders)", async () => {
    const before = fetches;
    const a = await renderProbe({ style, message: "Thinking of you", view: "box" });
    const b = await renderProbe({ style, message: "Thinking of you", view: "box" });
    expect(fetches).toBe(before); // already cached by the previous test
    expect(a.png.equals(b.png)).toBe(true); // deterministic bytes
  });

  it("open: interior + cutout at pinataZone + message card", async () => {
    const out = await renderProbe({ style, box, message: "We love you so much!", view: "open" });
    expect(out.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    // 1200 wide; height follows the interior's 450 × 626 aspect
    expect(pngSize(out.png)).toEqual({ width: 1200, height: Math.round(626 * (1200 / 450)) });
    expect(out.png.length).toBeGreaterThan(100_000);
  });

  it("refuses a style without a box placement, loudly", async () => {
    await expect(
      renderProbe({ style: { ...style, logoZone: null }, message: "Hi", view: "box" }),
    ).rejects.toBeInstanceOf(RenderInputError);
  });

  it("refuses characters Poppins cannot draw instead of printing a gap", async () => {
    await expect(
      renderProbe({ style, message: "Happy Birthday 🎉", view: "label" }),
    ).rejects.toBeInstanceOf(RenderInputError);
  });

  it("escapes XML-special characters in the message", async () => {
    const out = await renderProbe({ style, message: `<Sam & "Jo"> you're #1!`, view: "label" });
    expect(pngSize(out.png)).toEqual({ width: 2400, height: 1170 });
  });

  it("never fetches from a host outside the hub's blob stores", async () => {
    await expect(
      renderProbe({
        style: { ...style, boxImageUrl: "https://example.com/box.png" },
        message: "Hi",
        view: "box",
      }),
    ).rejects.toThrow(/host not allowed/);
    expect(imageHostAllowed("http://ww0dl7zlgzlp6kuj.public.blob.vercel-storage.com/x")).toBe(false);
  });
});

describe("text layout", () => {
  it("wraps a long message into whole-word lines at a legible size", () => {
    const box = { w: 2212, h: 982 }; // the label's padded text box
    const msg =
      "Happy birthday to the sweetest person we know, with so much love from everyone back home";
    const l = layoutText(msg, box, { weight: 600, maxSize: 260, minSize: 48 });
    expect(l.fits).toBe(true);
    expect(l.lines.length).toBeGreaterThan(1);
    expect(l.lines.join(" ")).toBe(msg); // no word lost or broken
    expect(l.size).toBeGreaterThanOrEqual(48);
    expect(l.size).toBeLessThan(260);
  });

  it("is deterministic", () => {
    const box = { w: 2212, h: 982 };
    const a = layoutText("Congrats, Dr. Lee!", box, { weight: 600, maxSize: 260, minSize: 48 });
    const b = layoutText("Congrats, Dr. Lee!", box, { weight: 600, maxSize: 260, minSize: 48 });
    expect(a).toEqual(b);
  });

  it("escapes markup", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("normalizeMessage", () => {
  it("collapses whitespace and drops control characters", () => {
    expect(normalizeMessage("  Happy\n\n birthday\t Sam\u0000! ")).toBe("Happy birthday Sam!");
  });
  it("rejects empty and over-long input", () => {
    expect(normalizeMessage("   ")).toBeNull();
    expect(normalizeMessage("x".repeat(121))).toBeNull();
    expect(normalizeMessage("x".repeat(120))).toHaveLength(120);
  });
});
