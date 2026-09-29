"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Image from "next/image";
import {
  addressComplete,
  addressKey,
  CART_EVENT,
  cartCarrier,
  cartSaveProblem,
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
  STORAGE_PROBLEM_COPY,
  type CartLine,
  type DeliveryAddress,
  type DesignAssets,
  type Filling,
  type GraphicChoice,
} from "@/lib/flow";
import {
  designKey,
  isCurrentDesign,
  type DesignDocument,
} from "@/lib/design-document";
import {
  designSaveState,
  designSavesVersion,
  saveDesignArt,
  subscribeDesignSaves,
} from "@/lib/design-upload";
import { discardEditorAutosave } from "@/lib/editor-autosave";
import {
  formatCents,
  HUB_URL,
  priceUrl,
  type BuilderPricing,
  type HubAddon,
  type HubBodyStyle,
  type HubFilling,
  type HubGraphicCategory,
  type HubGraphicEntry,
  type HubPrice,
  type LogoZone,
} from "@/lib/hub";
import {
  deliveryProblem,
  formatWindow,
  formatYmd,
  fromYmd,
  minDeliveryDate,
  uspsWindow,
  type Carrier,
  type DeliveryConfig,
} from "@/lib/delivery";
import {
  cdnThumb,
  clearLibraryState,
  EXCLUDED_PREFIXES,
  HOLIDAY_LABELS,
  loadJson,
  OCCASIONS,
  occasionOf,
  saveLibraryState,
  type LibraryGraphic,
} from "@/lib/library-data";
import type { VariantProfile } from "@/lib/variant";
import { track, trackAddToCart } from "@/lib/analytics";
import EditorShell from "./editor-shell";
import GraphicLibrary from "./graphic-library";
import BoxPreview from "./box-preview";
import DateCalendar from "./date-calendar";
import { stateCode } from "./address-search";
import RecipientForm, {
  addressErrors,
  addressErrorSummary,
  focusFirstAddressError,
  isPoBox,
} from "./recipient-form";

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

/* --- gift message -------------------------------------------------------------
 * The line's `message` is exactly what prints: the message, then the sign-off
 * on its own line — `${message}${from ? "\n— " + from : ""}`. Checkout keeps
 * the first 300 characters, so the flow caps the COMBINED text there (and
 * refuses input past it instead of letting the tail vanish at checkout). */
const MESSAGE_MAX = 300;

function composeMessage(body: string, from: string): string {
  const b = body.trim();
  const f = from.trim();
  return [b, f ? `— ${f}` : ""].filter(Boolean).join("\n");
}

/** A stored message back into its two fields (edit mode / refresh). */
function splitMessage(m: string): [string, string] {
  const i = m.lastIndexOf("\n— ");
  if (i >= 0 && !m.slice(i + 3).includes("\n")) {
    return [m.slice(0, i), m.slice(i + 3)];
  }
  if (m.startsWith("— ") && !m.includes("\n")) return ["", m.slice(2)];
  return [m, ""];
}

/* --- pet designs bring their filling -----------------------------------------
 * Design-code prefixes (lib/library-data OCCASIONS) whose piñata is for an
 * animal or a treat line. Picking one preselects the matching filling; the
 * auto-set label is remembered (sessionStorage, dies with the draft) so a
 * switch to an unrelated design can clear it again — a filling the shopper
 * picked by hand is never touched. */
const DESIGN_FILLINGS: Record<string, string> = {
  PUPYATA: "Dog Treats",
  CATYATA: "Cat Treats",
  REALSY: "Realsy Dates",
};
const FILLING_AUTO_KEY = "pinatagrams-builder-filling-auto";

function designFilling(design: string): string | null {
  return DESIGN_FILLINGS[design.replace(/[0-9]+$/, "").toUpperCase()] ?? null;
}

function rememberAutoFilling(label: string | null): void {
  try {
    if (label) sessionStorage.setItem(FILLING_AUTO_KEY, label);
    else sessionStorage.removeItem(FILLING_AUTO_KEY);
  } catch {}
}

function loadAutoFilling(): string | null {
  try {
    return sessionStorage.getItem(FILLING_AUTO_KEY);
  } catch {
    return null;
  }
}

/* --- delivery copy ----------------------------------------------------------- */
const CARRIER_NAMES: Record<Carrier, string> = {
  fedex: "FedEx 2-Day",
  usps: "USPS First Class",
};

/** "Oct 7 to Oct 12" — the USPS window in plain words. */
function windowWords(w: { start: string; end: string }): string {
  const md = (ymd: string) =>
    fromYmd(ymd).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  return `${md(w.start)} to ${md(w.end)}`;
}

/* --- deep links ---------------------------------------------------------------
 * ?occasion= opens the library on that aisle by pre-seeding its saved view
 * state (the library restores it on mount). Accepts a label slug
 * ("thank-you"), its first word ("love"), or a design-code prefix ("HBD"). */
function occasionSeed(
  raw: string,
): { a: string; s: string | null } | null {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  const want = slug(raw);
  if (!want) return null;
  if (want === "holidays" || want === "holiday") return { a: "holidays", s: null };
  const labels = [...new Set(Object.values(OCCASIONS))];
  const label =
    OCCASIONS[raw.trim().toUpperCase()] ??
    labels.find((l) => slug(l) === want) ??
    labels.find((l) => slug(l).split("-")[0] === want);
  if (!label) return null;
  if (label === "Birthday") return { a: "birthdays", s: null };
  if (HOLIDAY_LABELS.has(label)) return { a: "holidays", s: label };
  return { a: "occasions", s: label };
}

/* --- funnel events ----------------------------------------------------------- */
type StepVia = "continue" | "back" | "chip" | "restore" | "deeplink";
// step_index counts the body style (home page) as step 1 — matching the
// numbered chips when nothing is skipped.
const stepNumber = (s: Step) => STEPS.indexOf(s) + 2;

export default function DesignFlow({
  style,
  boxInterior,
  addonOptions,
  fillingOptions,
  deliveryCfg,
  pricing,
  variant,
  hubGraphics,
  hubCategories,
  styleNotice = null,
  openSwitcher: switcherAtStart = false,
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
  hubGraphics: HubGraphicEntry[];
  hubCategories: HubGraphicCategory[];
  // The requested body wasn't available and the page substituted one —
  // say so (and, for a cart edit, open the style switcher).
  styleNotice?: string | null;
  openSwitcher?: boolean;
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
  // The gift message and its sign-off, as typed. What prints (and what the
  // cart line/draft store) is composeMessage(message, from).
  const [message, setMessage] = useState("");
  const [from, setFrom] = useState("");
  // Set when a keystroke/paste was refused for going past MESSAGE_MAX.
  const [messageFull, setMessageFull] = useState(false);
  const [filling, setFilling] = useState<Filling | null>(null);
  // The filling label a pet design picked for the shopper (null = the
  // current filling, if any, was the shopper's own choice).
  const [fillingAuto, setFillingAuto] = useState<string | null>(null);
  const [addons, setAddons] = useState<string[]>([]);
  // Set when switching fillings dropped add-ons the new one doesn't allow.
  const [addonNotice, setAddonNotice] = useState<string | null>(null);
  const [date, setDate] = useState("");
  // One carrier per ORDER (one draft = one shipping line): a new piñata
  // starts on the cart's carrier; picking a different one on the Delivery
  // step says clearly that it switches the whole order, and only then
  // (at add-to-cart) re-stamps the other lines.
  const [carrier, setCarrier] = useState<Carrier>("fedex");
  const [address, setAddress] = useState<DeliveryAddress>(EMPTY_ADDRESS);
  // The ONE ship-to address for the whole cart (all piñatas go to it). Set
  // by the first piñata; every piñata after inherits it, so the address
  // step is skipped for them (and reappears once the cart is emptied).
  // Kept in sync with the cart via CART_EVENT / storage.
  const [cartAddress, setCartAddress] = useState<DeliveryAddress | null>(null);
  // The cart's lines (same sync) — the carrier notice re-validates their
  // dates against a carrier switch before anything is re-stamped.
  const [cartLines, setCartLines] = useState<CartLine[]>([]);
  const [savedAddresses, setSavedAddresses] = useState<DeliveryAddress[]>([]);
  const [editLineId, setEditLineId] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(switcherAtStart);
  const [switcherStyles, setSwitcherStyles] = useState<HubBodyStyle[] | null>(null);
  // The build dock: running summary + price, collapsible, on every step.
  const [dockOpen, setDockOpen] = useState(true);
  const [unitPrice, setUnitPrice] = useState<HubPrice | null>(null);
  // STATE, not a ref: the persist effect must not run until the commit AFTER
  // the restore lands, or it clobbers the stored draft with empty state.
  const [hydrated, setHydrated] = useState(false);
  // Why the step's button can't go on yet — shown right beside it, on
  // whichever step it was tapped (not only Send-to, as before).
  const [ctaMsg, setCtaMsg] = useState<string | null>(null);
  // Top-of-flow notices (a substituted body style, a restored filling or
  // extra that no longer exists, a deep link we couldn't honor).
  const [notices, setNotices] = useState<string[]>(() =>
    styleNotice ? [styleNotice] : [],
  );
  // A ?design= deep link is being resolved (graphics.json in flight).
  const [deepLinkPending, setDeepLinkPending] = useState(false);
  // Send-to: show every field's problem once the button was tapped; the key
  // remounts the form (clearing its per-field "visited" marks) for "+ New".
  const [sendToErrors, setSendToErrors] = useState(false);
  const [addrFormKey, setAddrFormKey] = useState(0);
  // Delivery step: changing the cart's one address inline, and the
  // "Someone else?" explanation.
  const [changingAddr, setChangingAddr] = useState<DeliveryAddress | null>(
    null,
  );
  const [changeErrors, setChangeErrors] = useState(false);
  const [someoneElse, setSomeoneElse] = useState(false);
  // The editor has work that leaving would lose; asking before discarding.
  const [editorDirty, setEditorDirty] = useState(false);
  const [discardAsk, setDiscardAsk] = useState<{ go: () => void } | null>(
    null,
  );

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
      setCartLines(lines);
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

  // Funnel bookkeeping (step_viewed / step_completed): how the NEXT step
  // change happens, and when the current step was entered.
  const navVia = useRef<StepVia>("restore");
  const stepSince = useRef<{ step: Step; at: number } | null>(null);
  const stepRef = useRef<Step>(step);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  const completeStep = useCallback((s: Step) => {
    const since = stepSince.current;
    track("step_completed", {
      flow_version: "v1",
      step: STEP_SLUGS[s],
      step_index: stepNumber(s),
      ms_on_step: since && since.step === s ? Date.now() - since.at : null,
    });
  }, []);

  const goStep = useCallback(
    (s: Step, via: StepVia = "continue") => {
      // Moving forward completes the step being left.
      if (STEPS.indexOf(s) > STEPS.indexOf(stepRef.current)) {
        completeStep(stepRef.current);
      }
      navVia.current = via;
      setCtaMsg(null);
      // The body-style switcher is transient chrome, not a step: navigating
      // anywhere while it's open means "keep this body" — collapse it.
      setSwitcherOpen(false);
      setStepState(s);
      setGraphicModeState(null);
      writeUrl(s, null, true);
    },
    [writeUrl, completeStep],
  );

  const goView = useCallback(
    (v: "library" | "canvas" | null) => {
      setSwitcherOpen(false);
      setCtaMsg(null);
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

  // Leaving the editor with unsaved work asks first ("Discard this
  // design?") — for the in-app ← Back, the chips, and browser Back (which
  // re-pushes the editor's entry, asks, and only then really goes back).
  const editorDirtyRef = useRef(false);
  useEffect(() => {
    editorDirtyRef.current = editorDirty;
  }, [editorDirty]);
  const leavingEditor = useRef(false);
  const canvasUrl = useRef<string | null>(null);
  useEffect(() => {
    if (graphicMode === "canvas") canvasUrl.current = window.location.href;
  }, [graphicMode]);
  const guardEditorExit = (go: () => void) => {
    if (graphicMode === "canvas" && editorDirtyRef.current) {
      setDiscardAsk({ go });
    } else {
      go();
    }
  };

  // Deep link (?design=CODE): the Classic, a hub graphic this storefront
  // serves (on this body), or a library design inside the variant's library
  // scope. graphics.json is fetched ONLY here — never for a plain visit.
  const resolveDeepLink = async (
    raw: string,
  ): Promise<GraphicChoice | null> => {
    const code = raw.toUpperCase();
    if (!/^[A-Z0-9]{2,24}$/.test(code)) return null;
    if (code === CLASSIC_GRAPHIC.design) return CLASSIC_GRAPHIC;
    const hub = hubGraphics.find((h) => h.design.toUpperCase() === code);
    if (hub) {
      // same rule the library applies to its hub shelves
      const wearable =
        hub.bodyStyles === "all" || hub.bodyStyles.includes(style.id);
      const inScope =
        variant.library !== "birthday" || hub.category === "birthday";
      return wearable && inScope
        ? {
            type: "hub",
            design: hub.design,
            title: hub.title,
            thumb: hub.thumb,
            art: hub.art,
            artSha256: hub.artSha256,
          }
        : null;
    }
    if (variant.library === "none") return null;
    if (EXCLUDED_PREFIXES.has(code.replace(/[0-9]+$/, ""))) return null;
    const manifest = await loadJson<{ graphics: LibraryGraphic[] }>(
      "/graphics.json",
    );
    const g = manifest?.graphics.find((x) => x.design.toUpperCase() === code);
    if (!g) return null;
    if (variant.library === "birthday" && occasionOf(g.design) !== "Birthday") {
      const col = await loadJson<{ birthday?: string[] }>("/collections.json");
      if (!col?.birthday?.includes(g.design)) return null;
    }
    return {
      type: "shopify",
      design: g.design,
      title: g.title,
      thumb: g.thumb,
      art: g.art,
      message: g.message ?? null,
    };
  };

  // Restore draft + URL step on mount, then keep listening for back/forward.
  useEffect(() => {
    setSavedAddresses(loadAddresses());
    const params = new URLSearchParams(window.location.search);
    const urlEdit = params.get("edit");
    let d = loadDraft();
    // An edit-mode draft is only valid when this page was entered through the
    // cart's Edit button (?edit=<lineId>). Otherwise an abandoned edit would
    // contaminate a fresh pinata and silently REPLACE the old cart line.
    if (d?.editLineId && d.editLineId !== urlEdit) {
      clearDraft();
      rememberAutoFilling(null);
      d = null;
    }
    let g: GraphicChoice | null = null;
    let f: Filling | null = null;
    let dt = "";
    if (d) {
      // A draft carries across style changes (swap keeps your work).
      g = d.graphic;
      dt = d.date;
      // A filling or extra the hub has since retired can't be ordered —
      // clear it VISIBLY here rather than let checkout refuse the line.
      const notes: string[] = [];
      const fRec = d.filling
        ? fillingOptions.find((x) => x.label === d!.filling)
        : undefined;
      if (d.filling && !fRec) {
        notes.push(`${d.filling} isn't available anymore — pick another filling.`);
      }
      f = fRec ? fRec.label : null;
      const saved = d.addons ?? [];
      const live = saved.filter((id) => addonOptions.some((a) => a.id === id));
      if (live.length < saved.length) {
        notes.push(
          saved.length - live.length === 1
            ? "An extra you picked isn't available anymore — we took it off."
            : "Some extras you picked aren't available anymore — we took them off.",
        );
      }
      const kept = live.filter((id) => fillingAllowsAddon(fRec, id));
      if (fRec && kept.length < live.length) {
        const names = live
          .filter((id) => !kept.includes(id))
          .map((id) => addonOptions.find((a) => a.id === id)?.label ?? id)
          .join(", ");
        notes.push(`${names} isn't available with ${fRec.label} — we took it off.`);
      }
      if (notes.length) setNotices((n) => [...n, ...notes]);
      const [body, sign] = splitMessage(d.message ?? "");
      setGraphic(d.graphic);
      setMessage(body);
      setFrom(sign);
      setFilling(f);
      setAddons(kept);
      setDate(d.date);
      const a = d.address ?? EMPTY_ADDRESS;
      setAddress({ ...a, province: stateCode(a.province) || a.province });
      setEditLineId(d.editLineId ?? null);
      const auto = loadAutoFilling();
      if (auto && auto === f) setFillingAuto(auto);
    }
    // The first step_viewed: a refresh / cart edit restores; a fresh start
    // came from the body picker (a Continue from step 1). Deep links below
    // override.
    navVia.current = d || params.get("step") ? "restore" : "continue";
    // Carrier: the draft's own choice survives a refresh; a NEW piñata
    // starts on the carrier the cart already ships with (one carrier per
    // order — starting elsewhere used to re-carrier and re-price the lines
    // already in the cart at add-to-cart). Empty cart → FedEx 2-Day.
    // A variant that doesn't offer USPS forces FedEx regardless of draft.
    const others = loadCart().filter((l) => l.id !== (d?.editLineId ?? null));
    setCarrier(
      uspsOffered
        ? (d?.carrier ?? (others.length ? cartCarrier(others) : "fedex"))
        : "fedex",
    );
    // The page may have substituted the body style (the requested one was
    // missing or out of stock) — keep the URL honest so a refresh agrees.
    if (params.get("style") !== style.id) {
      const u = new URL(window.location.href);
      u.searchParams.set("style", style.id);
      window.history.replaceState({}, "", u);
    }
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

    // Deep links (ads, QR codes): ?design=CODE preselects that graphic and
    // lands on its confirm screen; ?occasion= opens the library on that
    // aisle. Cart edits ignore both. The params are stripped once applied
    // so a refresh restores the draft instead of re-applying the link.
    const designParam = urlEdit ? null : params.get("design")?.trim() || null;
    const occasionParam = urlEdit
      ? null
      : params.get("occasion")?.trim() || null;
    const stripDeepLink = (view: "library" | null) => {
      const u = new URL(window.location.href);
      u.searchParams.delete("design");
      u.searchParams.delete("occasion");
      u.searchParams.set("step", "graphic");
      if (view) u.searchParams.set("view", view);
      else u.searchParams.delete("view");
      window.history.replaceState({}, "", u);
    };
    if (occasionParam) {
      const seed = occasionSeed(occasionParam);
      if (seed) saveLibraryState({ q: "", a: seed.a, s: seed.s, y: 0 });
    }
    if (designParam) {
      navVia.current = "deeplink";
      setStepState("Graphic");
      setGraphicModeState(null);
      setDeepLinkPending(true);
      void resolveDeepLink(designParam).then((picked) => {
        if (picked) {
          applyGraphicRef.current(picked);
          track("graphic_picked", {
            design: picked.design,
            source: "deeplink",
          });
        } else {
          setNotices((n) => [
            ...n,
            "That design isn't available here — pick one below.",
          ]);
        }
        setStepState("Graphic");
        setGraphicModeState(null);
        setDeepLinkPending(false);
        stripDeepLink(null);
      });
    } else if (occasionParam) {
      navVia.current = "deeplink";
      if (!g) {
        setStepState("Graphic");
        setGraphicModeState("library");
        stripDeepLink("library");
      } else {
        applyUrl();
        stripDeepLink(null);
      }
    } else {
      applyUrl();
    }
    if (switcherAtStart) void loadSwitcherStyles();
    setHydrated(true);

    const onPop = () => {
      if (leavingEditor.current) {
        leavingEditor.current = false;
      } else if (
        stateRef.current.graphicMode === "canvas" &&
        editorDirtyRef.current
      ) {
        // Browser Back out of an editor holding unsaved work: put the
        // editor's entry back and ask inline; Discard really goes back.
        window.history.pushState(
          {},
          "",
          canvasUrl.current ?? window.location.href,
        );
        setDiscardAsk({
          go: () => {
            leavingEditor.current = true;
            window.history.back();
          },
        });
        return;
      }
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
      navVia.current = "back";
      setCtaMsg(null);
      setDiscardAsk(null);
      setSwitcherOpen(false);
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

  // No-custom storefronts have no choice screen — the library IS the
  // graphic step. Runs on every visit to the bare step (incl. back-nav),
  // so the choice cards never flash into view. (Not while a ?design= deep
  // link is still resolving — it's about to fill the graphic.)
  useEffect(() => {
    if (!hydrated || variant.allowCustom || deepLinkPending) return;
    if (step === "Graphic" && !graphic && graphicMode === null) {
      goView("library");
    }
  }, [
    hydrated,
    step,
    graphic,
    graphicMode,
    variant.allowCustom,
    deepLinkPending,
    goView,
  ]);

  // Mirror gating inputs for the popstate handler (stale-closure-proof).
  const stateRef = useRef({ graphic, filling, date, graphicMode });
  useEffect(() => {
    stateRef.current = { graphic, filling, date, graphicMode };
  }, [graphic, filling, date, graphicMode]);

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

  // Funnel step-view tracking: one step_viewed each time the customer LANDS
  // on a step (flow_version v1; `via` = continue / chip / back / restore /
  // deeplink), timed so step_completed can report ms_on_step. The older
  // message_/addons_step_viewed events stay for existing dashboards — those
  // two steps were the only ones with no "reached this step" signal.
  useEffect(() => {
    if (!hydrated) return;
    stepSince.current = { step, at: Date.now() };
    track("step_viewed", {
      flow_version: "v1",
      step: STEP_SLUGS[step],
      step_index: stepNumber(step),
      via: navVia.current,
    });
    if (step === "Message") track("message_step_viewed");
    else if (step === "Add-ons") track("addons_step_viewed");
  }, [hydrated, step]);

  // Persist the draft on every meaningful change (only once hydrated —
  // never on the initial commit, which still holds empty state). The
  // message is stored exactly as it will print (sign-off included).
  const printedMessage = composeMessage(message, from);
  useEffect(() => {
    if (!hydrated) return;
    saveDraft({
      styleId: styleInfo.id,
      graphic,
      message: printedMessage,
      filling,
      addons,
      date,
      carrier,
      address,
      editLineId,
    });
  }, [hydrated, styleInfo.id, graphic, printedMessage, filling, addons, date, carrier, address, editLineId]);

  // The auto-picked filling rides beside the draft (the draft's shape is
  // shared with the cart; this is flow-only bookkeeping).
  useEffect(() => {
    if (!hydrated) return;
    rememberAutoFilling(fillingAuto && fillingAuto === filling ? fillingAuto : null);
  }, [hydrated, fillingAuto, filling]);

  const stepIndex = STEPS.indexOf(step);
  const reachable = maxStep(graphic, filling, date);

  // Clamp down if the current step is no longer reachable — e.g. the cart's
  // address just loaded (hasCartAddress → true), so "Send to" collapses into
  // Delivery. Runs after the initial async cart read settles.
  useEffect(() => {
    if (!hydrated) return;
    if (stepIndex > reachable) {
      navVia.current = "restore";
      setStepState(STEPS[reachable]);
      writeUrl(STEPS[reachable], null, false);
    }
  }, [hydrated, stepIndex, reachable, writeUrl]);

  // Previews composite a CDN-resized variant (~60KB), never the print-res
  // original (multi-MB) — that was a visible delay before the graphic
  // appeared on the box. Checkout still sends the full-res URL to Paper.
  // Hub graphics have no CDN resizer — their upload-time thumb plays that
  // role.
  const artUrl = graphic
    ? graphic.type === "custom"
      ? graphic.preview
      : graphic.type === "hub"
        ? (graphic.thumb ?? graphic.art)
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
  // silently (the checkout enforces the same rule server-side). "auto" =
  // a pet design chose it (remembered, so a design switch can undo it).
  const chooseFilling = (f: HubFilling, how: "user" | "auto") => {
    setFilling(f.label);
    setFillingAuto(how === "auto" ? f.label : null);
    setCtaMsg(null);
    if (how === "user") track("filling_selected", { filling: f.label });
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
  const pickFilling = (f: HubFilling) => chooseFilling(f, "user");

  // Every way a graphic arrives (library, Classic, design-your-own, deep
  // link) goes through here: dog/cat/Realsy designs bring their filling
  // along (never over one the shopper picked themselves), and a filling
  // the FLOW picked leaves again when the new design doesn't match it.
  const applyGraphic = (g: GraphicChoice) => {
    setGraphic(g);
    setCtaMsg(null);
    const want = g.type === "custom" ? null : designFilling(g.design);
    const rec = want
      ? fillingOptions.find((x) => x.label.toLowerCase() === want.toLowerCase())
      : undefined;
    const autoHeld = fillingAuto !== null && filling === fillingAuto;
    if (rec) {
      if ((!filling || autoHeld) && filling !== rec.label) {
        chooseFilling(rec, "auto");
      }
    } else if (autoHeld) {
      setFilling(null);
      setFillingAuto(null);
    }
  };
  // The deep-link resolver finishes after mount — it must reach the CURRENT
  // applyGraphic (current filling state), not the first render's.
  const applyGraphicRef = useRef(applyGraphic);
  useEffect(() => {
    applyGraphicRef.current = applyGraphic;
  });

  const selectedSavedKey = addressKey(address);

  /* --- custom design: the print upload ---------------------------------------
   * "Use this design" hands the print file to lib/design-upload, which keeps
   * uploading after the editor unmounts. This screen watches it: status on
   * the confirm screen, Add to cart held until the art + its sha256 exist
   * (checkout refuses a custom line without them), Retry from right here. A
   * restored design that never finished uploading (the tab reloaded, or it
   * predates this) re-renders from its document and uploads on its own. */
  useSyncExternalStore(subscribeDesignSaves, designSavesVersion, () => 0);
  const customDesign = graphic?.type === "custom" ? graphic.design : null;
  const customKey = useMemo(
    () =>
      customDesign && isCurrentDesign(customDesign)
        ? designKey(customDesign)
        : null,
    [customDesign],
  );
  const saveState = customKey ? designSaveState(customKey) : null;
  const artStatus: "ready" | "saving" | "failed" | "remake" =
    graphic?.type !== "custom" || (graphic.art && graphic.artSha256)
      ? "ready"
      : !customKey
        ? "remake" // an old freeform design — only re-making it can fix it
        : saveState?.status === "failed"
          ? "failed"
          : "saving";
  const retryArt = () => {
    if (customDesign && isCurrentDesign(customDesign)) {
      void saveDesignArt(customDesign);
    }
  };

  // Patch the uploaded assets onto the flow's graphic — and onto any cart
  // line holding THIS design that went in without them (lines saved before
  // add-to-cart waited). Identity = the design document itself: patching by
  // "art-less" alone would stamp SOME OTHER design's art + its validly-
  // matching hash onto an unrelated line, and Paper would print the wrong
  // piñata with a passing integrity check.
  const applyAssets = useCallback((key: string, assets: DesignAssets) => {
    setGraphic((prev) =>
      prev?.type === "custom" &&
      !(prev.art === assets.art && prev.artSha256 === assets.artSha256) &&
      isCurrentDesign(prev.design) &&
      designKey(prev.design) === key
        ? {
            ...prev,
            art: assets.art,
            designUrl: assets.designUrl,
            artSha256: assets.artSha256,
          }
        : prev,
    );
    const lines = loadCart();
    let touched = false;
    const next = lines.map((l) => {
      if (l.graphic.type !== "custom") return l;
      if (l.graphic.art && l.graphic.artSha256) return l;
      const doc = l.graphic.design;
      if (!isCurrentDesign(doc) || designKey(doc) !== key) return l;
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
  }, []);

  useEffect(() => {
    if (customKey && saveState?.status === "saved") {
      applyAssets(customKey, saveState.assets);
    }
  }, [customKey, saveState, applyAssets]);

  useEffect(() => {
    if (!hydrated || !customKey || !customDesign) return;
    if (graphic?.type === "custom" && graphic.art && graphic.artSha256) return;
    if (designSaveState(customKey)) return; // already saving / saved / failed
    void saveDesignArt(customDesign);
    // keyed on the design; the other reads are guards
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, customKey]);

  // The reason Add to cart is held for the art, shown beside the button.
  const artHint: ReactNode =
    artStatus === "saving" ? (
      <>
        <span className="mini-spinner" aria-hidden /> Saving your design —
        one moment…
      </>
    ) : artStatus === "failed" ? (
      <>
        Your design didn&apos;t save.{" "}
        <button type="button" className="link-btn" onClick={retryArt}>
          Retry
        </button>
      </>
    ) : artStatus === "remake" ? (
      <>
        This design was made in an older editor — open the Graphic step and
        tap “Edit this graphic” to make it again.
      </>
    ) : null;

  /* --- one carrier per order ---------------------------------------------------
   * The lines already in the cart (not the one being edited) and whether
   * this piñata's carrier differs from theirs. A switch is only ever made
   * by the shopper, in plain sight: the Delivery step says what changes, the
   * other lines' dates are re-checked for the new carrier, and only then
   * does add-to-cart re-stamp them. */
  const otherLines = cartLines.filter((l) => l.id !== editLineId);
  const orderCarrier: Carrier | null = otherLines.length
    ? cartCarrier(otherLines)
    : null;
  const carrierSwitch = otherLines.some(
    (l) => (l.carrier === "usps" ? "usps" : "fedex") !== carrier,
  );
  const switchStuck = carrierSwitch
    ? otherLines.filter((l) => deliveryProblem(l.deliveryDate, deliveryCfg, carrier))
    : [];
  const lineName = (l: CartLine) =>
    l.graphic.type === "custom"
      ? `Your design — ${l.styleName}`
      : l.graphic.type === "hub"
        ? `Your graphic — ${l.styleName}`
        : `${l.graphic.title} — ${l.styleName}`;
  const stuckText = switchStuck.length
    ? `${switchStuck
        .map((l) => `${lineName(l)} (${formatYmd(l.deliveryDate)})`)
        .join(", ")} can't arrive by ${CARRIER_NAMES[carrier]} on ${
        switchStuck.length === 1 ? "its date" : "their dates"
      } — ${
        uspsOffered
          ? `keep ${CARRIER_NAMES[orderCarrier ?? "fedex"]} for this order, or change`
          : "change"
      } ${switchStuck.length === 1 ? "that date" : "those dates"} from your cart first.`
    : "";
  // The cart's address can't take FedEx if it's a PO box.
  const cartPoBox =
    hasCartAddress && carrier === "fedex" && isPoBox(cartAddress!);
  const poBoxText = uspsOffered
    ? "FedEx can't deliver to PO boxes — change the address or choose USPS."
    : "FedEx can't deliver to PO boxes — change the address to a street address.";

  // One source for the order-summary strings — the mobile bottom dock and
  // the desktop rail card must never drift apart.
  // Hub-graphic titles are INTERNAL (hub organization only) — customer
  // surfaces show a generic name; the box preview shows the actual art.
  const summaryTitle =
    graphic?.type === "custom"
      ? `Your design — ${styleInfo.name}`
      : graphic?.type === "hub"
        ? `Your graphic — ${styleInfo.name}`
        : graphic
          ? `${graphic.title} — ${styleInfo.name}`
          : styleInfo.name;
  const summaryDetail =
    [
      printedMessage
        ? `“${printedMessage.slice(0, 22)}${printedMessage.length > 22 ? "…" : ""}”`
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
  const loadSwitcherStyles = async () => {
    if (switcherStyles) return;
    try {
      const r = await fetch(`${HUB_URL}/api/public/catalog`);
      if (r.ok) setSwitcherStyles((await r.json()).bodyStyles ?? []);
    } catch {}
  };

  const openSwitcher = () => {
    setSwitcherOpen((o) => !o);
    void loadSwitcherStyles();
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
    // a substituted-style notice is answered once they pick a body
    if (styleNotice) setNotices((n) => n.filter((x) => x !== styleNotice));
    const u = new URL(window.location.href);
    u.searchParams.set("style", s.id);
    window.history.replaceState({}, "", u);
  };

  /* --- the gift message ---------------------------------------------------- */
  // Refuse (don't truncate) input that would push the printed text past
  // MESSAGE_MAX — the counter says why.
  const editMessage = (nextBody: string, nextFrom: string) => {
    if (
      composeMessage(nextBody, nextFrom).length > MESSAGE_MAX &&
      nextBody.length + nextFrom.length > message.length + from.length
    ) {
      setMessageFull(true);
      return;
    }
    setMessageFull(false);
    setMessage(nextBody);
    setFrom(nextFrom);
  };
  const messageLeft = MESSAGE_MAX - printedMessage.length;

  /* --- cart ---------------------------------------------------------------- */
  const addToCart = () => {
    // Every piñata ships to the ONE cart address: an established one is
    // inherited (the address step was skipped), else the one just entered.
    const shipTo = hasCartAddress ? cartAddress! : address;
    if (!graphic || !filling) return; // unreachable: the steps gate these
    // The button stays enabled; tapping it says what's missing instead.
    if (dateProblem) {
      setCtaMsg(date ? dateProblem : "Pick a delivery day above.");
      return;
    }
    if (!hasCartAddress) {
      const errs = addressErrors(shipTo, carrier, uspsOffered);
      if (Object.keys(errs).length) {
        setSendToErrors(true);
        focusFirstAddressError(errs, "addr");
        setCtaMsg(addressErrorSummary(errs));
        return;
      }
    } else if (carrier === "fedex" && isPoBox(shipTo)) {
      setCtaMsg(poBoxText);
      return;
    }
    if (artStatus !== "ready") return; // the button is disabled + says why
    const lines = loadCart();
    // "Save changes" to a line that no longer exists (removed in another tab)
    // must APPEND, not silently vanish.
    const existing = editLineId
      ? lines.find((l) => l.id === editLineId)
      : undefined;
    // ONE carrier per order (one draft = one shipping line). The lines
    // already in the cart only change carrier when the shopper picked a
    // different one here (the Delivery step spelled that out) — and never
    // onto a date that carrier can't make.
    const others = lines.filter((l) => l.id !== editLineId);
    const switching = others.some(
      (l) => (l.carrier === "usps" ? "usps" : "fedex") !== carrier,
    );
    if (
      switching &&
      others.some((l) => deliveryProblem(l.deliveryDate, deliveryCfg, carrier))
    ) {
      setCtaMsg(
        stuckText ||
          `A piñata in your cart can't arrive by ${CARRIER_NAMES[carrier]} on its date — change that date from your cart first.`,
      );
      return;
    }
    const line = {
      id: existing ? existing.id : newLineId(),
      styleId: styleInfo.id,
      styleName: styleInfo.name,
      boxImageUrl: styleInfo.boxImageUrl,
      logoZone: styleInfo.logoZone,
      graphic,
      // exactly what prints: the message, then "— From" on its own line
      message: printedMessage,
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
    const merged = existing
      ? lines.map((l) => (l.id === existing.id ? line : l))
      : [...lines, line];
    const next = switching ? merged.map((l) => ({ ...l, carrier })) : merged;
    if (!saveCart(next)) {
      // Said beside THIS button, on whichever step it was tapped. A blocked
      // browser (private mode) is not a design that's "too large".
      setCtaMsg(
        cartSaveProblem() === "blocked"
          ? STORAGE_PROBLEM_COPY.blocked
          : graphic.type === "custom"
            ? "This design is too large to save — try fewer or smaller photos."
            : STORAGE_PROBLEM_COPY.full,
      );
      return;
    }
    completeStep(step);
    rememberAddress(shipTo);
    setCartAddress(shipTo);
    clearDraft();
    rememberAutoFilling(null);
    clearLibraryState(); // the next piñata browses the library fresh
    trackAddToCart(deliveredCents);
    // Straight to the cart — no success interstitial. A full navigation also
    // disarms the flow so browser Back can't resurrect a completed line.
    // (Never mid-upload: a custom line only gets here once its art is up.)
    window.location.assign("/cart");
  };

  // The final button saves over the line being edited.
  const addLabel = editLineId ? "Save changes →" : "Add to cart →";

  // The step's primary action lives in a FIXED bar just above the dock —
  // always visible, never scrolled away, never hidden under the summary.
  // Buttons stay enabled and say what's missing when tapped; the one
  // exception is a custom design still uploading (disabled, reason shown).
  const primaryCta: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    hint?: ReactNode;
  } | null = (() => {
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
              has_from: from.trim().length > 0,
            });
            goStep("Filling");
          },
        };
      case "Filling":
        return {
          label: "Continue →",
          onClick: () => {
            if (!filling) {
              setCtaMsg("Pick what goes inside.");
              document.querySelector<HTMLElement>(".filling-bar")?.focus();
              return;
            }
            // The Add-ons step only exists when this filling permits one.
            goStep(addonsApplicable ? "Add-ons" : "Delivery");
          },
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
              label: addLabel,
              onClick: addToCart,
              disabled: artStatus !== "ready",
              hint: artHint,
            }
          : {
              label: "Continue →",
              onClick: () => {
                if (dateProblem) {
                  setCtaMsg(date ? dateProblem : "Pick a delivery day above.");
                  return;
                }
                goStep("Send to");
              },
            };
      case "Send to":
        return {
          label: addLabel,
          onClick: addToCart,
          disabled: artStatus !== "ready",
          hint: artHint,
        };
      default:
        return null;
    }
  })();

  // Right beside the button (mobile bar AND desktop card): what a tap was
  // missing, else why the button is held.
  const ctaNote: ReactNode = !primaryCta ? null : ctaMsg ? (
    <p className="cta-note warn" role="alert">
      {ctaMsg}
    </p>
  ) : primaryCta.hint ? (
    <p className="cta-note" role="status">
      {primaryCta.hint}
    </p>
  ) : null;

  const pickCarrier = (c: Carrier) => {
    setCarrier(c);
    setCtaMsg(null);
    track("carrier_selected", { carrier: c });
  };

  // The Classic branded default: a one-tap pick (no library, no canvas) —
  // the confirm screen shows it on the box like any other selection.
  const pickClassic = () => {
    applyGraphic(CLASSIC_GRAPHIC);
    setEditingDraft(null);
    track("graphic_picked", { design: CLASSIC_GRAPHIC.design, tier: "classic" });
  };

  // Delivery step: change the cart's ONE address (every piñata in it ships
  // there) — only on an explicit Save.
  const saveChangedAddr = () => {
    if (!changingAddr) return;
    const errs = addressErrors(changingAddr, carrier, uspsOffered);
    if (Object.keys(errs).length) {
      setChangeErrors(true);
      focusFirstAddressError(errs, "chg");
      return;
    }
    const lines = loadCart();
    if (!saveCart(lines.map((l) => ({ ...l, address: changingAddr })))) {
      setCtaMsg(
        cartSaveProblem() === "blocked"
          ? STORAGE_PROBLEM_COPY.blocked
          : "We couldn't save that address — your cart storage is full. Try removing a custom design from your cart.",
      );
      return;
    }
    rememberAddress(changingAddr);
    setCartAddress(changingAddr);
    setChangingAddr(null);
    setChangeErrors(false);
    setSomeoneElse(false);
    setCtaMsg(null);
  };

  // "Discard" confirmed: throw the editor's work away (its autosave too —
  // ending the editing session so the unmounting editor can't re-save it)
  // and carry on with the navigation that asked.
  const confirmDiscard = () => {
    const ask = discardAsk;
    setDiscardAsk(null);
    void discardEditorAutosave();
    editorDirtyRef.current = false;
    setEditorDirty(false);
    ask?.go();
  };

  const steps = (
    <div>
      {/* Step Two — the box IS the screen; buttons morph with state */}
      {step === "Graphic" && !choosing && (
        <div className="step-panel">
          {graphic?.type === "custom" && (
            // The design's print file: uploading in the background (it
            // keeps going on the next steps), saved, or failed — with the
            // retry right here.
            <p className={"save-status " + artStatus} role="status">
              {artStatus === "ready" ? (
                "Saved ✓"
              ) : artStatus === "saving" ? (
                <>
                  <span className="mini-spinner" aria-hidden /> Saving your
                  design…
                </>
              ) : artStatus === "failed" ? (
                <>
                  Couldn&apos;t save —{" "}
                  <button type="button" className="link-btn" onClick={retryArt}>
                    Retry
                  </button>
                </>
              ) : (
                "This design was made in an older editor — tap “Edit this graphic” to make it again."
              )}
            </p>
          )}
          {deepLinkPending && !graphic ? (
            <p className="note deeplink-loading" role="status">
              <span className="mini-spinner" aria-hidden /> Finding your
              design…
            </p>
          ) : !graphic ? (
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
              {variant.allowCustom && (
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
              )}
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
                  {variant.allowCustom && (
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
                  )}
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
          {/* No-custom storefronts have no choice screen behind this — the
              auto-open effect would bounce right back in. */}
          {(variant.allowCustom || graphic) && (
            <p className="note">
              <button className="btn mini" onClick={() => goView(null)}>
                ← Back
              </button>
            </p>
          )}
          <GraphicLibrary
            restrict={variant.library === "all" ? null : variant.library}
            hubGraphics={hubGraphics}
            hubCategories={hubCategories}
            styleId={styleInfo.id}
            onPick={(g) => {
              applyGraphic(g);
              track("graphic_picked", { design: g.design });
              goStep("Graphic");
            }}
          />
        </>
      )}

      {choosing && graphicMode === "canvas" && (
        <div>
          <p className="note">
            <button
              className="btn mini"
              onClick={() => guardEditorExit(() => goView(null))}
            >
              ← Back
            </button>
          </p>
          {discardAsk && (
            <div
              className="inline-confirm discard-confirm"
              role="group"
              aria-labelledby="discard-q"
            >
              <p>
                <strong id="discard-q">
                  {editingDraft ? "Discard your changes?" : "Discard this design?"}
                </strong>{" "}
                {editingDraft
                  ? "Your saved design stays as it was."
                  : "Your photos and text will be cleared."}
              </p>
              <div className="inline-actions">
                <button className="btn danger-fill" onClick={confirmDiscard}>
                  Discard
                </button>
                <button
                  className="btn"
                  autoFocus
                  onClick={() => setDiscardAsk(null)}
                >
                  Keep editing
                </button>
              </div>
            </div>
          )}
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
            onDirtyChange={setEditorDirty}
            onSave={(design, preview, assets) => {
              // stamp the CURRENT style — the body may have been swapped
              // while the canvas was open. The print upload (if this save
              // needed one) is already running in lib/design-upload; the
              // confirm screen watches it and patches the assets in.
              applyGraphic({
                type: "custom",
                design: { ...design, bodyStyleId: styleInfo.id },
                preview,
                art: assets.art,
                designUrl: assets.designUrl,
                artSha256: assets.artSha256,
              });
              setEditingDraft(null);
              editorDirtyRef.current = false;
              setEditorDirty(false);
              setDiscardAsk(null);
              track("custom_design_saved");
              goStep("Graphic");
            }}
          />
        </div>
      )}

      {step === "Message" && (
        <div className="step-panel msg-step">
          <label className="field-label" htmlFor="gift-message">
            Your gift message
          </label>
          <textarea
            id="gift-message"
            className="message-box"
            rows={4}
            placeholder="Add a gift message — it prints on the inside flap."
            aria-describedby="gift-message-count"
            value={message}
            onChange={(e) => editMessage(e.target.value, from)}
          />
          <div className="msg-from-row">
            <label className="field-label" htmlFor="gift-from">
              From
            </label>
            <input
              id="gift-from"
              className="message-from"
              placeholder="Your name"
              autoComplete="name"
              autoCapitalize="words"
              aria-describedby="gift-message-count"
              value={from}
              onChange={(e) => editMessage(message, e.target.value)}
            />
          </div>
          {/* The count is read with the fields (describedby); only the
              "full" moment is announced — not every keystroke. */}
          <p id="gift-message-count" className="msg-count">
            {messageLeft} character{messageLeft === 1 ? "" : "s"} left
          </p>
          <p className="msg-count over" role="status">
            {messageFull
              ? `That's all that fits — the card holds ${MESSAGE_MAX} characters, sign-off included.`
              : ""}
          </p>
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
                aria-pressed={filling === f.label}
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
          {fillingAuto && filling === fillingAuto && (
            <p className="note filling-auto-note">
              We picked {fillingAuto} to match your design — tap another to
              change it.
            </p>
          )}
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
          {hasCartAddress && (
            // Who this piñata goes to — the cart's one address — up front,
            // with the two ways out: change it (for the whole order) or
            // learn how to send to someone else.
            <div className="sendto-card">
              <p className="sendto-line">
                <span className="sendto-label">Send to:</span>{" "}
                <strong>
                  {cartAddress!.name}, {cartAddress!.city}{" "}
                  {stateCode(cartAddress!.province) || cartAddress!.province}
                </strong>
                {!changingAddr && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        setChangingAddr({
                          ...cartAddress!,
                          province:
                            stateCode(cartAddress!.province) ||
                            cartAddress!.province,
                        });
                        setChangeErrors(false);
                        setSomeoneElse(false);
                      }}
                    >
                      Change
                    </button>
                  </>
                )}
              </p>
              {cartPoBox && !changingAddr && (
                <p className="field-err">{poBoxText}</p>
              )}
              {changingAddr ? (
                <div className="sendto-edit">
                  <p className="note">
                    {otherLines.length > 0
                      ? `This changes where your whole order ships — the ${
                          otherLines.length === 1
                            ? "piñata already in your cart goes"
                            : `${otherLines.length} piñatas already in your cart go`
                        } to this address too (one address per order).`
                      : "One address per order — everything in your cart ships here."}
                  </p>
                  <RecipientForm
                    idPrefix="chg"
                    value={changingAddr}
                    onChange={setChangingAddr}
                    carrier={carrier}
                    uspsOffered={uspsOffered}
                    showAllErrors={changeErrors}
                  />
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="btn primary"
                      onClick={saveChangedAddr}
                    >
                      Save address
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setChangingAddr(null);
                        setChangeErrors(false);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="link-btn sendto-else"
                    aria-expanded={someoneElse}
                    onClick={() => setSomeoneElse((o) => !o)}
                  >
                    Someone else?
                  </button>
                  {someoneElse && (
                    <p className="note sendto-else-note">
                      Each order ships to one address — everything in your
                      cart goes to {cartAddress!.name}. To send a piñata to
                      someone else, check out this order first, then start a
                      new one for them. Or tap Change to move the whole order
                      to a new address. <a href="/cart">Go to your cart →</a>
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          {/* One delivery speed per ORDER (one draft, one shipping line).
              USPS = cheaper, arrives within a few days of the date; FedEx =
              guaranteed exact day. Variants without USPS skip the chooser
              (FedEx forced). Never "guaranteed" anywhere near USPS. */}
          {uspsOffered && (
            <div className="carrier-cards">
              <button
                className={
                  "carrier-card" + (carrier === "fedex" ? " selected" : "")
                }
                aria-pressed={carrier === "fedex"}
                onClick={() => pickCarrier("fedex")}
              >
                <span className="carrier-name">FedEx 2-Day</span>
                <span className="carrier-desc">
                  Guaranteed by FedEx on the day you pick
                </span>
                <span className="carrier-price">
                  {unitPrice ? formatCents(unitPrice.shipPerUnitCents) : ""}
                </span>
              </button>
              <button
                className={
                  "carrier-card" + (carrier === "usps" ? " selected" : "")
                }
                aria-pressed={carrier === "usps"}
                onClick={() => pickCarrier("usps")}
              >
                <span className="carrier-name">USPS First Class</span>
                <span className="carrier-desc">
                  Usually arrives within a few days of your date
                </span>
                <span className="carrier-price">
                  {formatCents(pricing.uspsShipPerUnitCents)}
                </span>
              </button>
            </div>
          )}
          {carrierSwitch && (
            // The cart already ships another way: say exactly what adding
            // this piñata changes (never a silent re-stamp / re-price), and
            // which lines can't make their date on the new carrier.
            <div className="notice warn carrier-switch" role="status">
              {uspsOffered ? (
                <>
                  <p>
                    Your cart ships{" "}
                    <strong>{CARRIER_NAMES[orderCarrier ?? "fedex"]}</strong>{" "}
                    — one delivery speed per order. {editLineId ? "Saving" : "Adding"}{" "}
                    this piñata with <strong>{CARRIER_NAMES[carrier]}</strong>{" "}
                    switches{" "}
                    {otherLines.length === 1
                      ? "the piñata already in your cart"
                      : `all ${otherLines.length} piñatas already in your cart`}{" "}
                    to it
                    {(() => {
                      const ship =
                        carrier === "usps"
                          ? pricing.uspsShipPerUnitCents
                          : unitPrice?.shipPerUnitCents;
                      return ship != null
                        ? ` (shipping ${formatCents(ship)} each)`
                        : "";
                    })()}
                    .
                  </p>
                  {stuckText && <p>{stuckText}</p>}
                  <button
                    type="button"
                    className="btn mini"
                    onClick={() => pickCarrier(orderCarrier ?? "fedex")}
                  >
                    Keep {CARRIER_NAMES[orderCarrier ?? "fedex"]}
                  </button>
                </>
              ) : (
                <>
                  <p>
                    USPS isn&apos;t offered here, so the{" "}
                    {otherLines.length === 1
                      ? "piñata already in your cart ships"
                      : "piñatas already in your cart ship"}{" "}
                    FedEx 2-Day along with this one.
                  </p>
                  {stuckText && <p>{stuckText}</p>}
                </>
              )}
            </div>
          )}
          <p className="note earliest-hint">
            {carrier === "usps" ? (
              <>
                Soonest date{" "}
                <strong>
                  {formatYmd(minDeliveryDate(deliveryCfg, "usps"))}
                </strong>{" "}
                — USPS usually arrives within a few days of the day you pick.
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
              setCtaMsg(null);
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
              Usually arrives within a few days of your date —{" "}
              {windowWords(uspsWindow(date, deliveryCfg))}.
            </div>
          ) : (
            <div className="notice info">
              Arrives {formatYmd(date)} — guaranteed by FedEx on the day you
              pick.
            </div>
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
                // older saved addresses may spell the state out ("Texas");
                // the form's State select speaks codes
                const saved = {
                  ...a,
                  province: stateCode(a.province) || a.province,
                };
                const key = addressKey(saved);
                return (
                  <button
                    key={key}
                    className={
                      "addr-card" + (key === selectedSavedKey ? " selected" : "")
                    }
                    onClick={() => {
                      setAddress(saved);
                      setCtaMsg(null);
                    }}
                  >
                    {formatAddress(a)}
                  </button>
                );
              })}
              <button
                className="addr-card new"
                onClick={() => {
                  setAddress(EMPTY_ADDRESS);
                  setSendToErrors(false);
                  setAddrFormKey((k) => k + 1); // a blank form starts unflagged
                }}
              >
                + New address
              </button>
            </div>
          )}

          <RecipientForm
            key={addrFormKey}
            idPrefix="addr"
            value={address}
            onChange={(a) => {
              setAddress(a);
              setCtaMsg(null);
            }}
            carrier={carrier}
            uspsOffered={uspsOffered}
            showAllErrors={sendToErrors}
          />

          <p className="note several-link">
            Sending to several people?{" "}
            <a href="https://my.betterthanaletter.com">
              Order for a group at my.betterthanaletter.com →
            </a>
          </p>
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
              onClick={() =>
                !unreachable && guardEditorExit(() => goStep(s, "chip"))
              }
            >
              {idx < stepIndex ? "✓ " : ""}
              <span className="chip-num">{vi + 2} ·</span> {s}
            </button>
          );
        })}
      </div>

      {notices.length > 0 && (
        <div className="flow-notices">
          {notices.map((n, i) => (
            <div className="notice info flow-notice" role="status" key={n}>
              <span>{n}</span>
              <button
                type="button"
                className="link-btn"
                aria-label="Dismiss"
                onClick={() =>
                  setNotices((all) => all.filter((_, j) => j !== i))
                }
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

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
              message={printedMessage}
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
                <>
                  {ctaNote}
                  <button
                    className="btn primary desk-summary-cta"
                    disabled={primaryCta.disabled}
                    onClick={primaryCta.onClick}
                  >
                    {primaryCta.label}
                  </button>
                </>
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
              <div className="cta-stack">
                {ctaNote}
                <button
                  className="btn primary cta-btn"
                  disabled={primaryCta.disabled}
                  onClick={primaryCta.onClick}
                >
                  {primaryCta.label}
                </button>
              </div>
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
