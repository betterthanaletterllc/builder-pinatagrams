import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import catalogFixture from "./__fixtures__/hub-catalog.json";
import { catalogUrl, HUB_URL, type HubCatalog } from "@/lib/hub";
import { minDeliveryDate, resolveDeliveryConfig } from "@/lib/delivery";
import { projectCatalog } from "./catalog";
import {
  BUILDER_URL,
  DESIGN_LIMIT,
  DESIGNER_RESOURCE_URI,
  designerResources,
  designerTools,
  MCP_APP_MIME,
  RESOURCE_DOMAINS,
  upcomingHolidays,
  type DesignerData,
} from "./designer";
import { MCP_HOST } from "./price";

/**
 * open_designer, OFFLINE: the hub is the catalog recorded on 2026-10-15
 * (__fixtures__/hub-catalog.json — 19 styles all in stock, 5 fillings at +0
 * with Dog/Cat Treats and Realsy Dates allowing no add-ons, one add-on
 * Double Candy, no hub graphics), stubbed into globalThis.fetch the way
 * price.test.ts does. The clock is pinned (Thu 2026-10-15, 10:00 Chicago) so
 * the delivery-calendar checks are deterministic. The resource test reads the
 * real src/mcp-app/designer.html and asserts only that it is a non-empty
 * mcp-app document — the app builder owns its content.
 */

const CLOCK = "2026-10-15T15:00:00Z";
type Json = Record<string, unknown>;
type Result = { content: { type: "text"; text: string }[]; structuredContent: DesignerData; isError?: boolean };

const clone = <T>(v: T): T => structuredClone(v);
const catalogCopy = (): Json & { bodyStyles: Json[]; variant: Json } =>
  clone(catalogFixture) as unknown as Json & { bodyStyles: Json[]; variant: Json };

const CFG = resolveDeliveryConfig(catalogFixture.delivery);

/** Route the catalog URL to a canned response; any other fetch is a bug. */
function stubHub(catalog: unknown = catalogFixture) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`${HUB_URL}/api/public/catalog`)) {
      return new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function open(args: Json = {}, catalog: unknown = catalogFixture): Promise<Result> {
  stubHub(catalog);
  const res = (await designerTools.open_designer.handler(args)) as Result;
  if (res.isError) throw new Error(`unexpected refusal: ${res.content[0].text}`);
  return res;
}

const words = (s: string) => s.trim().split(/\s+/).length;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(CLOCK));
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("open_designer — registry shape", () => {
  it("is one read-only tool whose listing points the host at the ui:// resource", () => {
    expect(Object.keys(designerTools)).toEqual(["open_designer"]);
    const def = designerTools.open_designer;
    expect(def.title).toBe("Piñatagram designer");
    expect(def.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(def._meta).toEqual({ ui: { resourceUri: DESIGNER_RESOURCE_URI } });
    expect(DESIGNER_RESOURCE_URI).toBe("ui://pinatagrams/designer.html");
    // Prefill: nothing required, every documented field present.
    expect(def.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(def.inputSchema).not.toHaveProperty("required");
    expect(Object.keys(def.inputSchema.properties as Json).sort()).toEqual(
      [
        "add_ons",
        "carrier",
        "delivery_date",
        "design",
        "email",
        "filling",
        "message",
        "occasion",
        "recipient_name",
        "ship_to",
        "style_id",
      ].sort(),
    );
  });

  it("rides the registry with its title and _meta intact, colliding with no other tool", async () => {
    const { orderToolList } = await import("@/lib/order-tools");
    const list = orderToolList();
    const names = list.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    const entry = list.find((t) => t.name === "open_designer")!;
    expect(entry).toBeDefined();
    expect(entry.title).toBe("Piñatagram designer");
    expect(entry._meta).toEqual({ ui: { resourceUri: DESIGNER_RESOURCE_URI } });
    // Tools without extension metadata don't grow empty keys.
    const catalogEntry = list.find((t) => t.name === "get_catalog")!;
    expect(catalogEntry).not.toHaveProperty("_meta");
    expect(catalogEntry).not.toHaveProperty("title");
    // The Phase 0 date pattern rides along in this diff (projectCatalog moved
    // out of order-tools.ts). In TS source "\d" is just "d", so pin the
    // published JSON Schema to one a real date satisfies.
    const delivery = list.find((t) => t.name === "get_delivery_options")!;
    const pattern = ((delivery.inputSchema.properties as Json).date as Json).pattern as string;
    expect(pattern).toBe("^\\d{4}-\\d{2}-\\d{2}$");
    expect(new RegExp(pattern).test("2026-10-20")).toBe(true);
    expect(new RegExp(pattern).test("dddd-dd-dd")).toBe(false);
  });
});

describe("open_designer — the app's data", () => {
  it("returns the catalog projection, a gallery with STANDARD first, flags, today and the tool names", async () => {
    const res = await open();
    const sc = res.structuredContent;
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");

    expect(sc.catalog).toEqual(projectCatalog(catalogFixture as unknown as HubCatalog));
    expect(sc.catalog.body_styles).toHaveLength(19);
    expect(sc.catalog.graphic_upcharge_cents.library_design).toBe(200);

    expect(sc.designs).toHaveLength(DESIGN_LIMIT);
    expect(sc.designs[0]).toEqual({
      code: "STANDARD",
      title: "Classic Piñatagrams",
      thumb_url: expect.stringMatching(/^https:\/\/cdn\.shopify\.com\//),
      upcharge: "free",
      occasion: "Any occasion",
    });
    for (const d of sc.designs.slice(1)) {
      expect(d.upcharge).toBe("library");
      expect(d.code).toMatch(/^[A-Z0-9]{2,24}$/);
      expect(typeof d.title).toBe("string");
      expect(typeof d.occasion).toBe("string");
    }

    expect(sc.prefill).toEqual({});
    expect(sc.dropped).toEqual([]);
    expect(sc.ordering_enabled).toBe(false);
    expect(sc.builder_url).toBe(BUILDER_URL);
    expect(sc.today).toBe("2026-10-15"); // the pinned clock, in America/Chicago
    expect(sc.tools).toEqual({ price: "price_order", checkout: "create_checkout", designs: "list_designs" });
  });

  it("each filling carries the add-on rule price_order enforces, so the app never offers an add-on the quote refuses", async () => {
    const { structuredContent: sc } = await open();
    const rule = Object.fromEntries(sc.catalog.fillings.map((f) => [f.id, f.add_ons]));
    expect(rule).toEqual({
      candy: "all",
      "school-fun-pack": "all",
      "dog-treats": "none", // its blurb ("For the goodest recipients.") says nothing about add-ons
      "cat-treats": "none",
      "realsy-dates": "none",
    });
  });

  it("the default page is curated — Classic, the headline occasions in order, the next two holidays — and lists every occasion", async () => {
    const { structuredContent: sc } = await open();
    expect(sc.designs).toHaveLength(DESIGN_LIMIT);
    expect(sc.designs[0].code).toBe("STANDARD");
    const page = sc.designs.slice(1).map((d) => d.occasion);
    // Grouped in this order; the clock is 2026-10-15, so Halloween and Thanksgiving are next on the calendar.
    expect([...new Set(page)]).toEqual([
      "Birthday",
      "Thank you",
      "Family & Friends",
      "Sympathy",
      "Congrats",
      "Halloween",
      "Thanksgiving",
    ]);
    // 23 slots over 7 occasions: the first two take 4, the rest 3.
    expect(page.filter((o) => o === "Birthday")).toHaveLength(4);
    expect(page.filter((o) => o === "Thank you")).toHaveLength(4);
    expect(page.filter((o) => o === "Thanksgiving")).toHaveLength(3);
    // Every occasion the library sells, for the app's chips (it loads the rest with list_designs).
    expect(sc.occasions.length).toBeGreaterThanOrEqual(30);
    expect(sc.occasions).toEqual(
      expect.arrayContaining(["Birthday", "Christmas", "Work & business", "Halloween", "Thank you", "Love & Valentine's"]),
    );
    expect(sc.occasions).not.toContain("Any occasion");
    // The holiday pick wraps the year.
    expect(upcomingHolidays("2026-12-26", 2)).toEqual(["New Year", "Love & Valentine's"]);
    expect(upcomingHolidays("2026-10-31", 1)).toEqual(["Halloween"]); // the day itself still counts
  });

  it("reads the catalog once, scoped to MCP_HOST, and nothing else (no price call)", async () => {
    const fetchMock = stubHub();
    await designerTools.open_designer.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(catalogUrl({ host: MCP_HOST }));
  });

  it("reports ordering_enabled from the env flag at call time", async () => {
    vi.stubEnv("MCP_ORDERING_ENABLED", "true");
    expect((await open()).structuredContent.ordering_enabled).toBe(true);
    vi.stubEnv("MCP_ORDERING_ENABLED", "false");
    expect((await open()).structuredContent.ordering_enabled).toBe(false);
  });
});

describe("open_designer — prefill normalization", () => {
  const earliestFedex = minDeliveryDate(CFG, "fedex");
  const earliestUsps = minDeliveryDate(CFG, "usps");

  it("keeps valid values, normalized to the catalog's own ids and codes", async () => {
    const { structuredContent: sc } = await open({
      occasion: "birthday",
      recipient_name: "  Jane  ",
      style_id: "Googly",
      filling: "Realsy Dates",
      design: "hbd06",
      message: "Happy birthday, Jane!",
      carrier: "USPS",
      delivery_date: earliestUsps,
      ship_to: { name: "Jane Doe", address1: "1 Main St", city: "Austin", state: "tx", zip: "78701" },
      email: "payer@example.com",
    });
    expect(sc.prefill).toEqual({
      occasion: "Birthday",
      recipient_name: "Jane",
      style_id: "googly",
      filling: "realsy-dates",
      design: "HBD06",
      message: "Happy birthday, Jane!",
      carrier: "usps",
      delivery_date: earliestUsps,
      ship_to: { name: "Jane Doe", address1: "1 Main St", city: "Austin", state: "TX", zip: "78701" },
      email: "payer@example.com",
    });
    expect(sc.dropped).toEqual([]);
  });

  it("add-ons resolve by id or label, dedupe, and obey the filling's rule", async () => {
    const ok = await open({ filling: "candy", add_ons: ["Double Candy", "double-candy"] });
    expect(ok.structuredContent.prefill).toEqual({ filling: "candy", add_ons: ["double-candy"] });
    expect(ok.structuredContent.dropped).toEqual([]);

    const dogs = await open({ filling: "Dog Treats", add_ons: ["double-candy", "glitter"] });
    expect(dogs.structuredContent.prefill).toEqual({ filling: "dog-treats" });
    expect(dogs.structuredContent.dropped).toEqual([
      { field: "add_ons[0]", reason: expect.stringMatching(/Double Candy isn't available with the Dog Treats filling/) },
      { field: "add_ons[1]", reason: expect.stringMatching(/no add-on is called "glitter"/) },
    ]);
  });

  it("drops every invalid value with a customer-safe reason and keeps the rest", async () => {
    const { structuredContent: sc, content } = await open({
      style_id: "dragon",
      filling: "pizza",
      design: "NOPE99",
      message: "x".repeat(301),
      carrier: "pigeon",
      delivery_date: "2026-13-45",
      ship_to: { name: "Jane Doe", state: "Texas", zip: "abc", planet: "Earth" },
      email: "not-an-email",
      occasion: 42,
      color: "purple",
    });
    expect(sc.prefill).toEqual({ ship_to: { name: "Jane Doe" } });
    const byField = Object.fromEntries(sc.dropped.map((d) => [d.field, d.reason]));
    expect(byField).toEqual({
      color: expect.stringMatching(/isn't a designer field/),
      occasion: "must be text",
      style_id: expect.stringMatching(/no piñata has the id "dragon"/),
      filling: expect.stringMatching(/no filling is called "pizza"/),
      design: expect.stringMatching(/no design has the code "NOPE99"/),
      message: expect.stringMatching(/301 characters; the card holds 300/),
      carrier: expect.stringMatching(/must be "fedex" or "usps"/),
      delivery_date: expect.stringMatching(/isn't a real date/),
      "ship_to.planet": expect.stringMatching(/isn't an address field/),
      "ship_to.state": expect.stringMatching(/2-letter state code/),
      "ship_to.zip": expect.stringMatching(/US ZIP code/),
      email: expect.stringMatching(/doesn't look like an email address/),
    });
    // Never an isError refusal: the designer still opens.
    expect(content[0].text).toMatch(/^Designer opened in the chat\./);
    expect(content[0].text).toMatch(/Couldn't prefill .*style_id.*\(reasons in dropped\)/);
  });

  it("an out-of-stock piñata is dropped, not preselected", async () => {
    const catalog = catalogCopy();
    catalog.bodyStyles.find((s) => s.id === "googly")!.inStock = false;
    const { structuredContent: sc } = await open({ style_id: "googly" }, catalog);
    expect(sc.prefill).toEqual({});
    expect(sc.dropped).toEqual([{ field: "style_id", reason: "the Googly piñata is out of stock right now" }]);
    expect(sc.catalog.body_styles.find((s) => s.id === "googly")!.in_stock).toBe(false);
  });

  it("a carrier this store doesn't offer is dropped", async () => {
    const catalog = catalogCopy();
    catalog.variant.carriers = ["fedex"];
    const { structuredContent: sc } = await open({ carrier: "usps" }, catalog);
    expect(sc.prefill).toEqual({});
    expect(sc.dropped).toEqual([{ field: "carrier", reason: "USPS isn't offered on this store" }]);
  });

  it("validates the delivery date against the calendar for the given carrier (FedEx by default)", async () => {
    expect(earliestFedex < earliestUsps).toBe(true); // sanity: the fixture's calendar

    const ok = await open({ delivery_date: earliestFedex });
    expect(ok.structuredContent.prefill).toEqual({ delivery_date: earliestFedex });

    const soon = await open({ delivery_date: "2026-10-16" });
    expect(soon.structuredContent.prefill).toEqual({});
    expect(soon.structuredContent.dropped).toEqual([
      { field: "delivery_date", reason: expect.stringMatching(/is the soonest/) },
    ]);

    const sunday = await open({ delivery_date: "2026-10-25" });
    expect(sunday.structuredContent.dropped[0].reason).toMatch(/FedEx doesn't deliver on that day/);

    // Fine for FedEx, too soon for USPS: the carrier decides the rule.
    const usps = await open({ carrier: "usps", delivery_date: earliestFedex });
    expect(usps.structuredContent.prefill).toEqual({ carrier: "usps" });
    expect(usps.structuredContent.dropped).toEqual([
      { field: "delivery_date", reason: expect.stringMatching(/USPS First Class takes/) },
    ]);
  });
});

describe("open_designer — the gallery", () => {
  it("an occasion filters the gallery to its designs (Classic still first) and normalizes to the label", async () => {
    const { structuredContent: sc } = await open({ occasion: "birthday" });
    expect(sc.prefill.occasion).toBe("Birthday");
    expect(sc.designs).toHaveLength(DESIGN_LIMIT);
    expect(sc.designs[0].code).toBe("STANDARD");
    for (const d of sc.designs.slice(1)) expect(d.occasion).toBe("Birthday");
    expect(sc.dropped).toEqual([]);
  });

  it("an unknown occasion is dropped and the default gallery is shown", async () => {
    const dflt = await open();
    const { structuredContent: sc } = await open({ occasion: "quantum physics" });
    expect(sc.prefill).toEqual({});
    expect(sc.dropped).toEqual([
      { field: "occasion", reason: expect.stringMatching(/no designs are filed under "quantum physics"/) },
    ]);
    expect(sc.designs).toEqual(dflt.structuredContent.designs);
  });

  it("a prefilled design outside the filtered page is appended so the gallery can show it selected", async () => {
    const { structuredContent: sc } = await open({ occasion: "birthday", design: "APPR01" });
    expect(sc.prefill).toEqual({ occasion: "Birthday", design: "APPR01" });
    expect(sc.designs[0].code).toBe("STANDARD");
    const appended = sc.designs.find((d) => d.code === "APPR01")!;
    expect(appended).toMatchObject({ occasion: "Thank you", upcharge: "library" });
    expect(sc.designs).toHaveLength(DESIGN_LIMIT + 1);
  });

  it("a hub graphic limited to certain bodies is kept only on one of them, and shows its body_styles", async () => {
    const catalog = {
      ...catalogCopy(),
      hubGraphics: [
        {
          design: "H0002",
          title: "ACME internal v3 DO NOT SHOW",
          category: "corporate",
          bodyStyles: ["googly"],
          art: "https://yrfds6n4iwscziqm.public.blob.vercel-storage.com/library/h0002.png",
          artSha256: "a".repeat(64),
          thumb: "https://yrfds6n4iwscziqm.public.blob.vercel-storage.com/library/h0002-thumb.png",
        },
      ],
      graphicCategories: [{ id: "corporate", label: "Corporate gifting" }],
    };
    const wrong = await open({ style_id: "standard", design: "H0002" }, catalog);
    expect(wrong.structuredContent.prefill).toEqual({ style_id: "standard" });
    expect(wrong.structuredContent.dropped).toEqual([
      { field: "design", reason: "design H0002 isn't offered on the Standard piñata" },
    ]);

    const right = await open({ style_id: "googly", design: "h0002" }, catalog);
    expect(right.structuredContent.prefill).toEqual({ style_id: "googly", design: "H0002" });
    const row = right.structuredContent.designs.find((d) => d.code === "H0002")!;
    // The hub title is internal: the category label is what the app shows.
    expect(row).toEqual({
      code: "H0002",
      title: "Corporate gifting",
      thumb_url: "https://yrfds6n4iwscziqm.public.blob.vercel-storage.com/library/h0002-thumb.png",
      upcharge: "library",
      occasion: "Corporate gifting",
      body_styles: ["googly"],
    });
  });
});

describe("open_designer — the model-facing summary", () => {
  const earliestFedex = minDeliveryDate(CFG, "fedex");

  it("names what was prefilled and what the designer still collects, briefly", async () => {
    const { content } = await open({
      style_id: "googly",
      delivery_date: earliestFedex,
      ship_to: { city: "Austin", state: "TX" },
    });
    const text = content[0].text;
    expect(text).toMatch(/^Designer opened in the chat\. Prefilled: piñata \(Googly\), delivery date \(\d{4}-\d{2}-\d{2}\), address \(partial\)\./);
    // The message is optional in the designer (step 4 reads "Optional"), so it is never "still to choose".
    expect(text).toMatch(/Still to choose in the designer: filling, design, the rest of the address\./);
    expect(text).not.toMatch(/choose in the designer:[^.]*message/);
    expect(text).toMatch(/don't ask for them again/);
    expect(text).toMatch(/The card message is optional — offer to write it\./);
    expect(text).toMatch(/checkout link, relay it and remind them the order exists only after payment/);
    expect(text).toMatch(/switched off right now/); // MCP_ORDERING_ENABLED unset
    expect(text).not.toMatch(/Couldn't prefill/);
    expect(words(text)).toBeLessThanOrEqual(100);
  });

  it("with nothing prefilled, lists every choice; with everything, says so and omits the off note when ordering is on", async () => {
    const none = await open();
    expect(none.content[0].text).toMatch(
      /Prefilled: nothing\. Still to choose in the designer: piñata, filling, design, delivery date, address\./,
    );

    vi.stubEnv("MCP_ORDERING_ENABLED", "true");
    const all = await open({
      style_id: "standard",
      filling: "Candy",
      design: "STANDARD",
      message: "Hi!",
      delivery_date: earliestFedex,
      ship_to: { name: "J", address1: "1 Main", city: "Austin", state: "TX", zip: "78701" },
    });
    expect(all.content[0].text).toMatch(/Still to choose in the designer: nothing/);
    expect(all.content[0].text).toMatch(/Help with the card message if they want\./); // a message IS prefilled here
    expect(all.content[0].text).not.toMatch(/switched off/);
    expect(words(all.content[0].text)).toBeLessThanOrEqual(100);
  });
});

describe("designerResources — the ui:// HTML", () => {
  it("lists one mcp-app resource with the CSP the app needs", () => {
    const list = designerResources.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      uri: DESIGNER_RESOURCE_URI,
      name: "Piñatagram designer",
      mimeType: "text/html;profile=mcp-app",
    });
    expect(MCP_APP_MIME).toBe("text/html;profile=mcp-app");
    expect(list[0]._meta).toEqual({
      ui: {
        csp: { resourceDomains: RESOURCE_DOMAINS, connectDomains: [] },
        prefersBorder: true,
      },
    });
    expect(RESOURCE_DOMAINS).toEqual([
      "https://*.public.blob.vercel-storage.com",
      "https://cdn.shopify.com",
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
    ]);
  });

  it("reads the designer uri as a non-empty mcp-app document (content is the app builder's)", async () => {
    const contents = await designerResources.read(DESIGNER_RESOURCE_URI);
    expect(contents).not.toBeNull();
    expect(contents).toHaveLength(1);
    const [c] = contents!;
    expect(c.uri).toBe(DESIGNER_RESOURCE_URI);
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(typeof c.text).toBe("string");
    expect(c.text.trim().length).toBeGreaterThan(0);
    expect(c._meta).toEqual(designerResources.list()[0]._meta);
    // Cached: the second read is the same string without touching fs again.
    const again = await designerResources.read(DESIGNER_RESOURCE_URI);
    expect(again![0].text).toBe(c.text);
  });

  it("any other uri is null (the shell turns that into -32002)", async () => {
    expect(await designerResources.read("ui://pinatagrams/nope.html")).toBeNull();
    expect(await designerResources.read("")).toBeNull();
  });
});
