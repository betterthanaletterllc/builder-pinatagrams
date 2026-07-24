"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  addressComplete,
  addressKey,
  CART_EVENT,
  CLASSIC_GRAPHIC,
  clearDraft,
  EMPTY_ADDRESS,
  fillingAllowsAddon,
  formatAddress,
  graphicTier,
  graphicTierCents,
  loadAddresses,
  loadCart,
  loadDraft,
  newLineId,
  rememberAddress,
  saveCart,
  saveDraft,
  type DeliveryAddress,
  type Filling,
  type GraphicChoice,
} from "@/lib/flow";
import {
  isCurrentDesign,
  type DesignDocument,
} from "@/lib/design-document";
import {
  formatCents,
  HUB_URL,
  priceUrl,
  type BuilderPricing,
  type HubAddon,
  type HubBodyStyle,
  type HubFilling,
  type HubPrice,
  type LogoZone,
} from "@/lib/hub";
import {
  deliveryProblem,
  formatWindow,
  formatYmd,
  minDeliveryDate,
  uspsSpreadLabel,
  uspsWindow,
  uspsWindowLabel,
  type Carrier,
  type DeliveryConfig,
} from "@/lib/delivery";
import { cdnThumb, clearLibraryState } from "@/lib/library-data";
import type { VariantProfile } from "@/lib/variant";
import { track, trackAddToCart } from "@/lib/analytics";
import EditorShell from "./editor-shell";
import GraphicLibrary from "./graphic-library";
import BoxPreview from "./box-preview";
import DateCalendar from "./date-calendar";
import AddressLine1 from "./address-search";

type StyleInfo = {
  id: string;
  name: string;
  imageUrl: string | null;
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
  pinataZone: LogoZone | null;
  cutoutUrl: string | null;
};

const STEPS = [
  "Graphic",
  "Message",
  "Filling",
  "Add-ons",
  "Delivery",
  "Send to",
] as const;
type Step = (typeof STEPS)[number];

const STEP_SLUGS: Record<Step, string> = {
  Graphic: "graphic",
  Message: "message",
  Filling: "filling",
  "Add-ons": "addons",
  Delivery: "delivery",
  "Send to": "sendto",
};
const SLUG_TO_STEP = Object.fromEntries(
  Object.entries(STEP_SLUGS).map(([k, v]) => [v, k]),
) as Record<string, Step>;

// The brand confetti message card (Confetti Birthday's graphics/message) —
// custom designs preview AND print on this card (Nathan's call, 2026-07-17).
const DEFAULT_MESSAGE_CARD =
  "https://cdn.shopify.com/s/files/1/1116/8788/files/HBD01-GOOGLY_message_graphic.svg?v=1696183772";

const ADDRESS_FIELDS: [keyof DeliveryAddress, string][] = [
  ["name", "Recipient name"],
  ["address1", "Address"],
  ["address2", "Apt / suite (optional)"],
  ["city", "City"],
  ["province", "State"],
  ["zip", "ZIP"],
  ["phone", "Phone (optional)"],
];

export default function DesignFlow({
  style,
  boxInterior,
  addonOptions,
  fillingOptions,
  deliveryCfg,
  pricing,
  variant,
}: {
  style: StyleInfo;
  boxInterior: {
    interiorUrl: string | null;
    messageZone: LogoZone | null;
    messageCardPadding?: { x: number; y: number } | null;
  } | null;
  addonOptions: HubAddon[];
  fillingOptions: HubFilling[];
  deliveryCfg: DeliveryConfig;
  pricing: BuilderPricing;
  variant: VariantProfile;
}) {
  // Variant knobs (hub /pricing → "Builder variants"): tiered shows the
  // Classic/library/custom price ladder; flat is ONE all-in price. USPS
  // appears only when the variant offers it — otherwise FedEx is forced.
  const tiered = variant.pricing === "tiered";
  const uspsOffered = variant.carriers.includes("usps");
  // The style can be swapped in place (keeps the design/message/etc.).
  const [styleInfo, setStyleInfo] = useState<StyleInfo>(style);
  const [step, setStepState] = useState<Step>("Graphic");
  const [graphicMode, setGraphicModeState] = useState<
    "library" | "canvas" | null
  >(null);
  const [graphic, setGraphic] = useState<GraphicChoice | null>(null);
  const [editingDraft, setEditingDraft] = useState<DesignDocument | null>(null);
  const [message, setMessage] = useState("");
  const [filling, setFilling] = useState<Filling | null>(null);
  const [addons, setAddons] = useState<string[]>([]);
  // Set when switching fillings dropped add-ons the new one doesn't allow.
  const [addonNotice, setAddonNotice] = useState<string | null>(null);
  const [date, setDate] = useState("");
  // One carrier per ORDER (one draft = one shipping line): inherited from
  // the cart when it has lines, switchable on the Delivery step — switching
  // re-stamps every cart line at add-to-cart.
  const [carrier, setCarrier] = useState<Carrier>("fedex");
  const [address, setAddress] = useState<DeliveryAddress>(EMPTY_ADDRESS);
  // The ONE ship-to address for the whole cart (all piñatas go to it). Set
  // by the first piñata; every piñata after inherits it, so the address
  // step is skipped for them (and reappears once the cart is emptied).
  // Kept in sync with the cart via CART_EVENT / storage.
  const [cartAddress, setCartAddress] = useState<DeliveryAddress | null>(null);
  const [savedAddresses, setSavedAddresses] = useState<DeliveryAddress[]>([]);
  const [editLineId, setEditLineId] = useState<string | null>(null);
  const [cartError, setCartError] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherStyles, setSwitcherStyles] = useState<HubBodyStyle[] | null>(null);
  // The build dock: running summary + price, collapsible, on every step.
  const [dockOpen, setDockOpen] = useState(true);
  const [unitPrice, setUnitPrice] = useState<HubPrice | null>(null);
  // STATE, not a ref: the persist effect must not run until the commit AFTER
  // the restore lands, or it clobbers the stored draft with empty state.
  const [hydrated, setHydrated] = useState(false);

  const dateProblem = useMemo(
    () => deliveryProblem(date, deliveryCfg, carrier),
    [date, deliveryCfg, carrier],
  );

  // Keep the cart's established address fresh (mount + any cart write, this
  // tab or another). All cart lines share one address, so lines[0] is it.
  useEffect(() => {
    const refresh = () => {
      // loadCart() already collapses the cart to one address; pick the first
      // complete one (matches the cart page) so both surfaces agree.
      const lines = loadCart();
      setCartAddress(
        lines.find((l) => addressComplete(l.address))?.address ??
          lines[0]?.address ??
          null,
      );
    };
    refresh();
    window.addEventListener(CART_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CART_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  // Once an address is established, the "Send to" step is skipped and
  // Delivery is the terminal step. Editing an existing line inherits it too.
  const hasCartAddress = cartAddress !== null && addressComplete(cartAddress);

  /* --- step gating: the furthest step the current state supports ---------- */
  // Add-ons is a REAL step only when there's something to offer: at least one
  // active add-on that the chosen filling permits. No filling picked yet →
  // prospectively yes (the chip shows, gated behind Filling anyway).
  const addonsApplyTo = useCallback(
    (f: Filling | null): boolean => {
      if (addonOptions.length === 0) return false;
      const rec = f ? fillingOptions.find((x) => x.label === f) : undefined;
      if (!rec) return true;
      return addonOptions.some((a) => fillingAllowsAddon(rec, a.id));
    },
    [addonOptions, fillingOptions],
  );

  const maxStep = useCallback(
    (g: GraphicChoice | null, f: Filling | null, d: string): number => {
      if (!g) return 0; // Graphic
      if (!f) return 2; // through Filling
      if (deliveryProblem(d, deliveryCfg, carrier)) return 4; // through Delivery
      // Address already known → Delivery is the last step; else Send-to.
      return hasCartAddress ? 4 : 5;
    },
    [deliveryCfg, hasCartAddress, carrier],
  );

  /* --- history-backed navigation ------------------------------------------ */
  const writeUrl = useCallback(
    (s: Step, view: "library" | "canvas" | null, push: boolean) => {
      const u = new URL(window.location.href);
      u.searchParams.set("step", STEP_SLUGS[s]);
      if (view) u.searchParams.set("view", view);
      else u.searchParams.delete("view");
      if (push) window.history.pushState({}, "", u);
      else window.history.replaceState({}, "", u);
    },
    [],
  );

  const goStep = useCallback(
    (s: Step) => {
      setStepState(s);
      setGraphicModeState(null);
      writeUrl(s, null, true);
    },
    [writeUrl],
  );

  const goView = useCallback(
    (v: "library" | "canvas" | null) => {
      setGraphicModeState(v);
      setStepState("Graphic");
      writeUrl("Graphic", v, true);
      if (v) {
        track(
          v === "library" ? "graphic_library_opened" : "custom_editor_opened",
        );
      }
    },
    [writeUrl],
  );

  // Restore draft + URL step on mount, then keep listening for back/forward.
  useEffect(() => {
    setSavedAddresses(loadAddresses());
    const urlEdit = new URLSearchParams(window.location.search).get("edit");
    let d = loadDraft();
    // An edit-mode draft is only valid when this page was entered through the
    // cart's Edit button (?edit=<lineId>). Otherwise an abandoned edit would
    // contaminate a fresh pinata and silently REPLACE the old cart line.
    if (d?.editLineId && d.editLineId !== urlEdit) {
      clearDraft();
      d = null;
    }
    let g: GraphicChoice | null = null;
    let f: Filling | null = null;
    let dt = "";
    if (d) {
      // A draft carries across style changes (swap keeps your work).
      g = d.graphic;
      f = d.filling;
      dt = d.date;
      setGraphic(d.graphic);
      setMessage(d.message);
      setFilling(d.filling);
      setAddons(d.addons ?? []);
      setDate(d.date);
      setAddress(d.address);
      setEditLineId(d.editLineId ?? null);
    }
    // Carrier: the draft's own choice survives a refresh; otherwise every
    // NEW piñata starts on FedEx 2-Day (Nathan's call, 2026-07-22 — no
    // inheriting the cart's carrier). The one-carrier-per-order invariant
    // still holds: whatever is selected at add-to-cart re-stamps the cart.
    // A variant that doesn't offer USPS forces FedEx regardless of draft.
    setCarrier(uspsOffered ? (d?.carrier ?? "fedex") : "fedex");
    const applyUrl = () => {
      const p = new URLSearchParams(window.location.search);
      const target = SLUG_TO_STEP[p.get("step") ?? "graphic"] ?? "Graphic";
      const idx = Math.min(STEPS.indexOf(target), maxStep(g, f, dt));
      let landed = STEPS[Math.max(0, idx)];
      // A URL can't land on a skipped step (e.g. the filling disallows every
      // add-on, or the catalog has none) — bounce to Filling.
      if (landed === "Add-ons" && !addonsApplyTo(f)) landed = "Filling";
      setStepState(landed);
      const view = p.get("view");
      setGraphicModeState(
        landed === "Graphic" && (view === "library" || view === "canvas") && !g
          ? view
          : null,
      );
    };
    applyUrl();
    setHydrated(true);

    const onPop = () => {
      // Clamp to what the CURRENT state (mirrored in a ref) can support, so
      // forward-jumping through history can't land on a dead-end step.
      const p = new URLSearchParams(window.location.search);
      const target = SLUG_TO_STEP[p.get("step") ?? "graphic"] ?? "Graphic";
      const s = stateRef.current;
      const idx = Math.min(
        STEPS.indexOf(target),
        maxStep(s.graphic, s.filling, s.date),
      );
      let clamped = STEPS[Math.max(0, idx)];
      // Back/forward through history skips over a hidden Add-ons step.
      if (clamped === "Add-ons" && !addonsApplyTo(s.filling)) clamped = "Filling";
      setStepState(clamped);
      const view = p.get("view");
      setGraphicModeState(
        clamped === "Graphic" && (view === "library" || view === "canvas")
          ? view
          : null,
      );
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live per-piñata price for the dock (display only — checkout re-prices).
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(
      priceUrl({
        qty: 1,
        fill: "filled",
        bodyType: "standard",
        graphicType: "custom",
        mode: "individual",
        carrier: "standard",
      }),
      { signal: ctrl.signal },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(setUnitPrice)
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  // Mirror gating inputs for the popstate handler (stale-closure-proof).
  const stateRef = useRef({ graphic, filling, date });
  useEffect(() => {
    stateRef.current = { graphic, filling, date };
  }, [graphic, filling, date]);

  // Step changes: back to the top with focus on the heading (keyboard and
  // screen-reader users keep their place; mobile users don't land mid-page).
  useEffect(() => {
    if (!hydrated) return;
    window.scrollTo({ top: 0 });
    const h = document.querySelector<HTMLElement>(".step-h1");
    h?.focus({ preventScroll: true });
    document
      .querySelector(".chip.active")
      ?.scrollIntoView({ inline: "center", block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, graphicMode]);

  // Funnel step-view tracking: fire once each time the customer LANDS on the
  // Message or Add-ons step — via Continue, a numbered chip, browser
  // back/forward, or a URL restore. These two steps were the only ones with no
  // "reached this step" signal (every other step emits its own action event),
  // so PostHog couldn't measure drop-off into them. Clamping never lands on
  // Message/Add-ons, so this only fires on genuine navigation.
  useEffect(() => {
    if (!hydrated) return;
    if (step === "Message") track("message_step_viewed");
    else if (step === "Add-ons") track("addons_step_viewed");
  }, [hydrated, step]);

  // Persist the draft on every meaningful change (only once hydrated —
  // never on the initial commit, which still holds empty state).
  useEffect(() => {
    if (!hydrated) return;
    saveDraft({
      styleId: styleInfo.id,
      graphic,
      message,
      filling,
      addons,
      date,
      carrier,
      address,
      editLineId,
    });
  }, [hydrated, styleInfo.id, graphic, message, filling, addons, date, carrier, address, editLineId]);

  const stepIndex = STEPS.indexOf(step);
  const reachable = maxStep(graphic, filling, date);

  // Clamp down if the current step is no longer reachable — e.g. the cart's
  // address just loaded (hasCartAddress → true), so "Send to" collapses into
  // Delivery. Runs after the initial async cart read settles.
  useEffect(() => {
    if (!hydrated) return;
    if (stepIndex > reachable) {
      setStepState(STEPS[reachable]);
      writeUrl(STEPS[reachable], null, false);
    }
  }, [hydrated, stepIndex, reachable, writeUrl]);

  // Previews composite a CDN-resized variant (~60KB), never the print-res
  // original (multi-MB) — that was a visible delay before the graphic
  // appeared on the box. Checkout still sends the full-res URL to Paper.
  const artUrl = graphic
    ? graphic.type === "custom"
      ? graphic.preview
      : cdnThumb(graphic.art ?? graphic.thumb, 720)
    : null;

  // Matching inside-flap card for the message preview: the library design's
  // own graphics/message card, or the brand confetti card for custom designs
  // (the same card Paper prints for CUSTOM lines — set on the Custom Built
  // Piñatagram product's graphics.message metafield). Pre-field drafts
  // (message undefined) fall back to the interior photo's blank card.
  const messageCard = graphic
    ? graphic.type === "shopify"
      ? (graphic.message ?? null)
      : DEFAULT_MESSAGE_CARD
    : null;

  // choosing no longer requires !graphic: entering the canvas to EDIT keeps
  // the saved graphic in state, so Back/refresh can't destroy the design.
  const choosing = step === "Graphic" && graphicMode !== null;
  const docked =
    step === "Filling" ||
    step === "Add-ons" ||
    step === "Delivery" ||
    step === "Send to";
  // The dock shows on EVERY step (not just the docked ones) — inside the
  // library/canvas it would fight the editor's own bottom UI, so not there.
  const dockVisible = !choosing;

  const selectedAddonLabels = addons
    .map((id) => addonOptions.find((a) => a.id === id)?.label)
    .filter(Boolean) as string[];
  const addonCents = addons.reduce(
    (s, id) => s + (addonOptions.find((a) => a.id === id)?.priceCents ?? 0),
    0,
  );
  const fillingRec = filling
    ? fillingOptions.find((f) => f.label === filling)
    : undefined;
  // Whether the Add-ons step exists for the current filling; the chip row,
  // sequential CTAs, and URL restore all consult this one flag.
  const addonsApplicable = addonsApplyTo(filling);
  // The chip row as actually shown: Send-to collapses once the cart owns an
  // address; Add-ons disappears when the filling permits none. Each entry
  // keeps its ORIGINAL index (for done/reachable math) while numbering runs
  // over the visible position.
  const visibleSteps = STEPS.map((s, idx) => ({ s, idx })).filter(
    ({ s }) =>
      (s !== "Send to" || !hasCartAddress) &&
      (s !== "Add-ons" || addonsApplicable),
  );
  const fillingCents = fillingRec?.priceCents ?? 0;
  // Version-B tiers: the Classic default rides at the base price; a library
  // pick or custom design adds its upcharge. Flat variants price every
  // graphic the same. Shipping prices by the chosen carrier. (Checkout
  // re-derives all of this server-side from the same variant profile.)
  const tierCents = tiered ? graphicTierCents(graphic, pricing) : 0;
  const shipCents =
    carrier === "usps"
      ? pricing.uspsShipPerUnitCents
      : (unitPrice?.shipPerUnitCents ?? null);
  const deliveredCents =
    unitPrice && shipCents !== null
      ? unitPrice.unitPriceCents +
        tierCents +
        fillingCents +
        addonCents +
        shipCents
      : null;

  // Picking a filling drops add-ons it doesn't allow — visibly, never
  // silently (the checkout enforces the same rule server-side).
  const pickFilling = (f: HubFilling) => {
    setFilling(f.label);
    track("filling_selected", { filling: f.label });
    const dropped = addons.filter((id) => !fillingAllowsAddon(f, id));
    if (dropped.length) {
      setAddons(addons.filter((id) => fillingAllowsAddon(f, id)));
      const names = dropped
        .map((id) => addonOptions.find((a) => a.id === id)?.label ?? id)
        .join(", ");
      setAddonNotice(`${names} isn't available with ${f.label} — removed.`);
    } else {
      setAddonNotice(null);
    }
  };

  const selectedSavedKey = addressKey(address);
  const addressOk = addressComplete(address);

  // One source for the order-summary strings — the mobile bottom dock and
  // the desktop rail card must never drift apart.
  const summaryTitle =
    graphic?.type === "custom"
      ? `Your design — ${styleInfo.name}`
      : graphic
        ? `${graphic.title} — ${styleInfo.name}`
        : styleInfo.name;
  const summaryDetail =
    [
      message
        ? `“${message.slice(0, 22)}${message.length > 22 ? "…" : ""}”`
        : null,
      filling
        ? filling +
          (selectedAddonLabels.length
            ? ` + ${selectedAddonLabels.join(" + ")}`
            : "")
        : null,
      !dateProblem && date && stepIndex >= 3
        ? carrier === "usps"
          ? formatWindow(uspsWindow(date, deliveryCfg))
          : formatYmd(date)
        : null,
    ]
      .filter(Boolean)
      .join(" · ") || "building…";

  // Titles get their "Step N" from the VISIBLE position (body style is One),
  // so the number always matches the numbered chip row even when Add-ons or
  // Send-to is skipped.
  const STEP_TITLES: Record<Step, string> = {
    Graphic: "The graphic",
    Message: "Message",
    Filling: "What goes inside?",
    "Add-ons": "Add extras",
    Delivery: "Pick the delivery day",
    "Send to": "Who's it going to?",
  };
  const ORDINALS = ["Two", "Three", "Four", "Five", "Six", "Seven"];
  const visiblePos = Math.max(
    0,
    visibleSteps.findIndex((v) => v.s === step),
  );
  const stepHeading = `Step ${ORDINALS[visiblePos]}: ${STEP_TITLES[step]}`;
  const showHeading = !choosing;

  /* --- style switcher ------------------------------------------------------ */
  const openSwitcher = async () => {
    setSwitcherOpen((o) => !o);
    if (!switcherStyles) {
      try {
        const r = await fetch(`${HUB_URL}/api/public/catalog`);
        if (r.ok) setSwitcherStyles((await r.json()).bodyStyles ?? []);
      } catch {}
    }
  };

  const swapStyle = (s: HubBodyStyle) => {
    setStyleInfo({
      id: s.id,
      name: s.name,
      imageUrl: s.imageUrl,
      boxImageUrl: s.boxImageUrl,
      logoZone: s.logoZone,
      pinataZone: s.pinataZone ?? null,
      cutoutUrl: s.cutoutUrl ?? null,
    });
    setSwitcherOpen(false);
    const u = new URL(window.location.href);
    u.searchParams.set("style", s.id);
    window.history.replaceState({}, "", u);
  };

  /* --- cart ---------------------------------------------------------------- */
  const addToCart = () => {
    // Every piñata ships to the ONE cart address: an established one is
    // inherited (the address step was skipped), else the one just entered.
    const shipTo = hasCartAddress ? cartAddress! : address;
    if (!graphic || !filling || dateProblem || !addressComplete(shipTo)) return;
    const lines = loadCart();
    // "Save changes" to a line that no longer exists (removed in another tab)
    // must APPEND, not silently vanish.
    const existing = editLineId
      ? lines.find((l) => l.id === editLineId)
      : undefined;
    const line = {
      id: existing ? existing.id : newLineId(),
      styleId: styleInfo.id,
      styleName: styleInfo.name,
      boxImageUrl: styleInfo.boxImageUrl,
      logoZone: styleInfo.logoZone,
      graphic,
      message: message.trim(),
      filling,
      // Only keep ids the catalog still offers AND the filling allows — a
      // stale draft can't order a deactivated add-on, and a restored draft
      // can't sneak one past the filling's rule (checkout re-checks both).
      addons: addons.filter(
        (id) =>
          addonOptions.some((a) => a.id === id) &&
          fillingAllowsAddon(fillingRec, id),
      ),
      deliveryDate: date,
      carrier,
      address: shipTo,
      qty: existing ? existing.qty : 1,
    };
    // ONE carrier per order (one draft = one shipping line): the choice just
    // made re-stamps every line, exactly like the single-address collapse.
    const next = (
      existing
        ? lines.map((l) => (l.id === existing.id ? line : l))
        : [...lines, line]
    ).map((l) => ({ ...l, carrier }));
    if (!saveCart(next)) {
      setCartError(true);
      return;
    }
    rememberAddress(shipTo);
    setCartAddress(shipTo);
    clearDraft();
    clearLibraryState(); // the next piñata browses the library fresh
    trackAddToCart(deliveredCents);
    // Straight to the cart — no success interstitial. A full navigation also
    // disarms the flow so browser Back can't resurrect a completed line.
    window.location.assign("/cart");
  };

  // The step's primary action lives in a FIXED bar just above the dock —
  // always visible, never scrolled away, never hidden under the summary.
  const primaryCta = (() => {
    if (choosing) return null;
    switch (step) {
      case "Graphic":
        return graphic
          ? { label: "Continue →", onClick: () => goStep("Message") }
          : null;
      case "Message":
        return {
          label: "Continue →",
          onClick: () => {
            track("message_step_completed", {
              has_message: message.trim().length > 0,
            });
            goStep("Filling");
          },
        };
      case "Filling":
        return {
          label: "Continue →",
          // The Add-ons step only exists when this filling permits one.
          onClick: () => goStep(addonsApplicable ? "Add-ons" : "Delivery"),
          disabled: !filling,
        };
      case "Add-ons":
        // Extras are optional — Continue is never gated here. Mirrors the
        // Message step's completion event so the funnel has a symmetric
        // "left this step" signal (with how many extras were chosen).
        return {
          label: "Continue →",
          onClick: () => {
            track("addons_step_completed", { addon_count: addons.length });
            goStep("Delivery");
          },
        };
      case "Delivery":
        // Address already known → Delivery is the last step, add straight to
        // the cart. First piñata (no address yet) → continue to Send-to.
        return hasCartAddress
          ? {
              label: "Add to cart →",
              onClick: addToCart,
              disabled: !!dateProblem || !graphic || !filling,
            }
          : {
              label: "Continue →",
              onClick: () => goStep("Send to"),
              disabled: !!dateProblem,
            };
      case "Send to":
        return {
          label: editLineId ? "Save changes →" : "Add to cart →",
          onClick: addToCart,
          disabled: !addressOk || !graphic || !filling || !!dateProblem,
        };
      default:
        return null;
    }
  })();


  const pickCarrier = (c: Carrier) => {
    setCarrier(c);
    track("carrier_selected", { carrier: c });
  };

  // The Classic branded default: a one-tap pick (no library, no canvas) —
  // the confirm screen shows it on the box like any other selection.
  const pickClassic = () => {
    setGraphic(CLASSIC_GRAPHIC);
    setEditingDraft(null);
    track("graphic_picked", { design: CLASSIC_GRAPHIC.design, tier: "classic" });
  };

  const steps = (
    <div>
      {/* Step Two — the box IS the screen; buttons morph with state */}
      {step === "Graphic" && !choosing && (
        <div className="step-panel">
          {!graphic ? (
            // Tiered variants: the Classic branded box is included at the
            // base price; a library pick and a custom design each show
            // their upcharge (hub-controlled, /pricing). Flat variants show
            // the original two equal-priced cards — no Classic, no tags.
            <div className="choice-cards">
              {tiered && (
                <button className="choice-card" onClick={pickClassic}>
                  <span className="choice-title">Classic Piñatagrams</span>
                  <span className="choice-sub">
                    Our signature confetti box — ready to go
                  </span>
                  <span className="choice-price included">Included</span>
                </button>
              )}
              <button className="choice-card" onClick={() => goView("library")}>
                <span className="choice-title">Pick a graphic</span>
                <span className="choice-sub">
                  Browse hundreds of ready-made designs
                </span>
                {tiered && (
                  <span className="choice-price plus">
                    +{formatCents(pricing.graphicLibraryUpchargeCents)}
                  </span>
                )}
              </button>
              <button
                className="choice-card"
                onClick={() => {
                  setEditingDraft(null);
                  goView("canvas");
                }}
              >
                <span className="choice-title">Design your own</span>
                <span className="choice-sub">
                  Add your photos &amp; text on a blank canvas
                </span>
                {tiered && (
                  <span className="choice-price plus">
                    +{formatCents(pricing.graphicCustomUpchargeCents)}
                  </span>
                )}
              </button>
            </div>
          ) : (
            // The confirm screen IS the choice screen, with the current
            // pick previewed on the box above: same big cards as the first
            // visit. "Looks good →" lives in the fixed CTA bar below.
            // Every state offers the ways OUT of the current tier, price
            // tags included, so switching always shows what it costs.
            <div className="choice-cards">
              {graphic.type === "custom" ? (
                <>
                  <button
                    className="choice-card"
                    onClick={() => {
                      setEditingDraft(null);
                      goView("library");
                    }}
                  >
                    <span className="choice-title">Pick a different graphic</span>
                    {tiered && (
                      <span className="choice-price plus">
                        +{formatCents(pricing.graphicLibraryUpchargeCents)}
                      </span>
                    )}
                  </button>
                  <button
                    className="choice-card"
                    onClick={() => {
                      // keep `graphic` — the saved design must survive a
                      // cancelled edit (browser Back) or a refresh. Old v1
                      // freeform docs can't open in the template editor;
                      // those edits start fresh at the layout picker.
                      setEditingDraft(
                        isCurrentDesign(graphic.design) ? graphic.design : null,
                      );
                      goView("canvas");
                    }}
                  >
                    <span className="choice-title">Edit this graphic</span>
                  </button>
                  {tiered && (
                    <button className="choice-card" onClick={pickClassic}>
                      <span className="choice-title">Use the Classic box</span>
                      <span className="choice-price included">Included</span>
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    className="choice-card"
                    onClick={() => {
                      // Straight back into the library, restored to the
                      // exact aisle/search/scroll they picked from.
                      // `graphic` stays set until a new pick.
                      setEditingDraft(null);
                      goView("library");
                    }}
                  >
                    <span className="choice-title">
                      {graphicTier(graphic) === "classic"
                        ? "Pick a graphic"
                        : "Change graphic"}
                    </span>
                    {tiered && graphicTier(graphic) === "classic" && (
                      <span className="choice-price plus">
                        +{formatCents(pricing.graphicLibraryUpchargeCents)}
                      </span>
                    )}
                  </button>
                  <button
                    className="choice-card"
                    onClick={() => {
                      setEditingDraft(null);
                      goView("canvas");
                    }}
                  >
                    <span className="choice-title">Design your own</span>
                    {tiered && (
                      <span className="choice-price plus">
                        +{formatCents(pricing.graphicCustomUpchargeCents)}
                      </span>
                    )}
                  </button>
                  {tiered && graphicTier(graphic) === "library" && (
                    <button className="choice-card" onClick={pickClassic}>
                      <span className="choice-title">Use the Classic box</span>
                      <span className="choice-price included">Included</span>
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {choosing && graphicMode === "library" && (
        <>
          <p className="note">
            <button className="btn mini" onClick={() => goView(null)}>
              ← Back
            </button>
          </p>
          <GraphicLibrary
            restrict={variant.library === "birthday" ? "birthday" : null}
            onPick={(g) => {
              setGraphic(g);
              track("graphic_picked", { design: g.design });
              goStep("Graphic");
            }}
          />
        </>
      )}

      {choosing && graphicMode === "canvas" && (
        <div>
          <p className="note">
            <button className="btn mini" onClick={() => goView(null)}>
              ← Back
            </button>
          </p>
          <EditorShell
            key={editingDraft ? "edit" : "new"}
            bodyStyleId={styleInfo.id}
            boxImageUrl={styleInfo.boxImageUrl}
            logoZone={styleInfo.logoZone}
            initialDesign={editingDraft}
            initialAssets={
              editingDraft && graphic?.type === "custom"
                ? {
                    art: graphic.art ?? null,
                    designUrl: graphic.designUrl ?? null,
                    artSha256: graphic.artSha256 ?? null,
                  }
                : null
            }
            onSave={(design, preview, assets) => {
              // stamp the CURRENT style — the body may have been swapped
              // while the canvas was open
              setGraphic({
                type: "custom",
                design: { ...design, bodyStyleId: styleInfo.id },
                preview,
                art: assets.art,
                designUrl: assets.designUrl,
                artSha256: assets.artSha256,
              });
              setEditingDraft(null);
              track("custom_design_saved");
              goStep("Graphic");
            }}
            onAssets={(assets, docJson) => {
              // The background print upload finished — patch the flow's
              // graphic (if it's still this design)…
              setGraphic((prev) =>
                prev?.type === "custom" &&
                JSON.stringify({ ...JSON.parse(docJson), bodyStyleId: prev.design.bodyStyleId }) ===
                  JSON.stringify(prev.design)
                  ? {
                      ...prev,
                      art: assets.art,
                      designUrl: assets.designUrl,
                      artSha256: assets.artSha256,
                    }
                  : prev,
              );
              // …and any cart line holding THIS design that raced ahead of
              // the upload (or predates hashes: art set, hash missing).
              // Identity = the design document itself, same comparison as
              // the setGraphic patch above — patching by "art-less" alone
              // would stamp SOME OTHER design's art + its validly-matching
              // hash onto an unrelated line, and Paper would print the
              // wrong piñata with a passing integrity check.
              const lines = loadCart();
              let touched = false;
              const next = lines.map((l) => {
                if (l.graphic.type !== "custom") return l;
                if (l.graphic.art && l.graphic.artSha256) return l;
                const doc = l.graphic.design;
                if (
                  JSON.stringify({
                    ...JSON.parse(docJson),
                    bodyStyleId: doc.bodyStyleId,
                  }) !== JSON.stringify(doc)
                )
                  return l;
                touched = true;
                return {
                  ...l,
                  graphic: {
                    ...l.graphic,
                    art: assets.art,
                    designUrl: assets.designUrl,
                    artSha256: assets.artSha256,
                  },
                };
              });
              if (touched) saveCart(next);
            }}
          />
        </div>
      )}

      {step === "Message" && (
        <div className="step-panel msg-step">
          <textarea
            className="message-box"
            maxLength={300}
            rows={4}
            placeholder="Add a gift message — it prints on the inside flap. Don't forget to say who it's from!"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
      )}

      {step === "Filling" && (
        <div className="step-panel">
          <div className="filling-bars">
            {fillingOptions.map((f) => (
              <button
                key={f.id}
                className={
                  "filling-bar" + (filling === f.label ? " selected" : "")
                }
                onClick={() => pickFilling(f)}
              >
                <span className="filling-media">
                  <span className="filling-name">{f.label}</span>
                  {f.imageUrl && (
                    // next/image: ~10 KB thumbs instead of the multi-MB
                    // uploads the hub stores at full size
                    <Image
                      src={f.imageUrl}
                      alt=""
                      width={260}
                      height={176}
                      sizes="130px"
                    />
                  )}
                </span>
                <span className="filling-body">
                  {f.blurb && <span className="filling-blurb">{f.blurb}</span>}
                  <span
                    className={
                      "filling-price" + (f.priceCents > 0 ? " plus" : "")
                    }
                  >
                    {f.priceCents > 0
                      ? `+${formatCents(f.priceCents)}`
                      : "Included"}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {addonOptions.length > 0 && fillingRec?.addons === "none" && (
            // Explains why no Add-ons step follows this filling.
            <p className="note addon-note">
              Add-ons aren&apos;t available with {fillingRec.label} — it fills
              the whole box.
            </p>
          )}
          {addonNotice && <div className="notice info">{addonNotice}</div>}
        </div>
      )}

      {step === "Add-ons" && (
        <div className="step-panel">
          <section className="addon-section">
            <h3 className="addon-head">Add extras</h3>
            <div className="addon-list">
              {addonOptions.map((a) => {
                const allowed = fillingAllowsAddon(fillingRec, a.id);
                const on = addons.includes(a.id) && allowed;
                return (
                  <label
                    key={a.id}
                    className={
                      "addon-row" +
                      (on ? " selected" : "") +
                      (allowed ? "" : " blocked")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!allowed}
                      onChange={() => {
                        setAddons(
                          on
                            ? addons.filter((id) => id !== a.id)
                            : [...addons, a.id],
                        );
                        track("addon_toggled", { addon: a.id, on: !on });
                      }}
                    />
                    <span className="addon-label">{a.label}</span>
                    <span className="addon-price">
                      {allowed
                        ? `+${formatCents(a.priceCents)}`
                        : `not available with ${filling ?? "this filling"}`}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {step === "Delivery" && (
        <div className="step-panel delivery-step">
          {/* One delivery speed per ORDER — the choice re-stamps every
              piñata in the cart at add-to-cart (one draft, one shipping
              line). USPS = cheaper, arrives in a window; FedEx = exact day.
              Variants without USPS skip the chooser (FedEx forced). */}
          {uspsOffered && (
            <div className="carrier-cards">
              <button
                className={
                  "carrier-card" + (carrier === "fedex" ? " selected" : "")
                }
                onClick={() => pickCarrier("fedex")}
              >
                <span className="carrier-name">FedEx 2-Day</span>
                <span className="carrier-desc">Arrives on your exact day</span>
                <span className="carrier-price">
                  {unitPrice ? formatCents(unitPrice.shipPerUnitCents) : ""}
                </span>
              </button>
              <button
                className={
                  "carrier-card" + (carrier === "usps" ? " selected" : "")
                }
                onClick={() => pickCarrier("usps")}
              >
                <span className="carrier-name">USPS First Class</span>
                <span className="carrier-desc">
                  Arrives within 2 days of your pick
                </span>
                <span className="carrier-price">
                  {formatCents(pricing.uspsShipPerUnitCents)}
                </span>
              </button>
            </div>
          )}
          <p className="note earliest-hint">
            {carrier === "usps" ? (
              <>
                Soonest target day{" "}
                <strong>
                  {formatYmd(minDeliveryDate(deliveryCfg, "usps"))}
                </strong>{" "}
                — First Class mail takes {uspsSpreadLabel(deliveryCfg)} days,
                so your piñata lands within {uspsWindowLabel(deliveryCfg)} of
                the day you pick.
              </>
            ) : (
              <>
                Soonest arrival{" "}
                <strong>{formatYmd(minDeliveryDate(deliveryCfg))}</strong> — we
                need a day to make your piñata plus two FedEx days to fly it
                there.
              </>
            )}
          </p>
          <DateCalendar
            key={carrier}
            value={date}
            onChange={(d) => {
              setDate(d);
              track("delivery_date_picked", { date: d, carrier });
            }}
            cfg={deliveryCfg}
            carrier={carrier}
          />
          {!date ? (
            <p className="note">
              Tap a day — grayed-out days aren&apos;t available.
            </p>
          ) : dateProblem ? (
            <div className="notice warn">{dateProblem}</div>
          ) : carrier === "usps" ? (
            <div className="notice info">
              Arrives {formatWindow(uspsWindow(date, deliveryCfg))} — USPS
              windows run {uspsWindowLabel(deliveryCfg)} either side of{" "}
              {formatYmd(date)}.
            </div>
          ) : (
            <div className="notice info">Arrives {formatYmd(date)}.</div>
          )}
          {hasCartAddress && (
            <p className="note ship-to-note">
              Ships to {cartAddress!.name}, {cartAddress!.city} — change in your
              cart.
            </p>
          )}
        </div>
      )}

      {step === "Send to" && (
        <div className="step-panel">
          <p className="note">
            Where should this order go? Everything in your cart ships here —
            one address per checkout (you can edit it in the cart).
          </p>

          {savedAddresses.length > 0 && (
            <div className="addr-cards">
              {savedAddresses.map((a) => {
                const key = addressKey(a);
                return (
                  <button
                    key={key}
                    className={
                      "addr-card" + (key === selectedSavedKey ? " selected" : "")
                    }
                    onClick={() => setAddress(a)}
                  >
                    {formatAddress(a)}
                  </button>
                );
              })}
              <button
                className="addr-card new"
                onClick={() => setAddress(EMPTY_ADDRESS)}
              >
                + New address
              </button>
            </div>
          )}

          {ADDRESS_FIELDS.map(([key, label]) =>
            key === "address1" ? (
              // Shopify-checkout style: the Address field itself suggests
              // as you type; picking fills street/city/state/ZIP.
              <AddressLine1
                key={key}
                value={address.address1}
                onChange={(v) => setAddress((a) => ({ ...a, address1: v }))}
                onPick={(picked) =>
                  setAddress((prev) => ({ ...prev, ...picked }))
                }
              />
            ) : (
              // Shopify-checkout style: the label floats INSIDE the input
              // (placeholder=" " keeps :placeholder-shown working).
              <div className="ffield" key={key}>
                <input
                  id={`addr-${key}`}
                  placeholder=" "
                  value={address[key]}
                  onChange={(e) =>
                    setAddress((a) => ({ ...a, [key]: e.target.value }))
                  }
                />
                <label htmlFor={`addr-${key}`}>{label}</label>
              </div>
            ),
          )}

          {cartError && (
            <div className="notice warn">
              This design is too large to save — try fewer or smaller photos.
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className={"flow-root" + (choosing ? " wide" : "")}>
      <div className="chips">
        <button className="chip done" onClick={openSwitcher}>
          <span className="chip-num">1 ·</span> {styleInfo.name} ▾
        </button>
        {visibleSteps.map(({ s, idx }, vi) => {
          // done/reachable math runs on the ORIGINAL index; the number the
          // customer sees runs on the visible position, so it stays
          // contiguous when Add-ons or Send-to is skipped.
          const unreachable = idx > Math.max(stepIndex, reachable);
          return (
            <button
              key={s}
              className={
                "chip" +
                (s === step ? " active" : "") +
                (idx < stepIndex ? " done" : "")
              }
              disabled={unreachable}
              aria-disabled={unreachable}
              aria-current={s === step ? "step" : undefined}
              onClick={() => !unreachable && goStep(s)}
            >
              {idx < stepIndex ? "✓ " : ""}
              <span className="chip-num">{vi + 2} ·</span> {s}
            </button>
          );
        })}
      </div>

      {switcherOpen && (
        <div className="switcher">
          <p className="note">
            Swap the body style — your graphic, message and everything else
            stay put.
          </p>
          {!switcherStyles ? (
            <p className="note">Loading styles…</p>
          ) : (
            <div className="switcher-grid">
              {switcherStyles
                .filter((s) => s.inStock)
                .map((s) => (
                  <button
                    key={s.id}
                    className={
                      "style-card" + (s.id === styleInfo.id ? " selected" : "")
                    }
                    onClick={() => swapStyle(s)}
                  >
                    {s.imageUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={s.imageUrl} alt={s.name} loading="lazy" />
                    ) : null}
                    <div className="style-name">{s.name}</div>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

      {showHeading && (
        // Visually hidden: the numbered chips ARE the step indicator now
        // (frees ~50px of vertical space). Kept in the DOM for screen
        // readers and as the focus target on step change.
        <h1 className="step-h1 visually-hidden" tabIndex={-1}>
          {stepHeading}
        </h1>
      )}

      {!choosing ? (
        // One grid for every step. Mobile: rail above steps on the graphic/
        // message steps, hidden on the docked ones (rail-docked) — exactly
        // the old behavior. Desktop (>=1024px CSS): the rail becomes a big
        // STICKY preview column on the left of every step, with the order
        // summary card under it replacing the bottom dock.
        <div
          className={
            "flow-grid" +
            (dockVisible ? " has-dock" : "") +
            (docked ? " rail-docked" : "")
          }
        >
          {steps}
          <aside
            className={
              "flow-rail" + (step === "Message" ? " msg-compact" : "")
            }
          >
            <BoxPreview
              styleName={styleInfo.name}
              boxImageUrl={styleInfo.boxImageUrl}
              logoZone={styleInfo.logoZone}
              artUrl={artUrl}
              message={message}
              filling={filling}
              deliveryDate={null}
              mode={step === "Message" ? "open" : "closed"}
              variant="bare"
              interiorUrl={boxInterior?.interiorUrl}
              messageZone={boxInterior?.messageZone}
              messageCard={messageCard}
              messagePadding={boxInterior?.messageCardPadding}
              pinataSrc={styleInfo.cutoutUrl ?? `/pinatas/${styleInfo.id}.png`}
              pinataFallback={styleInfo.imageUrl}
              pinataZone={styleInfo.pinataZone}
            />
            <div className="desk-summary">
              <strong className="desk-summary-title">{summaryTitle}</strong>
              <span className="desk-summary-detail">{summaryDetail}</span>
              {deliveredCents !== null && (
                <div className="desk-summary-price">
                  <strong>{formatCents(deliveredCents)}</strong>
                  <span>shipping included</span>
                </div>
              )}
              {primaryCta && (
                <button
                  className="btn primary desk-summary-cta"
                  disabled={primaryCta.disabled}
                  onClick={primaryCta.onClick}
                >
                  {primaryCta.label}
                </button>
              )}
            </div>
          </aside>
        </div>
      ) : (
        <div>{steps}</div>
      )}

      {dockVisible && (
        <div className="bottom-stack">
          {primaryCta && (
            <div className="cta-bar">
              <button
                className="btn primary cta-btn"
                disabled={primaryCta.disabled}
                onClick={primaryCta.onClick}
              >
                {primaryCta.label}
              </button>
            </div>
          )}
          {dockOpen ? (
            <div className="build-dock">
              <div className="dock-inner">
              <div className="dock-thumb box-composite">
                {styleInfo.boxImageUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={styleInfo.boxImageUrl} alt="" className="box-img" />
                ) : null}
                {artUrl && styleInfo.logoZone && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={artUrl}
                    alt=""
                    className="box-art"
                    style={{
                      left: `${styleInfo.logoZone.x * 100}%`,
                      top: `${styleInfo.logoZone.y * 100}%`,
                      width: `${styleInfo.logoZone.w * 100}%`,
                      height: `${styleInfo.logoZone.h * 100}%`,
                    }}
                  />
                )}
              </div>
              <div className="dock-info">
                <strong>{summaryTitle}</strong>
                <span>{summaryDetail}</span>
              </div>
              {deliveredCents !== null && (
                <div className="dock-price">
                  <strong>{formatCents(deliveredCents)}</strong>
                  <span>shipping included</span>
                </div>
              )}
              <button
                type="button"
                className="dock-toggle"
                aria-label="Collapse the order summary"
                aria-expanded="true"
                onClick={() => setDockOpen(false)}
              >
                ⌄
              </button>
            </div>
          </div>
          ) : (
            <button
              type="button"
              className="build-dock dock-closed"
              aria-label="Expand the order summary"
              aria-expanded="false"
              onClick={() => setDockOpen(true)}
            >
              <span className="dock-mini">
                <strong>{styleInfo.name}</strong>
                {deliveredCents !== null && (
                  <span className="dock-mini-price">
                    {formatCents(deliveredCents)} · shipping included
                  </span>
                )}
                <span className="dock-chev" aria-hidden>
                  ⌃
                </span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
