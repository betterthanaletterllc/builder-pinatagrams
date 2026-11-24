import { describe, expect, it } from "vitest";
import { imageHostAllowed, sanitizeSvg, svgSize } from "@/lib/render/images";
import { closedSceneSvg, openSceneSvg } from "@/lib/render/mockup";
import { layoutText } from "@/lib/render/text";
import { MIN_SECRET_LENGTH, staffAuthorized, staffToolList } from "@/lib/staff-tools";
import { DEFAULT_MESSAGE_CARD, parseArgs, resolveDesign } from "./mockup";

const SECRET = "s".repeat(MIN_SECRET_LENGTH);
const png = (w: number, h: number) => ({ mime: "image/png" as const, bytes: Buffer.from("x"), width: w, height: h });

describe("staff auth", () => {
  it("accepts the path secret or a bearer, nothing else", () => {
    expect(staffAuthorized(SECRET, null, SECRET)).toBe(true);
    expect(staffAuthorized("nope", `Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(staffAuthorized("nope", null, SECRET)).toBe(false);
    expect(staffAuthorized(SECRET.slice(1), null, SECRET)).toBe(false);
  });
  it("is closed when the secret is unset or too short", () => {
    expect(staffAuthorized("", null, undefined)).toBe(false);
    expect(staffAuthorized("short", null, "short")).toBe(false);
  });
  it("lists render_mockup and only read-only tools", () => {
    const tools = staffToolList();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_catalog", "list_designs", "render_mockup"]);
    expect(tools.every((t) => t.annotations.readOnlyHint && !t.annotations.destructiveHint)).toBe(true);
  });
});

describe("parseArgs", () => {
  it("defaults to every style, both views, matching flap", () => {
    expect(parseArgs({})).toMatchObject({ styles: "all", front: "", flap: "", view: "both", message: "" });
  });
  it("normalises style ids and keeps line breaks in the message", () => {
    const p = parseArgs({ styles: ["Googly", "googly", "pink-uni"], message: "Hi Sam\r\nLove, us" });
    expect(p).toMatchObject({ styles: ["googly", "pink-uni"], message: "Hi Sam\nLove, us" });
  });
  it("refuses bad input", () => {
    expect(parseArgs({ view: "side" })).toHaveProperty("error");
    expect(parseArgs({ front: "http://example.com/a.png" })).toHaveProperty("error");
    expect(parseArgs({ front: "<script>" })).toHaveProperty("error");
    expect(parseArgs({ message: "🎉 party" })).toHaveProperty("error");
    expect(parseArgs({ message: "x".repeat(5000) })).toHaveProperty("error");
    expect(parseArgs({ styles: [1] })).toHaveProperty("error");
  });
  it("accepts codes, https URLs and the keywords", () => {
    expect(parseArgs({ front: "HBD01", flap: "blank" })).not.toHaveProperty("error");
    expect(parseArgs({ front: "https://example.com/art.svg", flap: "match" })).not.toHaveProperty("error");
    expect(parseArgs({ front: "none" })).not.toHaveProperty("error");
  });
});

describe("resolveDesign", () => {
  it("finds the Classic default and library designs with their own cards", () => {
    const std = resolveDesign("standard", null);
    expect(std).toMatchObject({ kind: "design", code: "STANDARD", source: "classic" });
    const lib = resolveDesign("hbd01", null);
    expect(lib).toMatchObject({ kind: "design", code: "HBD01", source: "library" });
    expect(lib && lib.kind === "design" && lib.card).toMatch(/^https:\/\/cdn\.shopify\.com\//);
  });
  it("puts hub uploads on the default card", () => {
    const hub = resolveDesign("H0001", {
      hubGraphics: [{ design: "H0001", title: "t", category: "c", art: "https://x.public.blob.vercel-storage.com/a.png", artSha256: "a", thumb: "" }],
    });
    expect(hub).toMatchObject({ kind: "design", source: "hub", card: DEFAULT_MESSAGE_CARD });
  });
  it("returns null for an unknown code", () => {
    expect(resolveDesign("NOPE-XYZ", null)).toBeNull();
  });
});

describe("art fetch policy", () => {
  it("the public policy stays on the hub's blob store", () => {
    expect(imageHostAllowed("https://cdn.shopify.com/a.png")).toBe(false);
    expect(imageHostAllowed("https://ww0dl7zlgzlp6kuj.public.blob.vercel-storage.com/a.png")).toBe(true);
  });
  it("the staff policy takes public https hosts only", () => {
    expect(imageHostAllowed("https://cdn.shopify.com/a.png", "art")).toBe(true);
    for (const bad of [
      "http://cdn.shopify.com/a.png",
      "https://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "https://localhost/a.png",
      "https://metadata/a.png",
      "https://printer.local/a.png",
      "https://cdn.shopify.com:8443/a.png",
      "https://user:pw@cdn.shopify.com/a.png",
    ]) {
      expect(imageHostAllowed(bad, "art")).toBe(false);
    }
  });
});

describe("sanitizeSvg", () => {
  it("drops scripts, handlers and outside references; keeps data and #refs", () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="x()"><script>alert(1)</script>' +
      '<image href="/etc/passwd"/><image xlink:href="https://evil.example/a.png"/>' +
      '<image href="data:image/png;base64,AAAA"/><use href="#a"/><rect fill="url(https://evil.example/x)" mask="url(#m)"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/script|onload|passwd|evil\.example/);
    expect(clean).toContain('href="data:image/png;base64,AAAA"');
    expect(clean).toContain('href="#a"');
    expect(clean).toContain("url(#m)");
  });
  it("reads the size from width/height or the viewBox", () => {
    expect(svgSize('<svg width="768" height="384" viewBox="0 0 576 288">')).toEqual({ width: 768, height: 384 });
    expect(svgSize('<svg viewBox="0 0 576 288">')).toEqual({ width: 576, height: 288 });
    expect(() => svgSize('<svg width="100%">')).toThrow();
  });
});

describe("scenes", () => {
  it("contain-fits the front art in the logo zone", () => {
    const svg = closedSceneSvg({ photo: png(1000, 1000), logoZone: { x: 0.1, y: 0.6, w: 0.8, h: 0.3 }, art: png(2400, 1170) }, 500);
    expect(svg).toContain('width="500" height="500"');
    expect(svg).toContain('x="50" y="300" width="400" height="150" preserveAspectRatio="xMidYMid meet"');
  });
  it("stretches the flap card over the message zone and writes the message", () => {
    const svg = openSceneSvg(
      {
        interior: png(1000, 1200),
        cutout: null,
        pinataZone: null,
        messageZone: { x: 0.2, y: 0.75, w: 0.6, h: 0.2 },
        card: png(768, 384),
        message: "Hello there",
      },
      500,
    );
    expect(svg).toContain('x="100" y="450" width="300" height="120" preserveAspectRatio="none"');
    expect(svg).toContain("Hello there");
  });
});

describe("layoutText line breaks", () => {
  it("keeps hard breaks and blank lines, and is unchanged without them", () => {
    const box = { w: 2000, h: 1000 };
    const opts = { weight: 400 as const, maxSize: 60, minSize: 10 };
    expect(layoutText("Hi Sam\n\nLove, us", box, opts).lines).toEqual(["Hi Sam", "", "Love, us"]);
    expect(layoutText("Hi Sam Love, us", box, opts).lines).toEqual(["Hi Sam Love, us"]);
  });
});
