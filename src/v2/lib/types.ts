import type { DeliveryConfig } from "@/lib/delivery";
import type { GraphicChoice } from "@/lib/flow";
import type {
  BuilderPricing,
  HubBodyStyle,
  HubFilling,
  HubGraphicCategory,
  HubGraphicEntry,
  HubPrice,
  LogoZone,
} from "@/lib/hub";
import type { VariantProfile } from "@/lib/variant";
import type { OccasionId } from "./occasions";

/** A Shopify library design (the "shopify" arm of GraphicChoice). */
export type LibraryChoice = Extract<GraphicChoice, { type: "shopify" }>;

/** The four v2 steps, in order. */
export type StepId = "design" | "card" | "inside" | "deliver";
export const STEP_IDS: readonly StepId[] = ["design", "card", "inside", "deliver"];

/** How the shopper arrived on a step (the step_viewed contract). */
export type StepVia = "continue" | "back" | "chip" | "restore" | "deeplink";

/** Where the current graphic came from (graphic_picked.source). */
export type GraphicSource = "default" | "deeplink" | "filmstrip" | "library" | "editor";

export type BoxInterior = {
  interiorUrl: string | null;
  messageZone: LogoZone | null;
  messageCardPadding?: { x: number; y: number } | null;
};

/** A hub add-on as the v2 Inside step shows it. The catalog serves a photo
 *  and blurb beyond lib/hub's HubAddon type; both are optional here. */
export type V2Addon = {
  id: string;
  label: string;
  priceCents: number;
  sku: string | null;
  blurb: string;
  imageUrl: string | null;
};

/** One occasion's filmstrip, resolved server-side, most popular first. */
export type OccasionStrip = {
  id: OccasionId;
  label: string;
  designs: GraphicChoice[];
};

/** The brand-pooled rating; the scope label always travels with the number. */
export type Trust = { rating: number; count: number; label: string };

/** Server-resolved starting point for a NEW piñata (deep link → context →
 *  best seller). The client turns it into a draft. */
export type Preset = {
  styleId: string;
  styleSource: "deeplink" | "default";
  graphic: GraphicChoice;
  graphicSource: "default" | "deeplink";
  occasion: OccasionId | null;
  filling: string;
  fillingAuto: boolean;
};

/** Everything the v2 /design client needs, all serializable. */
export type FlowData = {
  styles: HubBodyStyle[]; // in stock only
  box: BoxInterior | null;
  addons: V2Addon[];
  fillings: HubFilling[];
  deliveryCfg: DeliveryConfig;
  pricing: BuilderPricing;
  variant: VariantProfile;
  hubGraphics: HubGraphicEntry[];
  hubCategories: HubGraphicCategory[];
  strips: OccasionStrip[];
  /** Hub-graphic strip for folders-only storefronts (library "none"). */
  hubStrip: GraphicChoice[];
  libraryCount: number;
  preset: Preset;
  /** True when the URL carried design/occasion/style/utm presets. */
  deepLink: boolean;
  /** The step the URL asked for (the client clamps it on hydration). */
  requestedStep: StepId;
  editLineId: string | null;
  initialPrice: HubPrice | null;
  trust: Trust | null;
  previewVariant: string | null;
};
