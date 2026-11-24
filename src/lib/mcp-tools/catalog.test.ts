import { describe, expect, it } from "vitest";
import type { HubCatalog } from "@/lib/hub";
import { projectCatalog } from "./catalog";

function catalogWith(bodyStyles: unknown[]): HubCatalog {
  return { asOf: "2026-11-24T00:00:00.000Z", bodyStyles, fillings: [], addons: [] } as unknown as HubCatalog;
}

describe("projectCatalog body styles", () => {
  it("passes the hub's side-view profile photo through as profile_image_url", () => {
    const out = projectCatalog(
      catalogWith([
        {
          id: "red",
          name: "Red",
          imageUrl: "https://blob.example/catalog/bodies/red.png",
          profileUrl: "https://blob.example/catalog/profiles/red.png",
          inBoxUrl: "https://blob.example/catalog/in-box/red.jpg",
          inStock: true,
        },
      ]),
    );
    expect(out.body_styles).toEqual([
      {
        id: "red",
        name: "Red",
        in_stock: true,
        image_url: "https://blob.example/catalog/bodies/red.png",
        profile_image_url: "https://blob.example/catalog/profiles/red.png",
        in_box_image_url: "https://blob.example/catalog/in-box/red.jpg",
      },
    ]);
  });

  it("reports null when the hub has no profile photo (or predates the field)", () => {
    const out = projectCatalog(
      catalogWith([
        { id: "nurse", name: "Nurse", imageUrl: null, profileUrl: null, inStock: true },
        { id: "chonky", name: "Chonky", imageUrl: null, inStock: false },
      ]),
    );
    expect(out.body_styles.map((s) => s.profile_image_url)).toEqual([null, null]);
    expect(out.body_styles.map((s) => s.in_box_image_url)).toEqual([null, null]);
    expect(out.open_box_image_url).toBeNull();
  });

  it("passes the open box photo through as open_box_image_url", () => {
    const cat = catalogWith([]);
    (cat as { box?: unknown }).box = { interiorUrl: null, messageZone: null, openBoxUrl: "https://blob.example/catalog/box-open.png" };
    expect(projectCatalog(cat).open_box_image_url).toBe("https://blob.example/catalog/box-open.png");
  });
});
