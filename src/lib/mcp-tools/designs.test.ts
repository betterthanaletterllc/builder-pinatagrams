import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubGraphicEntry } from "@/lib/hub";
import type { LibraryGraphic } from "@/lib/library-data";
import liveCatalog from "./__fixtures__/designs-catalog.json";

/**
 * Offline: globalThis.fetch is stubbed with the catalog recorded from the
 * live hub on 2026-10-15 (__fixtures__/designs-catalog.json — GET
 * /api/public/catalog, no host; hubGraphics was empty that day). The hub
 * path is covered by layering clearly synthetic H000x rows over that
 * recording. hub.ts remembers the last good catalog per module instance, so
 * every test imports a fresh copy of the module graph.
 */

type Refusal = { content: { type: "text"; text: string }[]; isError: true };
type Row = {
  design: string;
  title_or_label: string;
  occasion: string;
  thumb_url: string | null;
  source: "library" | "hub";
  upcharge: "free" | "library";
  is_default?: true;
  body_styles?: string[];
};
type Listing = {
  as_of: string;
  stale?: unknown;
  default_design: string;
  total_matches: number;
  returned: number;
  designs: Row[];
  occasions: string[];
  warnings?: string[];
  note: string;
};

const isRefusal = (r: unknown): r is Refusal =>
  !!r && typeof r === "object" && (r as Refusal).isError === true;

const SYNTHETIC_HUB = {
  ...liveCatalog,
  hubGraphics: [
    {
      design: "H0002",
      title: "ACME internal v3 DO NOT SHOW",
      category: "corporate",
      bodyStyles: ["classic", "white-uni"],
      art: "https://yrfds6n4iwscziqm.public.blob.vercel-storage.com/library/h0002.png",
      artSha256: "a".repeat(64),
      thumb: "https://yrfds6n4iwscziqm.public.blob.vercel-storage.com/library/h0002-thumb.png",
    },
    {
      design: "H0001",
      title: "Holiday party internal",
      category: "corporate",
      bodyStyles: [],
      art: "https://yrfds6n4iwscziqm.public.blob.vercel-storage.com/library/h0001.png",
      artSha256: "b".repeat(64),
      thumb: "",
    },
    // malformed (no artSha256) → dropped by resolveHubGraphics
    { design: "H0003", title: "broken", category: "corporate", art: "x", thumb: "" },
  ],
  graphicCategories: [{ id: "corporate", label: "Corporate gifting" }],
};

function stubCatalog(catalog: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("/api/public/catalog")) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function fresh() {
  vi.resetModules();
  return import("./designs");
}

async function list(args: Record<string, unknown>, catalog: unknown = liveCatalog) {
  const fetchMock = stubCatalog(catalog);
  const { designTools } = await fresh();
  const out = await designTools.list_designs.handler(args);
  return { out, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("list_designs — pure search", () => {
  const lib: LibraryGraphic[] = [
    { design: "HBD02", title: "Zebra Birthday", thumb: "t2", art: "a2" },
    { design: "HBD01", title: "Another Year Wiser", thumb: "t1", art: "a1" },
    { design: "APPR01", title: "Thanks a Bunch", thumb: "t3", art: "a3" },
    { design: "SPORTS01", title: "Basketball Piñatagram", thumb: "t4", art: "a4" },
    { design: "BSG01", title: "Client one-off", thumb: "t5", art: "a5" }, // excluded prefix
    { design: "HBD99", title: "No print art", thumb: "t6", art: null }, // unsellable
  ];
  const hub: HubGraphicEntry[] = [
    {
      design: "H0001",
      title: "INTERNAL TITLE",
      category: "corporate",
      bodyStyles: ["classic"],
      art: "https://blob/h.png",
      artSha256: "c".repeat(64),
      thumb: "https://blob/h-thumb.png",
    },
  ];
  const cats = [{ id: "corporate", label: "Corporate gifting" }];

  it("lists Classic first as the free default, then alphabetical; drops excluded and art-less rows", async () => {
    const { searchDesigns } = await fresh();
    const r = searchDesigns(lib, hub, cats, { limit: 50 });
    if ("refusal" in r) throw new Error(r.refusal);
    expect(r.rows.map((x) => x.design)).toEqual([
      "STANDARD",
      "HBD01", // Another Year Wiser
      "SPORTS01", // Basketball
      "H0001", // Corporate gifting (label, not title)
      "APPR01", // Thanks a Bunch
      "HBD02", // Zebra Birthday
    ]);
    expect(r.total).toBe(6);
    expect(r.rows[0]).toMatchObject({
      design: "STANDARD",
      title_or_label: "Classic Piñatagrams",
      upcharge: "free",
      is_default: true,
      source: "library",
    });
    expect(r.rows.filter((x) => x.upcharge === "free")).toHaveLength(1);
    expect(r.rows.find((x) => x.design === "BSG01")).toBeUndefined();
    expect(r.rows.find((x) => x.design === "HBD99")).toBeUndefined();
  });

  it("shows hub graphics by category label, never by internal title, with body_styles when restricted", async () => {
    const { searchDesigns } = await fresh();
    const r = searchDesigns(lib, hub, cats, { limit: 50 });
    if ("refusal" in r) throw new Error(r.refusal);
    const h = r.rows.find((x) => x.design === "H0001")!;
    expect(h).toEqual({
      design: "H0001",
      title_or_label: "Corporate gifting",
      occasion: "Corporate gifting",
      thumb_url: "https://blob/h-thumb.png",
      source: "hub",
      upcharge: "library",
      body_styles: ["classic"],
    });
    expect(JSON.stringify(r)).not.toContain("INTERNAL TITLE");
    // the internal title is not searchable either
    const byTitle = searchDesigns(lib, hub, cats, { query: "INTERNAL", limit: 50 });
    expect("refusal" in byTitle ? [] : byTitle.rows).toEqual([]);
  });

  it("ranks an exact code match first, then occasion matches, then title matches", async () => {
    const { searchDesigns } = await fresh();
    const exact = searchDesigns(lib, hub, cats, { query: "hbd01", limit: 50 });
    if ("refusal" in exact) throw new Error(exact.refusal);
    expect(exact.rows.map((x) => x.design)).toEqual(["HBD01"]);

    const occ = searchDesigns(lib, hub, cats, { query: "birthday", limit: 50 });
    if ("refusal" in occ) throw new Error(occ.refusal);
    // both HBD rows match on occasion (band 1); alphabetical inside the band
    expect(occ.rows.map((x) => x.design)).toEqual(["HBD01", "HBD02"]);

    const title = searchDesigns(lib, hub, cats, { query: "pinatagram", limit: 50 });
    if ("refusal" in title) throw new Error(title.refusal);
    // Classic (title "Classic Piñatagrams") is the default → first; then the title hit
    expect(title.rows.map((x) => x.design)).toEqual(["STANDARD", "SPORTS01"]);
  });

  it("every query word must match; diacritics and case are ignored", async () => {
    const { searchDesigns } = await fresh();
    const r = searchDesigns(lib, hub, cats, { query: "BASKETBALL piñatagram", limit: 50 });
    if ("refusal" in r) throw new Error(r.refusal);
    expect(r.rows.map((x) => x.design)).toEqual(["SPORTS01"]);
    const none = searchDesigns(lib, hub, cats, { query: "basketball zebra", limit: 50 });
    if ("refusal" in none) throw new Error(none.refusal);
    expect(none.rows).toEqual([]);
    expect(none.total).toBe(0);
  });

  it("filters by occasion label (case-insensitive, plural, or prefix key) and keeps Classic", async () => {
    const { searchDesigns } = await fresh();
    for (const occasion of ["birthday", "Birthdays", "HBD"]) {
      const r = searchDesigns(lib, hub, cats, { occasion, limit: 50 });
      if ("refusal" in r) throw new Error(r.refusal);
      expect(r.rows.map((x) => x.design)).toEqual(["STANDARD", "HBD01", "HBD02"]);
    }
    const corp = searchDesigns(lib, hub, cats, { occasion: "corporate", limit: 50 });
    if ("refusal" in corp) throw new Error(corp.refusal);
    expect(corp.rows.map((x) => x.design)).toEqual(["STANDARD", "H0001"]);
  });

  it("refuses an unknown occasion and names the valid labels", async () => {
    const { searchDesigns } = await fresh();
    const r = searchDesigns(lib, hub, cats, { occasion: "bar mitzvah", limit: 50 });
    expect("refusal" in r).toBe(true);
    if ("refusal" in r) {
      expect(r.refusal).toContain("bar mitzvah");
      expect(r.refusal).toContain("Birthday");
      expect(r.refusal).toContain("Corporate gifting");
      expect(r.refusal).toContain("Thank you");
      expect(r.refusal).not.toContain("Any occasion");
    }
  });

  it("applies limit after ordering and reports the full total", async () => {
    const { searchDesigns } = await fresh();
    const r = searchDesigns(lib, hub, cats, { limit: 2 });
    if ("refusal" in r) throw new Error(r.refusal);
    expect(r.rows.map((x) => x.design)).toEqual(["STANDARD", "HBD01"]);
    expect(r.total).toBe(6);
  });

  it("is deterministic regardless of input order", async () => {
    const { searchDesigns } = await fresh();
    const a = searchDesigns(lib, hub, cats, { query: "a", limit: 50 });
    const b = searchDesigns([...lib].reverse(), hub, cats, { query: "a", limit: 50 });
    expect(a).toEqual(b);
  });
});

describe("list_designs — handler over the recorded catalog", () => {
  it("default call: 20 rows, Classic first, every row a code with a tier, occasions listed", async () => {
    const { out, fetchMock } = await list({});
    expect(isRefusal(out)).toBe(false);
    const r = out as Listing;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://admin.betterthanaletter.com/api/public/catalog",
    );
    expect(r.as_of).toBe(liveCatalog.asOf);
    expect(r.default_design).toBe("STANDARD");
    expect(r.returned).toBe(20);
    expect(r.designs).toHaveLength(20);
    expect(r.total_matches).toBeGreaterThan(400); // 494 library + Classic, minus nothing excluded
    expect(r.designs[0]).toMatchObject({ design: "STANDARD", upcharge: "free", is_default: true });
    for (const row of r.designs.slice(1)) {
      expect(row.upcharge).toBe("library");
      expect(row.source).toBe("library");
      expect(row.design).toMatch(/^[A-Z0-9]+$/);
      expect(row.is_default).toBeUndefined();
    }
    expect(r.occasions).toContain("Birthday");
    expect(r.occasions).toContain("Sympathy");
    expect(r.occasions).toContain("4th of July");
    expect(r.occasions).not.toContain("Any occasion");
    expect(r.warnings).toBeUndefined();
    expect(r.stale).toBeUndefined();
    expect(r.note).toContain("STANDARD");
    expect(r.note).toContain("free default");
  });

  it("finds a design by code and by title word", async () => {
    const byCode = (await list({ query: "SPORTS01" })).out as Listing;
    expect(byCode.designs.map((d) => d.design)).toEqual(["SPORTS01"]);
    expect(byCode.designs[0]).toMatchObject({
      title_or_label: "Basketball Piñatagram",
      occasion: "Sports",
      thumb_url: expect.stringMatching(/^https:\/\/cdn\.shopify\.com\//),
    });
    const byWord = (await list({ query: "basketball" })).out as Listing;
    expect(byWord.designs.map((d) => d.design)).toContain("SPORTS01");
    expect(byWord.designs.every((d) => /basketball/i.test(d.title_or_label))).toBe(true);
  });

  it("filters by occasion and honours limit", async () => {
    const r = (await list({ occasion: "sympathy", limit: 5 })).out as Listing;
    expect(r.returned).toBe(5);
    expect(r.designs[0].design).toBe("STANDARD");
    for (const d of r.designs.slice(1)) expect(d.occasion).toBe("Sympathy");
    expect(r.total_matches).toBe(43); // 42 SYMP designs + Classic
  });

  it("surfaces hub graphics by category label and never their internal title", async () => {
    const r = (await list({ occasion: "Corporate gifting", limit: 50 }, SYNTHETIC_HUB)).out as Listing;
    expect(r.designs.map((d) => d.design)).toEqual(["STANDARD", "H0001", "H0002"]);
    expect(r.designs[1]).toEqual({
      design: "H0001",
      title_or_label: "Corporate gifting",
      occasion: "Corporate gifting",
      thumb_url: null,
      source: "hub",
      upcharge: "library",
    });
    expect(r.designs[2].body_styles).toEqual(["classic", "white-uni"]);
    expect(JSON.stringify(r)).not.toMatch(/internal|ACME|DO NOT SHOW/);
    expect(r.occasions).toContain("Corporate gifting");
  });

  it("refuses bad arguments with a clear message", async () => {
    for (const [args, needle] of [
      [{ limit: 0 }, "limit"],
      [{ limit: 51 }, "limit"],
      [{ limit: 2.5 }, "limit"],
      [{ limit: "20" }, "limit"],
      [{ query: 42 }, "query"],
      [{ query: "x".repeat(101) }, "query"],
      [{ occasion: ["a"] }, "occasion"],
      [{ occasion: "bar mitzvah" }, "Known occasions"],
    ] as [Record<string, unknown>, string][]) {
      const { out } = await list(args);
      expect(isRefusal(out), JSON.stringify(args)).toBe(true);
      expect((out as Refusal).content[0].text).toContain(needle);
    }
  });

  it("degrades to the library with a visible warning when the hub is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { designTools } = await fresh();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = (await designTools.list_designs.handler({ query: "HBD01" })) as Listing;
    warn.mockRestore();
    expect(isRefusal(r)).toBe(false);
    expect(r.designs.map((d) => d.design)).toEqual(["HBD01"]);
    expect(r.warnings).toEqual([
      "Hub-uploaded designs could not be loaded right now; only the standard library is listed.",
    ]);
    expect(r.as_of).toBe("2026-07-06T20:46:09.128Z"); // graphics.json generatedAt
  });

  it("passes the hub's stale marker through", async () => {
    const r = (await list({ limit: 1 }, { ...liveCatalog, stale: undefined })).out as Listing;
    expect(r.stale).toBeUndefined();
    // getCatalog only sets stale itself on a failed refetch; a marker the
    // catalog carries is forwarded verbatim.
    const marked = { ...liveCatalog, stale: { reason: "test", fetchedAt: "2026-10-15T00:00:00.000Z" } };
    const s = (await list({ limit: 1 }, marked)).out as Listing;
    expect(s.stale).toEqual({ reason: "test", fetchedAt: "2026-10-15T00:00:00.000Z" });
  });
});
