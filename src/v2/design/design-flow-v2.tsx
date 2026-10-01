"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { trackAddToCart } from "@/lib/analytics";
import { reopenPendingOrder, startCheckout } from "@/lib/checkout-client";
import { formatWindow, formatYmd, uspsWindow, type Carrier } from "@/lib/delivery";
import { designKey, type DesignDocument } from "@/lib/design-document";
import {
  designSaveState,
  designSavesVersion,
  saveDesignArt,
  subscribeDesignSaves,
} from "@/lib/design-upload";
import {
  addressComplete,
  CART_EVENT,
  cartCarrier,
  CLASSIC_GRAPHIC,
  discountParamCode,
  EMPTY_ADDRESS,
  fillingAllowsAddon,
  graphicTier,
  loadCart,
  loadDiscountCodes,
  loadPendingOrder,
  newLineId,
  pendingKey,
  rememberAddress,
  saveCart,
  saveDiscountCodes,
  type CartLine,
  type DeliveryAddress,
  type DesignAssets,
  type GraphicChoice,
} from "@/lib/flow";
import {
  formatCents,
  priceUrl,
  resolveDiscount,
  type HubBodyStyle,
  type HubDiscount,
  type HubFilling,
  type HubPrice,
} from "@/lib/hub";
import { clearLibraryState } from "@/lib/library-data";
import PendingBanner from "../chrome/pending-banner";
import {
  ADDRESS_ORDER,
  emailProblem,
  validateAddress,
  type AddressErrors,
  type AddressField,
} from "../lib/address";
import { trackV2 } from "../lib/analytics";
import { arrivalText, dateProblemText, soonest } from "../lib/dates";
import { fillingAfterDesignChange } from "../lib/defaults";
import {
  draftFromLine,
  draftFromPreset,
  loadDraftV2,
  loadOrderPrefs,
  loadParked,
  markPresetConsumed,
  presetConsumed,
  presetSignature,
  saveDraftV2,
  saveOrderPrefs,
  saveParked,
  type DraftV2,
  type OrderPrefs,
} from "../lib/draft";
import { composeMessage, hasMessage, type CardParts } from "../lib/message";
import { libraryViewFor, occasionDef, type OccasionId } from "../lib/occasions";
import { computeOrder, designName, type OrderPiece } from "../lib/order";
import { deliveredCents, priceRows, type PriceCtx } from "../lib/pricing";
import { graphicReady, resolveRestore } from "../lib/restore";
import { parseStep, stepAt, STEPS } from "../lib/steps";
import type { FlowData, GraphicSource, StepId, StepVia } from "../lib/types";
import BoxThumb from "../ui/box-thumb";
import { confettiBurst, prefersReducedMotion } from "../ui/confetti";
import { Callout, PriceTag, useAnnouncer, useToast } from "../ui/feedback";
import { Alert, Check, Spinner, Truck } from "../ui/icons";
import u from "../ui/ui.module.css";
import ActionBar, { type Cta } from "./action-bar";
import DryRunResult from "./dry-run";
import EditorView from "./editor-view";
import FlowHeader from "./flow-header";
import { focusAddressField } from "./recipient";
import {
  BodySheet,
  CarrierSwitchSheet,
  DateNeededSheet,
  LibrarySheet,
  LineDateSheet,
  loadLibrary,
  PriceSheet,
  ZoomSheet,
} from "./sheets";
import Stage from "./stage";
import StepCard from "./step-card";
import StepDeliver, { CARRIER_IDS, DATE_IDS, EMAIL_ID } from "./step-deliver";
import StepDesign, { sameGraphic } from "./step-design";
import StepInside from "./step-inside";
import f from "./flow.module.css";
import st from "./steps.module.css";

type SheetState =
  | { kind: "body" }
  | { kind: "zoom" }
  | { kind: "library"; occasion: OccasionId | null }
  | { kind: "price" }
  | { kind: "lineDate"; lineId: string }
  /** Switching carrier with piñatas already in the order: confirm first. */
  | { kind: "carrier"; to: Carrier }
  /** Checkout with no delivery date: pick one right in the pop-up. */
  | { kind: "dateNeeded" }
  | null;

type Nav = {
  via: StepVia;
  history: "push" | "replace" | "none";
  view?: "editor" | null;
  /** false when the browser already animated it (iOS swipe-back) */
  animate?: boolean;
};

type Problem = {
  kind: "message" | "carrier" | "date" | "design" | "line" | "address" | "email";
  message: string;
  focus: () => void;
};

/** The card's message box (Step 2) — focused when it's still empty. */
const MESSAGE_ID = "pg-message";
const MESSAGE_REQUIRED = "Write a message — it's printed on the inside flap of the box.";

const EMPTY_PREFS: OrderPrefs = {
  carrier: null,
  address: EMPTY_ADDRESS,
  recipient: "same",
  email: "",
};

/**
 * The v2 journey: Design → Card → Inside → Deliver & pay. This component
 * owns the state machine — the piñata in progress (a draft in session
 * storage, debounced), the order-level choices (carrier, recipient, email),
 * the cart (lib/flow, shared with v1's /cart and /api/checkout), history-
 * backed steps with View Transitions, and checkout. Pure decisions live in
 * src/v2/lib (restore, order, pricing, dates); the steps are presentational
 * and the Stage and ActionBar persist around them.
 */
export default function DesignFlowV2(data: FlowData) {
  const router = useRouter();
  const { variant, pricing, deliveryCfg: cfg, fillings } = data;
  const tiered = variant.pricing === "tiered";
  const uspsOffered = variant.carriers.includes("usps");

  // The server-resolved preset renders first (SSR = what a new visitor from
  // an ad sees); a stored draft, if any, takes over after hydration.
  const [draft, setDraft] = useState<DraftV2 | null>(() => draftFromPreset(data.preset));
  const [prefs, setPrefs] = useState<OrderPrefs>(EMPTY_PREFS);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [step, setStep] = useState<StepId>(data.requestedStep);
  const [view, setView] = useState<"editor" | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [unitPrice, setUnitPrice] = useState<HubPrice | null>(data.initialPrice);
  const [editorRetry, setEditorRetry] = useState(false);
  // Custom-design print uploads live in lib/design-upload (they outlive the
  // editor); re-render when any of them changes state.
  useSyncExternalStore(subscribeDesignSaves, designSavesVersion, () => 0);
  const [addonNotice, setAddonNotice] = useState<string | null>(null);
  const [cardNotice, setCardNotice] = useState<string | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [carrierNotice, setCarrierNotice] = useState<Carrier | null>(null);
  const [discounts, setDiscounts] = useState<HubDiscount[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<AddressField | "email", boolean>>>({});
  const [editingAddress, setEditingAddress] = useState(false);
  const [busy, setBusy] = useState(false);
  // the waiting order is coming back into the cart (reopenWaitingOrder)
  const [reopening, setReopening] = useState(false);
  const reopeningRef = useRef(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [dryRun, setDryRun] = useState<Record<string, unknown> | null>(null);

  const { region: toastRegion, show: showToast } = useToast();
  const { region: announceRegion, announce } = useAnnouncer();
  const h1Ref = useRef<HTMLHeadingElement>(null);
  const stepRef = useRef(step);
  const viewRef = useRef(view);
  const draftRef = useRef(draft);
  const stepStart = useRef(0);
  const focusPending = useRef(false);
  const discountsTouched = useRef(false);
  const libraryScroll = useRef(0);
  // Checkout in flight: a ref, not state — a second tap in the same frame
  // must not commit the piñata twice or open a second draft order.
  const inFlight = useRef(false);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const stylesById = useMemo(() => new Map(data.styles.map((s) => [s.id, s])), [data.styles]);
  const style: HubBodyStyle | null = draft ? (stylesById.get(draft.styleId) ?? null) : null;
  const cartAddress = useMemo(
    () => cart.find((l) => addressComplete(l.address))?.address ?? null,
    [cart],
  );
  // ONE carrier per order: FedEx-only stores are FedEx; with piñatas in the
  // order its carrier is the order's; otherwise nothing is assumed until the
  // shopper chooses (prices show "From" meanwhile).
  const carrier: Carrier | null = !uspsOffered
    ? "fedex"
    : cart.length > 0
      ? cartCarrier(cart)
      : prefs.carrier;
  const priceCtx: PriceCtx = useMemo(
    () => ({ unitPrice, pricing, tiered, uspsOffered, fillings, addons: data.addons }),
    [unitPrice, pricing, tiered, uspsOffered, fillings, data.addons],
  );
  const parts: CardParts = {
    to: draft?.msgTo ?? "",
    body: draft?.msgBody ?? "",
    from: draft?.msgFrom ?? "",
  };
  const message = composeMessage(parts);
  const piecePrice = draft
    ? deliveredCents({ graphic: draft.graphic, filling: draft.filling, addons: draft.addons }, carrier, priceCtx)
    : null;
  // The print upload for the design on the Stage (null when none started —
  // e.g. a draft restored after a reload, which re-uploads below).
  const customJob =
    draft?.graphic.type === "custom" ? designSaveState(designKey(draft.graphic.design)) : null;
  const saveStatus: "saving" | "saved" | "failed" | null =
    draft?.graphic.type === "custom"
      ? graphicReady(draft.graphic)
        ? "saved"
        : customJob?.status === "failed"
          ? "failed"
          : "saving"
      : null;
  // A design that's still saving holds you on Step 1; an empty card holds
  // you on Step 2 (every piñata carries a message).
  const maxReachable = draft ? (graphicReady(draft.graphic) ? (hasMessage(draft) ? 3 : 1) : 0) : 3;
  // An explicit Edit of a cart line ("Save changes"); a piñata reopened by
  // going Back from the order step reads as the one in progress instead.
  const editing = !!draft?.editLineId && !draft.resumed;
  const loading =
    reopening || (!hydrated && (data.requestedStep !== "design" || !!data.editLineId));

  const patch = useCallback((p: Partial<DraftV2>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }, []);

  /** A new piñata: the context defaults again, keeping the occasion. */
  const freshPiece = useCallback(
    (occasion: OccasionId | null): DraftV2 => {
      const base = draftFromPreset(data.preset);
      const occ = occasion ?? base.occasion;
      const top = data.strips.find((s) => s.id === occ)?.designs[0];
      // Never re-use a deep-linked design for the NEXT piñata: tiered
      // stores start on the Classic, flat ones on the occasion's #1.
      const graphic = tiered ? CLASSIC_GRAPHIC : (top ?? base.graphic);
      return {
        ...base,
        occasion: occ,
        graphic,
        graphicSource: "default",
        ...fillingAfterDesignChange(base, graphic, fillings),
      };
    },
    [data.preset, data.strips, tiered, fillings],
  );

  /**
   * Back from the order step with nothing in progress (after Checkout too,
   * back from the invoice): the piñata added last comes back — design,
   * message, filling as they were — instead of a blank one. It saves over
   * its own line (never a copy, no second add-to-cart); "Add another" is how
   * a new piñata starts. Null when the order is empty (or its style is gone).
   */
  const resumeLastLine = useCallback((): DraftV2 | null => {
    const lines = loadCart();
    const last = lines[lines.length - 1];
    if (!last || !stylesById.has(last.styleId)) return null;
    const d: DraftV2 = { ...draftFromLine(last, data.preset.occasion), resumed: true };
    draftRef.current = d;
    setDraft(d);
    return d;
  }, [stylesById, data.preset.occasion]);

  /* --- navigation (history-backed, View Transitions, focus to the h1) ---- */

  const navigate = useCallback((next: StepId, opts: Nav) => {
    const prev = stepRef.current;
    const nextView = opts.view ?? null;
    if (next !== prev && STEPS[next].index > STEPS[prev].index) {
      trackV2("step_completed", {
        step: prev,
        step_index: STEPS[prev].index,
        ms_on_step: Math.round(performance.now() - stepStart.current),
      });
    }
    focusPending.current = true;
    const apply = () =>
      flushSync(() => {
        setStep(next);
        setView(nextView);
        setSheet(null);
      });
    if (opts.animate !== false && "startViewTransition" in document && !prefersReducedMotion()) {
      document.startViewTransition(apply);
    } else {
      apply();
    }
    if (opts.history !== "none") {
      const url = new URL(window.location.href);
      url.searchParams.set("step", next);
      if (nextView) url.searchParams.set("view", nextView);
      else url.searchParams.delete("view");
      const depth = Number(window.history.state?.pgDepth ?? 0);
      if (opts.history === "push") {
        window.history.pushState({ pgv2: true, pgDepth: depth + 1 }, "", url);
      } else {
        window.history.replaceState({ pgv2: true, pgDepth: depth }, "", url);
      }
    }
    if (next !== prev) {
      stepStart.current = performance.now();
      trackV2("step_viewed", { step: next, step_index: STEPS[next].index, via: opts.via });
    }
  }, []);

  // Step changes land at the top with focus on the step's h1 (keyboard and
  // screen-reader users keep their place). Never on the initial load.
  useLayoutEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    window.scrollTo({ top: 0 });
    h1Ref.current?.focus({ preventScroll: true });
  }, [step, view]);

  /* --- restore: stored draft, deep link, edit link, order review --------- */

  useEffect(() => {
    // Reads only; every write waits for the commit tick below.
    const here = new URL(window.location.href);
    const lines = loadCart();
    const sig = presetSignature(here);
    const r = resolveRestore({
      url: here,
      stored: loadDraftV2(),
      parked: loadParked(),
      lines,
      pendingWaiting: !!loadPendingOrder(),
      preset: data.preset,
      deepLink: data.deepLink,
      presetApplied: presetConsumed(sig),
      inStock: (id) => stylesById.has(id),
      fillings,
    });
    setCart(lines);
    setPrefs(loadOrderPrefs());
    setDraft(r.draft);
    setStep(r.step);
    // the refs mirror state a render later — the commit tick below reads
    // them first (the server render's placeholder draft must not linger)
    draftRef.current = r.draft;
    stepRef.current = r.step;
    setHydrated(true);
    // A background upload can't survive a reload: re-render the print file
    // from the saved document and upload it again (status shows on Step 1).
    if (r.draft?.graphic.type === "custom" && !graphicReady(r.draft.graphic)) {
      void saveDesignArt(r.draft.graphic.design);
    }

    // The commit tick: storage writes, the URL and the first events. A dev
    // Strict-Mode double mount cancels the first tick, so nothing is
    // consumed twice. The URL write must wait anyway: this effect runs
    // BEFORE the App Router (a parent) installs its history patch — written
    // now, the entry would lose Next's own state (__NA) and Back to it
    // would reload the page; a tick later the patched replaceState keeps
    // Next's bookkeeping and syncs its URL.
    const t = window.setTimeout(() => {
      if (r.park) saveParked(r.park);
      if (r.unpark) saveParked(null);
      if (r.consume) markPresetConsumed(sig);
      window.history.replaceState(
        { pgv2: true, pgDepth: Number(window.history.state?.pgDepth ?? 0) },
        "",
        r.url,
      );
      stepStart.current = performance.now();
      trackV2("step_viewed", { step: r.step, step_index: STEPS[r.step].index, via: r.via });
      const d = r.draft;
      if (d && (r.fresh || r.via === "deeplink") && !d.editLineId) {
        trackV2("body_style_selected", { style: d.styleId, source: data.preset.styleSource });
        trackV2("graphic_picked", {
          design: d.graphic.type === "custom" ? "custom" : d.graphic.design,
          tier: graphicTier(d.graphic),
          source: d.graphicSource === "deeplink" ? "deeplink" : "default",
        });
      }
      if (r.note) showToast(r.note);
      // the order review with an empty cart = the waiting order comes back
      if (!r.draft && r.step === "deliver" && !lines.length) void reopenRef.current();
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back / forward: the URL's step (clamped to what the draft supports).
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const url = new URL(window.location.href);
      const target = parseStep(url.searchParams.get("step")) ?? "design";
      const wantsEditor = url.searchParams.get("view") === "editor";
      // Same step, same view: only a full-screen sheet's own history entry
      // came off (ui/sheet) — the sheet closes itself; stay put, no scroll.
      if (target === stepRef.current && wantsEditor === (viewRef.current === "editor")) return;
      // Safari 18+ has already animated an edge swipe: a View Transition on
      // top would play the step change a second time.
      const animate = !(e as PopStateEvent & { hasUAVisualTransition?: boolean })
        .hasUAVisualTransition;
      let d = draftRef.current;
      if (!d && target !== "deliver") {
        // Back from the order review into the design steps: the piñata
        // added last, as it was — a new one only when the order is empty.
        d = resumeLastLine();
        if (!d) {
          setDraft(freshPiece(null));
          navigate("design", { via: "back", history: "replace", animate });
          return;
        }
      }
      const clamped =
        d && !graphicReady(d.graphic)
          ? "design"
          : d &&
              STEPS[target].index > STEPS.card.index &&
              !hasMessage(d)
            ? "card"
            : target;
      navigate(clamped, {
        via: "back",
        history: clamped === target ? "none" : "replace",
        view: wantsEditor && clamped === "design" && d ? "editor" : null,
        animate,
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [navigate, freshPiece, resumeLastLine]);

  /* --- persistence + outside changes -------------------------------------- */

  useEffect(() => {
    if (!hydrated) return;
    const t = window.setTimeout(() => saveDraftV2(draft), 300);
    return () => window.clearTimeout(t);
  }, [hydrated, draft]);

  useEffect(() => {
    if (!hydrated) return;
    // Leaving mid-debounce must not drop the last keystrokes.
    const flush = () => saveDraftV2(draftRef.current);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [hydrated]);

  useEffect(() => {
    if (hydrated) saveOrderPrefs(prefs);
  }, [hydrated, prefs]);

  useEffect(() => {
    const refresh = () => setCart(loadCart());
    window.addEventListener(CART_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CART_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Back from Shopify's invoice may restore this page from the bfcache,
  // frozen mid-checkout: wake it up with the current cart — and the order
  // that's waiting for payment comes back into it (below).
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      inFlight.current = false;
      setBusy(false);
      setCart(loadCart());
      if (stepRef.current === "deliver") void reopenRef.current();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  /**
   * Back from the invoice (or the cart icon) with nothing in progress: the
   * order waiting for payment comes back into the cart — "When and where"
   * with its piñatas, address and dates exactly as they were, ready to pay
   * (the next checkout replaces the old draft). Shopify is asked first: a
   * paid order is done, never reopened.
   */
  const reopenWaitingOrder = async () => {
    if (draftRef.current || loadCart().length) return;
    const waiting = loadPendingOrder();
    if (!waiting || reopeningRef.current) return;
    reopeningRef.current = true;
    setReopening(true);
    const result = await reopenPendingOrder(pendingKey(waiting));
    reopeningRef.current = false;
    setReopening(false);
    const lines = loadCart();
    setCart(lines);
    if (result === "paid") showToast("That order is paid — thank you!");
    if (!lines.length && !draftRef.current && !loadPendingOrder()) {
      // nothing left to review: a new piñata
      setDraft(freshPiece(null));
      navigate("design", { via: "restore", history: "replace" });
    }
  };
  const reopenRef = useRef(reopenWaitingOrder);
  reopenRef.current = reopenWaitingOrder;

  // Prices: the server's copy first; if that failed, retry here (display
  // only — the flow never waits on it; prices read "—" meanwhile).
  useEffect(() => {
    if (unitPrice) return;
    let cancelled = false;
    let tries = 0;
    let timer: number | undefined;
    const load = () => {
      fetch(
        priceUrl({
          qty: 1,
          fill: "filled",
          bodyType: "standard",
          graphicType: "custom",
          mode: "individual",
          carrier: "standard",
        }),
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((p: HubPrice | null) => {
          if (cancelled) return;
          if (p && Number.isFinite(p.unitPriceCents) && p.unitPriceCents > 0) setUnitPrice(p);
          else throw new Error("price");
        })
        .catch(() => {
          if (!cancelled && ++tries < 4) timer = window.setTimeout(load, 1500 * tries);
        });
    };
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [unitPrice]);

  // Stored discount codes (and a ?discount= riding this URL), re-resolved
  // like the cart does: dead codes self-heal out, one per kind.
  useEffect(() => {
    const fromUrl = discountParamCode();
    const codes = [
      ...(fromUrl ? [fromUrl] : []),
      ...loadDiscountCodes().filter((c) => c !== fromUrl),
    ].slice(0, 2);
    if (!codes.length) return;
    let live = true;
    Promise.all(codes.map((c) => resolveDiscount(c))).then((rs) => {
      if (!live || discountsTouched.current) return;
      const seen = new Set<string>();
      const ok = rs.filter(
        (d): d is HubDiscount => !!d && !seen.has(d.kind) && !!seen.add(d.kind),
      );
      setDiscounts(ok);
      saveDiscountCodes(ok.map((d) => d.code));
    });
    return () => {
      live = false;
    };
  }, []);

  // "Soonest" is a choice of speed, not a date: it follows the carrier and
  // the calendar (a draft left overnight moves to the new soonest day).
  useEffect(() => {
    if (!draft?.dateSoonest || !carrier) return;
    const ymd = soonest(cfg, carrier);
    if (draft.date !== ymd) patch({ date: ymd });
  }, [draft?.dateSoonest, draft?.date, carrier, cfg, patch]);

  // Nothing in progress and nothing in the order: start a piñata. (Off the
  // effect's commit — navigate() flushes synchronously.) Not while the order
  // waiting for payment is coming back into the review (back from its
  // invoice): that decides for itself once Shopify has answered.
  useEffect(() => {
    if (!hydrated || busy || reopening || draft || cart.length > 0) return;
    const t = window.setTimeout(() => {
      if (reopeningRef.current || (stepRef.current === "deliver" && loadPendingOrder())) return;
      setDraft(freshPiece(null));
      navigate("design", { via: "continue", history: "replace" });
    }, 0);
    return () => window.clearTimeout(t);
  }, [hydrated, busy, reopening, draft, cart.length, freshPiece, navigate]);

  // The upload for the design on the Stage landed (possibly after the editor
  // closed, a Retry, or a reload): stamp its art + hash onto the draft and
  // onto any cart line that went in before it finished.
  const landedAssets = customJob?.status === "saved" ? customJob.assets : null;
  useEffect(() => {
    const d = draftRef.current;
    if (!landedAssets || d?.graphic.type !== "custom" || graphicReady(d.graphic)) return;
    onEditorAssets(landedAssets, JSON.stringify(d.graphic.design));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landedAssets]);
  // Never "Saving…" forever: a custom design without its print file and with
  // no upload running starts one (saveDesignArt joins a job already in flight
  // for the same design, so the editor's own upload is never doubled).
  const needsUpload =
    hydrated && draft?.graphic.type === "custom" && !graphicReady(draft.graphic) && !customJob;
  useEffect(() => {
    const d = draftRef.current;
    if (needsUpload && d?.graphic.type === "custom") void saveDesignArt(d.graphic.design);
  }, [needsUpload]);

  /* --- choices --------------------------------------------------------------- */

  const pickGraphic = (g: GraphicChoice, source: GraphicSource) => {
    const d = draftRef.current;
    if (!d) return;
    const fill = fillingAfterDesignChange(d, g, fillings);
    const rec = fillings.find((x) => x.label === fill.filling);
    const kept = d.addons.filter((id) => fillingAllowsAddon(rec, id));
    if (kept.length < d.addons.length) {
      setAddonNotice(
        `${d.addons
          .filter((id) => !kept.includes(id))
          .map((id) => data.addons.find((a) => a.id === id)?.label ?? id)
          .join(", ")} isn't available with ${fill.filling} — removed.`,
      );
    }
    patch({ graphic: g, graphicSource: source, ...fill, addons: kept });
    trackV2("graphic_picked", {
      design: g.type === "custom" ? "custom" : g.design,
      tier: graphicTier(g),
      source,
    });
  };

  // The sheet decides when to close (a tap closes it; arrow keys don't).
  const pickStyle = (b: HubBodyStyle) => {
    patch({ styleId: b.id });
    trackV2("body_style_selected", { style: b.id, source: "sheet" });
  };

  const pickFilling = (fl: HubFilling) => {
    if (!draft) return;
    const kept = draft.addons.filter((id) => fillingAllowsAddon(fl, id));
    const dropped = draft.addons.filter((id) => !kept.includes(id));
    patch({ filling: fl.label, fillingAuto: false, addons: kept });
    // Visibly, never silently (checkout enforces the same rule).
    setAddonNotice(
      dropped.length
        ? `${dropped.map((id) => data.addons.find((a) => a.id === id)?.label ?? id).join(", ")} isn't available with ${fl.label} — removed.`
        : null,
    );
    trackV2("filling_selected", { filling: fl.label });
  };

  const toggleAddon = (id: string, on: boolean) => {
    if (!draft) return;
    patch({ addons: on ? [...new Set([...draft.addons, id])] : draft.addons.filter((x) => x !== id) });
    trackV2("addon_toggled", { addon: id, on });
  };

  // One carrier per ORDER. With piñatas already in it travelling another
  // way, a pop-up asks first ("switch them all?"); confirmed, they switch
  // too — out loud (the notice names any whose date no longer works), never
  // as a side effect of adding another piñata.
  const pickCarrier = (c: Carrier) => {
    const lines = loadCart();
    if (lines.length && cartCarrier(lines) !== c) {
      setSheet({ kind: "carrier", to: c });
      return;
    }
    setPrefs((p) => ({ ...p, carrier: c }));
    trackV2("carrier_selected", { carrier: c });
  };

  const confirmCarrier = (c: Carrier) => {
    setSheet(null);
    setPrefs((p) => ({ ...p, carrier: c }));
    trackV2("carrier_selected", { carrier: c, switched_order: true });
    const lines = loadCart();
    if (lines.length && cartCarrier(lines) !== c) {
      if (saveCart(lines.map((l) => ({ ...l, carrier: c })))) {
        setCart(loadCart());
        setCarrierNotice(c);
      }
    }
  };

  // The calendar always shows on "When and where", so a carrier is always
  // in place there: nothing chosen yet (and no order to follow) = FedEx,
  // the one the "Soonest" promise on every step is quoted for. Steps 1–3
  // keep their "From" price until then.
  useEffect(() => {
    if (step !== "deliver" || !hydrated || !uspsOffered || cart.length > 0 || prefs.carrier) return;
    setPrefs((p) => (p.carrier ? p : { ...p, carrier: "fedex" }));
  }, [step, hydrated, uspsOffered, cart.length, prefs.carrier]);

  const pickSoonest = () => {
    if (!carrier) return;
    patch({ date: soonest(cfg, carrier), dateSoonest: true });
    trackV2("delivery_date_picked", { soonest: true, carrier });
  };

  const clearDate = () => patch({ date: "", dateSoonest: false });

  const pickDate = (ymd: string) => {
    if (!carrier) return;
    patch({ date: ymd, dateSoonest: false });
    trackV2("delivery_date_picked", { soonest: ymd === soonest(cfg, carrier), carrier });
  };

  /* --- the editor (custom designs) -------------------------------------------- */

  const openEditor = (retry = false) => {
    setEditorRetry(retry);
    navigate("design", { via: "chip", history: "push", view: "editor" });
    trackV2("custom_editor_opened");
  };

  const closeEditor = () => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("view") === "editor" && Number(window.history.state?.pgDepth ?? 0) > 0) {
      window.history.back(); // the popstate handler closes the view
    } else {
      navigate("design", { via: "back", history: "replace" });
    }
  };

  const onEditorSave = (design: DesignDocument, preview: string, assets: DesignAssets) => {
    const d = draftRef.current;
    if (!d) return;
    pickGraphic(
      {
        type: "custom",
        // stamp the CURRENT body (it can change while the editor is open)
        design: { ...design, bodyStyleId: d.styleId },
        preview,
        art: assets.art,
        designUrl: assets.designUrl,
        artSha256: assets.artSha256,
      },
      "editor",
    );
    // Without art yet, the editor's upload job (lib/design-upload) is still
    // running; Step 1 shows its status and the effect above stamps the result.
    trackV2("custom_design_saved");
    closeEditor();
  };

  // The background print upload finished: patch the draft (if it's still
  // this design) and any cart line holding THIS design that went in before
  // its hash landed. Identity = the design document itself (v1's rule) —
  // matching "art-less" alone could stamp another design's art on a line.
  const onEditorAssets = (assets: DesignAssets, docJson: string) => {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(docJson);
    } catch {
      return;
    }
    const same = (x: DesignDocument) =>
      JSON.stringify({ ...doc, bodyStyleId: x.bodyStyleId }) === JSON.stringify(x);
    setDraft((cur) =>
      cur && cur.graphic.type === "custom" && same(cur.graphic.design)
        ? { ...cur, graphic: { ...cur.graphic, ...assets } }
        : cur,
    );
    const lines = loadCart();
    let changed = false;
    const next = lines.map((l) => {
      if (l.graphic.type !== "custom" || (l.graphic.art && l.graphic.artSha256)) return l;
      if (!same(l.graphic.design)) return l;
      changed = true;
      return { ...l, graphic: { ...l.graphic, ...assets } };
    });
    if (changed) saveCart(next);
  };

  /* --- the order (Step 4) -------------------------------------------------------- */

  // Where the order ships: the address already on the order (unless the
  // shopper is changing it, or it can't take this carrier), else the form.
  const cartAddressOk =
    !!cartAddress && Object.keys(validateAddress(cartAddress, carrier, uspsOffered)).length === 0;
  const usingCartAddress = cartAddressOk && !editingAddress;
  const shipTo: DeliveryAddress = usingCartAddress ? cartAddress! : prefs.address;
  const someoneElse = !!draft && !draft.editLineId && !!cartAddress && prefs.recipient === "new";
  const addressErrors: AddressErrors =
    usingCartAddress || someoneElse ? {} : validateAddress(prefs.address, carrier, uspsOffered);
  const shownAddressErrors: AddressErrors = Object.fromEntries(
    Object.entries(addressErrors).filter(([k]) => submitted || touched[k as AddressField]),
  );
  const emailError = emailProblem(prefs.email);

  // A saved address that can't take this carrier (a PO box after switching
  // to FedEx) opens the form, prefilled, instead of failing at checkout.
  useEffect(() => {
    if (cartAddress && !cartAddressOk && !editingAddress && prefs.recipient === "same") {
      setEditingAddress(true);
      setPrefs((p) => ({ ...p, address: cartAddress }));
    }
  }, [cartAddress, cartAddressOk, editingAddress, prefs.recipient]);

  const lineCarrier: Carrier = carrier ?? "fedex";
  const order = useMemo(() => {
    const live: OrderPiece | null =
      draft && style
        ? {
            graphic: draft.graphic,
            filling: draft.filling,
            addons: draft.addons,
            date: draft.date,
            qty: 1,
            styleName: style.name,
            boxImageUrl: style.boxImageUrl,
            logoZone: style.logoZone,
            message,
          }
        : null;
    return computeOrder({
      current: live && !draft?.editLineId ? live : null,
      editing:
        live && draft?.editLineId
          ? { lineId: draft.editLineId, piece: live, resumed: !!draft.resumed }
          : null,
      cart,
      carrier,
      uspsOffered,
      cfg,
      priceCtx,
      discounts,
      lineErrors,
    });
  }, [draft, style, message, cart, carrier, uspsOffered, cfg, priceCtx, discounts, lineErrors]);

  const byId = (id: string) => () => document.getElementById(id)?.focus();
  /** Everything standing between the shopper and payment, in page order. */
  const problems = (): Problem[] => {
    const out: Problem[] = [];
    // the card comes first: it's an earlier step
    if (draft && !hasMessage(draft)) {
      out.push({ kind: "message", message: MESSAGE_REQUIRED, focus: needMessage });
    }
    if (!carrier) {
      out.push({ kind: "carrier", message: "Choose how it travels.", focus: byId(CARRIER_IDS.fedex) });
    }
    if (draft && carrier) {
      if (!draft.date) {
        out.push({
          kind: "date",
          message: "Pick a delivery date.",
          focus: () => setSheet({ kind: "dateNeeded" }),
        });
      } else {
        const p = dateProblemText(draft.date, cfg, carrier);
        if (p) out.push({ kind: "date", message: p, focus: byId(DATE_IDS.pick) });
      }
    }
    if (draft && !graphicReady(draft.graphic)) {
      out.push({
        kind: "design",
        message: "Your design hasn't finished saving.",
        focus: () => navigate("design", { via: "chip", history: "push" }),
      });
    }
    for (const v of order.views) {
      if (v.problem) {
        out.push({ kind: "line", message: `${v.title}: ${v.problem}`, focus: byId(`pg-fix-${v.id}`) });
      }
    }
    for (const k of ADDRESS_ORDER) {
      if (addressErrors[k]) {
        out.push({ kind: "address", message: addressErrors[k]!, focus: () => focusAddressField(k) });
      }
    }
    if (emailError) out.push({ kind: "email", message: emailError, focus: byId(EMAIL_ID) });
    return out;
  };

  /** Buttons stay enabled: a tap with problems shows every message next to
   *  its field and moves focus to the first one. */
  const stop = (list: Problem[]): boolean => {
    if (!list.length) return false;
    setSubmitted(true);
    list[0].focus();
    announce(
      list.length === 1
        ? list[0].message
        : `${list.length} things need a look. First: ${list[0].message}`,
    );
    return true;
  };

  /** The piñata in progress → a cart line (or its edited line, replaced in
   *  place). Returns the new lines, or null when storage is full. */
  const commitDraft = (lines: CartLine[], to: DeliveryAddress, c: Carrier): CartLine[] | null => {
    const d = draftRef.current;
    if (!d || !style) return lines;
    const existing = d.editLineId ? lines.find((l) => l.id === d.editLineId) : undefined;
    const rec = fillings.find((x) => x.label === d.filling);
    const line: CartLine = {
      id: existing?.id ?? newLineId(),
      styleId: style.id,
      styleName: style.name,
      boxImageUrl: style.boxImageUrl,
      logoZone: style.logoZone,
      graphic: d.graphic,
      message: composeMessage({ to: d.msgTo, body: d.msgBody, from: d.msgFrom }),
      filling: d.filling,
      // only ids the catalog still offers AND the filling allows
      addons: d.addons.filter(
        (id) => data.addons.some((a) => a.id === id) && fillingAllowsAddon(rec, id),
      ),
      deliveryDate: d.date,
      carrier: c,
      address: to,
      qty: existing?.qty ?? 1,
    };
    // One address, one carrier: the whole order moves together.
    const next = (existing ? lines.map((l) => (l.id === existing.id ? line : l)) : [...lines, line]).map(
      (l) => ({ ...l, carrier: c, address: to }),
    );
    if (!saveCart(next)) {
      setCheckoutError(
        "Your browser couldn't save this piñata — custom designs with big photos take the most room. Try fewer or smaller photos.",
      );
      return null;
    }
    if (!existing) trackAddToCart(piecePrice?.cents ?? null);
    clearLibraryState(); // the next piñata browses the library fresh
    saveDraftV2(null);
    setDraft(null);
    setCart(next);
    rememberAddress(to);
    return next;
  };

  const resetStep4 = () => {
    setSubmitted(false);
    setTouched({});
    setEditingAddress(false);
    setCheckoutError(null);
    setLineErrors({});
  };

  const runCheckout = async (lines: CartLine[], btn: HTMLButtonElement) => {
    setBusy(true);
    setCheckoutError(null);
    setLineErrors({});
    setDryRun(null);
    const res = await startCheckout({
      lines,
      discountCodes: discounts.map((d) => d.code),
      email: prefs.email.trim() || null,
      valueCents: order.total,
    });
    if (res.ok && res.kind === "redirect") {
      confettiBurst(btn);
      window.location.assign(res.invoiceUrl);
      return; // stay busy (and locked): the page is leaving
    }
    inFlight.current = false;
    setBusy(false);
    if (res.ok) {
      confettiBurst(btn);
      setDryRun(
        res.payload && typeof res.payload === "object"
          ? (res.payload as Record<string, unknown>)
          : {},
      );
      requestAnimationFrame(() => document.getElementById("pg-dry-run")?.focus());
      return;
    }
    setCheckoutError(res.error);
    setLineErrors(Object.fromEntries((res.lineErrors ?? []).map((e) => [e.lineId, e.message])));
  };

  const pay = async (btn: HTMLButtonElement) => {
    if (inFlight.current) return;
    if (stop(problems())) return;
    inFlight.current = true;
    let lines = loadCart();
    if (draftRef.current) {
      const next = commitDraft(lines, shipTo, carrier!);
      if (!next) {
        inFlight.current = false;
        return;
      }
      lines = next;
    } else {
      lines = lines.map((l) => ({ ...l, carrier: carrier!, address: shipTo }));
      if (!saveCart(lines)) {
        inFlight.current = false;
        return;
      }
      setCart(lines);
      rememberAddress(shipTo);
    }
    await runCheckout(lines, btn);
  };

  // "Someone else": this piñata waits in its draft while the order that's
  // already in the cart (one address) checks out.
  const payOrderFirst = async (btn: HTMLButtonElement) => {
    if (inFlight.current || !cartAddress) return;
    // Only the ORDER's own problems count here — the piñata in progress
    // isn't part of it.
    if (stop(problems().filter((p) => p.kind === "carrier" || p.kind === "line" || p.kind === "email"))) {
      return;
    }
    inFlight.current = true;
    const lines = loadCart().map((l) => ({ ...l, carrier: carrier!, address: cartAddress }));
    if (!saveCart(lines)) {
      inFlight.current = false;
      return;
    }
    setCart(lines);
    await runCheckout(lines, btn);
  };

  const saveChanges = () => {
    if (stop(problems().filter((p) => p.kind !== "email"))) return;
    const next = commitDraft(loadCart(), shipTo, carrier!);
    if (!next) return;
    const parked = loadParked();
    saveParked(null);
    setDraft(parked); // null = back to the order review
    resetStep4();
    const url = new URL(window.location.href);
    url.searchParams.delete("edit");
    window.history.replaceState({ pgv2: true, pgDepth: Number(window.history.state?.pgDepth ?? 0) }, "", url);
    showToast("Saved your changes.");
    navigate("deliver", { via: "continue", history: "replace" });
  };

  const addAnother = (btn: HTMLButtonElement) => {
    const d = draftRef.current;
    if (!d) {
      setDraft(freshPiece(null));
      navigate("design", { via: "continue", history: "push" });
      return;
    }
    // This piñata needs what a line needs (the next one inherits the
    // address and the carrier).
    if (stop(problems().filter((p) => p.kind !== "email"))) return;
    const next = commitDraft(loadCart(), shipTo, carrier!);
    if (!next) return;
    confettiBurst(btn);
    setDraft(freshPiece(d.occasion));
    resetStep4();
    setPrefs((p) => ({ ...p, recipient: "same" }));
    showToast("Added to your order — on to the next one.");
    navigate("design", { via: "continue", history: "push" });
  };

  const editLine = (id: string) => {
    // the piñata in progress (or the line already open) — straight to it
    if (id === "current" || draftRef.current?.editLineId === id) {
      navigate("design", { via: "chip", history: "push" });
      return;
    }
    const line = cart.find((l) => l.id === id);
    if (!line) return;
    const d = draftRef.current;
    // set the piñata in progress aside (a reopened one too: it's unsaved)
    if (d && (!d.editLineId || d.resumed)) saveParked(d);
    setDraft(draftFromLine(line, d?.occasion ?? data.preset.occasion));
    resetStep4();
    const url = new URL(window.location.href);
    url.searchParams.set("edit", id);
    window.history.replaceState({ pgv2: true, pgDepth: Number(window.history.state?.pgDepth ?? 0) }, "", url);
    navigate("design", { via: "chip", history: "push" });
  };

  const removeLine = (id: string) => {
    if (id === "current") {
      saveDraftV2(null);
      setDraft(null);
      showToast("Removed this piñata.");
      return;
    }
    const next = loadCart().filter((l) => l.id !== id);
    saveCart(next);
    setCart(next);
    if (draftRef.current?.editLineId === id) {
      const parked = loadParked();
      saveParked(null);
      setDraft(parked);
    }
    showToast("Removed from your order.");
  };

  const fixLineDate = (lineId: string, ymd: string) => {
    const next = loadCart().map((l) => (l.id === lineId ? { ...l, deliveryDate: ymd } : l));
    if (saveCart(next)) setCart(next);
    setSheet(null);
    trackV2("delivery_date_picked", { soonest: ymd === soonest(cfg, lineCarrier), carrier: lineCarrier });
  };

  /* --- ActionBar ---------------------------------------------------------------- */

  const barPrice =
    step === "deliver"
      ? { cents: order.total, from: order.from }
      : (piecePrice ?? { cents: null, from: false });
  const fedexSoonest = formatYmd(soonest(cfg, "fedex"));
  const priceText =
    barPrice.cents === null
      ? null
      : `${step === "deliver" ? "Total " : ""}${barPrice.from ? "from " : ""}${formatCents(barPrice.cents)}`;

  // One polite, debounced announcement when a CHOICE changes the price —
  // not when a step change merely switches what the bar shows.
  const lastAnnounced = useRef<{ step: StepId; text: string } | null>(null);
  useEffect(() => {
    if (!hydrated || !priceText) return;
    const last = lastAnnounced.current;
    if (last && last.step === step && last.text !== priceText) {
      announce(`Price now ${priceText}${step === "deliver" ? "" : " delivered"}.`);
    }
    lastAnnounced.current = { step, text: priceText };
  }, [hydrated, priceText, step, announce]);

  /** The card can't be skipped: back to it, with the box marked. */
  const needMessage = () => {
    setMessageError(MESSAGE_REQUIRED);
    if (stepRef.current !== "card") navigate("card", { via: "chip", history: "push" });
    requestAnimationFrame(() => document.getElementById(MESSAGE_ID)?.focus());
    announce(MESSAGE_REQUIRED);
  };

  const explainNotReady = () => {
    if (draft && graphicReady(draft.graphic) && !hasMessage(draft)) {
      needMessage();
    } else if (saveStatus === "saving") {
      showToast("Your design is still saving — one moment.");
    } else {
      document.getElementById("pg-retry-save")?.focus();
      announce("Your design didn't save. Retry to continue.");
    }
  };

  let cta: Cta | null = null;
  if (!view && !loading) {
    if (step === "design" && draft) {
      const ready = graphicReady(draft.graphic);
      cta = {
        label: STEPS.design.next,
        short: STEPS.design.nextShort,
        notReady: !ready,
        onClick: () => (ready ? navigate("card", { via: "continue", history: "push" }) : explainNotReady()),
      };
    } else if (step === "card" && draft) {
      const empty = !hasMessage(draft);
      cta = {
        label: STEPS.card.next,
        short: STEPS.card.nextShort,
        // every piñata carries a message — there's no skipping the card
        notReady: empty,
        onClick: () => {
          if (empty) return needMessage();
          trackV2("message_step_completed", {
            has_message: !!draft.msgBody.trim(),
            has_from: !!draft.msgFrom.trim(),
            has_to: !!draft.msgTo.trim(),
            starter_used: draft.starterUsed,
          });
          navigate("inside", { via: "continue", history: "push" });
        },
      };
    } else if (step === "inside" && draft) {
      cta = {
        label: STEPS.inside.next,
        short: STEPS.inside.nextShort,
        onClick: () => navigate("deliver", { via: "continue", history: "push" }),
      };
    } else if (step === "deliver") {
      cta = editing
        ? { label: "Save changes", onClick: saveChanges }
        : someoneElse
          ? { label: "Check out my order first", short: "Check out order", onClick: payOrderFirst, busy }
          : { label: STEPS.deliver.next, short: STEPS.deliver.nextShort, onClick: pay, busy };
    }
  }

  let barNotice: ReactNode = null;
  if (step === "design" && saveStatus && !view) {
    barNotice =
      saveStatus === "saving" ? (
        <p className={f.saveStatus} data-state="saving" role="status" style={{ margin: 0 }}>
          <Spinner size={16} className={u.spin} /> Saving your design…
        </p>
      ) : saveStatus === "saved" ? (
        <p className={f.saveStatus} data-state="saved" role="status" style={{ margin: 0 }}>
          <Check size={16} /> Saved
        </p>
      ) : (
        <p className={f.saveStatus} data-state="failed" role="alert" style={{ margin: 0 }}>
          <Alert size={16} /> Couldn&apos;t save your design.
          <button
            id="pg-retry-save"
            type="button"
            className={st.linkBtn}
            onClick={() => {
              // Re-sends the same print file (or re-renders it from the
              // document) — no need to reopen the editor.
              if (draft?.graphic.type === "custom") void saveDesignArt(draft.graphic.design);
            }}
          >
            Retry
          </button>
        </p>
      );
  } else if (step === "deliver" && checkoutError) {
    barNotice = (
      <Callout tone="error" role="alert">
        {checkoutError}
      </Callout>
    );
  }

  /* --- render --------------------------------------------------------------------- */

  // The order review (nothing in progress) shows the latest piñata on stage.
  const last = cart.length ? cart[cart.length - 1] : null;
  const stageStyle: HubBodyStyle | null =
    style ??
    (last
      ? (stylesById.get(last.styleId) ?? {
          id: last.styleId,
          name: last.styleName,
          imageUrl: null,
          boxImageUrl: last.boxImageUrl,
          logoZone: last.logoZone,
          inStock: true,
        })
      : null);
  const stageGraphic = draft?.graphic ?? last?.graphic ?? null;
  const stageFilling = draft?.filling ?? last?.filling ?? null;
  const idx = STEPS[step].index;
  // The order review with nothing in progress steps back into the piñata
  // added last (resumeLastLine), not out to the home page.
  const backIntoOrder = !draft && step === "deliver" && cart.length > 0;
  const backLabel =
    view === "editor"
      ? "Close the editor"
      : idx === 0 || (!draft && !backIntoOrder)
        ? "Back to the home page"
        : `Back to ${STEPS[stepAt(idx - 1)].name}`;

  const back = () => {
    if (view === "editor") return closeEditor();
    if (Number(window.history.state?.pgDepth ?? 0) > 0) {
      window.history.back();
      return;
    }
    if (backIntoOrder && resumeLastLine()) {
      navigate(stepAt(idx - 1), { via: "back", history: "replace" });
      return;
    }
    if (idx === 0 || !draft) {
      router.push("/");
      return;
    }
    navigate(stepAt(idx - 1), { via: "back", history: "replace" });
  };

  const goToOrder = () => {
    if (step === "deliver" && !view) {
      document.getElementById("pg-order")?.scrollIntoView({ block: "start" });
      return;
    }
    if (draft && !graphicReady(draft.graphic)) {
      explainNotReady();
      return;
    }
    navigate("deliver", { via: "chip", history: "push" });
  };

  const wearable = (styleId: string) => {
    const g = draft?.graphic;
    if (g?.type !== "hub") return true;
    const rec = data.hubGraphics.find((h) => h.design === g.design);
    return !rec || rec.bodyStyles === "all" || rec.bodyStyles.includes(styleId);
  };

  const affected = order.views.filter((v) => !v.current && v.problem);
  const carrierNoticeNode =
    carrierNotice && carrierNotice === carrier ? (
      <Callout tone={affected.length ? "warning" : "info"} role="status">
        <p>
          Everything in this order now travels by{" "}
          {carrierNotice === "usps" ? "USPS First Class" : "FedEx"}.
        </p>
        {affected.length > 0 && (
          <p>
            {affected.map((v) => v.title).join(", ")}{" "}
            {affected.length === 1 ? "needs" : "need"} a new date — pick one in your order below.
          </p>
        )}
      </Callout>
    ) : null;

  const lineForSheet =
    sheet?.kind === "lineDate" ? (cart.find((l) => l.id === sheet.lineId) ?? null) : null;

  let content: ReactNode = null;
  if (step === "design" && draft && style) {
    content = (
      <StepDesign
        ref={h1Ref}
        graphic={draft.graphic}
        style={style}
        occasion={draft.occasion}
        strips={data.strips}
        hubStrip={data.hubStrip}
        hubGraphics={data.hubGraphics}
        hubCategories={data.hubCategories}
        tiered={tiered}
        pricing={pricing}
        libraryCount={data.libraryCount}
        allowCustom={variant.allowCustom}
        classic={variant.library !== "none"}
        onOccasion={(id) => {
          if (id === draft.occasion) return;
          patch({ occasion: id });
          trackV2("occasion_selected", { occasion: id });
        }}
        onPick={(g) => pickGraphic(g, "filmstrip")}
        onSeeAll={(occasion) => {
          libraryScroll.current = window.scrollY;
          setSheet({ kind: "library", occasion });
          trackV2("graphic_library_opened", { scope: occasion ?? "all" });
        }}
        onLibraryIntent={() => void loadLibrary()}
        onMakeOwn={() => openEditor(false)}
        banner={<PendingBanner className={st.block} />}
      />
    );
  } else if (step === "card" && draft) {
    content = (
      <StepCard
        ref={h1Ref}
        parts={parts}
        occasion={draft.occasion}
        notice={cardNotice}
        onNotice={setCardNotice}
        error={messageError}
        onParts={(p, o) => {
          if (p.body.trim() || p.to.trim()) setMessageError(null);
          patch({
            msgTo: p.to,
            msgBody: p.body,
            msgFrom: p.from,
            starterUsed: draft.starterUsed || !!o?.starter,
          });
        }}
      />
    );
  } else if (step === "inside" && draft) {
    content = (
      <StepInside
        ref={h1Ref}
        fillings={fillings}
        addons={data.addons}
        filling={draft.filling}
        selectedAddons={draft.addons}
        onFilling={pickFilling}
        onAddon={toggleAddon}
        notice={addonNotice}
      />
    );
  } else if (step === "deliver") {
    content = (
      <>
      {/* a new piñata in progress while an older order waits for payment */}
      {draft && <PendingBanner className={st.block} showView={false} />}
      <StepDeliver
        ref={h1Ref}
        hasPiece={!!draft}
        canAddAnother={!editing && !someoneElse}
        uspsOffered={uspsOffered}
        carrier={carrier}
        onCarrier={pickCarrier}
        fedexCents={unitPrice?.shipPerUnitCents ?? null}
        uspsCents={pricing.uspsShipPerUnitCents}
        carrierError={submitted && !carrier ? "Choose how it travels." : null}
        carrierNotice={carrierNoticeNode}
        cfg={cfg}
        date={draft?.date ?? ""}
        dateSoonest={!!draft?.dateSoonest}
        dateError={
          draft && carrier
            ? draft.date
              ? dateProblemText(draft.date, cfg, carrier)
              : submitted
                ? "Pick a delivery date."
                : null
            : null
        }
        onSoonest={pickSoonest}
        onClearDate={clearDate}
        onDate={pickDate}
        recipient={{
          cartAddress: cartAddressOk ? cartAddress : null,
          cartCount: cart.length,
          allowSomeoneElse: !!draft && !draft.editLineId,
          mode: prefs.recipient,
          onMode: (m) => setPrefs((p) => ({ ...p, recipient: m })),
          editing: editingAddress,
          onEdit: () => {
            setEditingAddress(true);
            if (cartAddress) setPrefs((p) => ({ ...p, address: cartAddress }));
          },
          address: prefs.address,
          errors: shownAddressErrors,
          carrier,
          onChange: (a) => setPrefs((p) => ({ ...p, address: { ...p.address, ...a } })),
          onBlurField: (k) => setTouched((t) => ({ ...t, [k]: true })),
        }}
        email={prefs.email}
        emailError={emailError && (touched.email || submitted) ? emailError : null}
        onEmail={(v) => setPrefs((p) => ({ ...p, email: v }))}
        onEmailBlur={() => setTouched((t) => ({ ...t, email: true }))}
        summary={{
          lines: order.views,
          shipping: { label: order.shipLabel, cents: order.shipTotal, from: order.from },
          discounts: order.codeRows,
          total: { cents: order.total, from: order.from },
          onEdit: editLine,
          onRemove: removeLine,
          onFixDate: (id) => setSheet({ kind: "lineDate", lineId: id }),
        }}
        discount={{
          discounts,
          onChange: (next) => {
            discountsTouched.current = true;
            setDiscounts(next);
          },
          notes: order.notes,
        }}
        onAddAnother={addAnother}
        result={dryRun && <DryRunResult payload={dryRun} />}
      />
      </>
    );
  }

  const priceSheet =
    sheet?.kind === "price" && draft && style
      ? priceRows(
          { graphic: draft.graphic, filling: draft.filling, addons: draft.addons, styleName: style.name },
          carrier,
          priceCtx,
        )
      : null;
  const otherLines = cart.filter((l) => l.id !== draft?.editLineId).length;
  // The piñata being built counts in the cart badge once it's part of the
  // order as the shopper sees it: on the last step (it's listed in "Your
  // order", and checkout includes it) or while other piñatas are already in
  // the order ("Add another"). An edit replaces its line — never twice.
  const cartExtra =
    draft && !draft.editLineId && (step === "deliver" || cart.length > 0) ? 1 : 0;

  return (
    <main className={f.flow} data-pg-journey>
      <FlowHeader
        step={step}
        maxReachable={maxReachable}
        backLabel={backLabel}
        onBack={back}
        onStep={(id) => {
          if (draft && STEPS[id].index > maxReachable) return explainNotReady();
          navigate(id, { via: "chip", history: "push" });
        }}
        onCart={goToOrder}
        cartExtra={cartExtra}
        reviewOnly={!draft}
      />

      {view === "editor" && style ? (
        <EditorView
          ref={h1Ref}
          style={style}
          graphic={draft?.graphic ?? null}
          retry={editorRetry}
          onClose={closeEditor}
          onSave={onEditorSave}
          onAssets={onEditorAssets}
        />
      ) : (
        <div className={f.layout}>
          <div className={f.stageCol}>
            {/* Phones pin Step 1's Stage under the header (see .stagePin). */}
            <div className={f.stagePin} data-step={step}>
              <Stage
                step={step}
                style={stageStyle}
                graphic={stageGraphic}
                message={draft ? message : ""}
                filling={stageFilling}
                fillingImage={fillings.find((x) => x.label === stageFilling)?.imageUrl ?? null}
                box={data.box}
                loading={loading}
                onBody={draft ? () => setSheet({ kind: "body" }) : undefined}
                onZoom={draft ? () => setSheet({ kind: "zoom" }) : undefined}
              />
            </div>
          </div>

          <div className={f.panel}>
            <div className={f.panelBody} id="pg-order">
              {loading ? (
                <div aria-busy="true" aria-label="Loading your piñata" style={{ display: "grid", gap: 16 }}>
                  <span className={u.skeleton} style={{ height: 36, width: "70%" }} />
                  <span className={u.skeleton} style={{ height: 120 }} />
                  <span className={u.skeleton} style={{ height: 120 }} />
                </div>
              ) : (
                content
              )}
            </div>
            <ActionBar
              thumb={
                step !== "deliver" && draft && style ? (
                  <BoxThumb
                    boxImageUrl={style.boxImageUrl}
                    logoZone={style.logoZone}
                    graphic={draft.graphic}
                    size={40}
                  />
                ) : undefined
              }
              main={
                step === "deliver" ? (
                  <>
                    Total <PriceTag cents={barPrice.cents} from={barPrice.from} />
                  </>
                ) : (
                  <PriceTag cents={barPrice.cents} from={barPrice.from} note="delivered" />
                )
              }
              sub={
                step === "deliver" ? (
                  "Plus tax at payment"
                ) : draft?.date && carrier && !dateProblemText(draft.date, cfg, carrier) ? (
                  <>
                    <Truck size={16} /> Arrives {arrivalText(draft.date, carrier, cfg)}
                  </>
                ) : carrier === "usps" ? (
                  <>
                    <Truck size={16} /> Earliest {formatWindow(uspsWindow(soonest(cfg, "usps"), cfg))}
                  </>
                ) : (
                  // Short: it shares a phone-width bar with the price and
                  // the button.
                  <>
                    <Truck size={16} /> Soonest {fedexSoonest}
                  </>
                )
              }
              onPrice={step !== "deliver" && draft ? () => setSheet({ kind: "price" }) : undefined}
              cta={cta}
              notice={barNotice}
            />
          </div>
        </div>
      )}

      {draft && style && (
        <>
          <BodySheet
            open={sheet?.kind === "body"}
            onClose={() => setSheet(null)}
            styles={data.styles}
            current={style.id}
            wearable={wearable}
            onPick={pickStyle}
          />
          <ZoomSheet
            open={sheet?.kind === "zoom"}
            onClose={() => setSheet(null)}
            graphic={draft.graphic}
            name={designName(draft.graphic)}
          />
          <LibrarySheet
            open={sheet?.kind === "library"}
            onClose={() => {
              setSheet(null);
              // the library restores ITS scroll on the page behind; put ours back
              requestAnimationFrame(() => window.scrollTo(0, libraryScroll.current));
            }}
            restrict={variant.library === "all" ? null : variant.library}
            hubGraphics={data.hubGraphics}
            hubCategories={data.hubCategories}
            styleId={style.id}
            onPick={(g) => {
              if (!sameGraphic(g, draft.graphic)) pickGraphic(g, "library");
              setSheet(null);
              requestAnimationFrame(() => window.scrollTo(0, libraryScroll.current));
            }}
            title={
              sheet?.kind === "library" && sheet.occasion
                ? `${occasionDef(sheet.occasion).label} designs`
                : "All designs"
            }
            initialView={
              sheet?.kind === "library" ? libraryViewFor(sheet.occasion) : undefined
            }
          />
          <PriceSheet
            open={!!priceSheet}
            onClose={() => setSheet(null)}
            rows={priceSheet?.rows ?? []}
            total={priceSheet?.total ?? { label: "Delivered", value: "—" }}
            note={
              otherLines
                ? `Your order also has ${otherLines} other piñata${otherLines === 1 ? "" : "s"} — you'll see everything at the last step.`
                : null
            }
          />
        </>
      )}
      <LineDateSheet
        key={lineForSheet?.id ?? "none"}
        open={!!lineForSheet}
        onClose={() => setSheet(null)}
        line={lineForSheet}
        title={lineForSheet ? `${designName(lineForSheet.graphic)} · ${lineForSheet.styleName}` : ""}
        carrier={lineCarrier}
        cfg={cfg}
        onPick={(ymd) => lineForSheet && fixLineDate(lineForSheet.id, ymd)}
      />
      <DateNeededSheet
        open={sheet?.kind === "dateNeeded"}
        onClose={() => setSheet(null)}
        carrier={carrier}
        cfg={cfg}
        soonestYmd={carrier ? soonest(cfg, carrier) : null}
        onSoonest={() => {
          pickSoonest();
          setSheet(null);
        }}
        onPick={(ymd) => {
          pickDate(ymd);
          setSheet(null);
        }}
      />
      <CarrierSwitchSheet
        to={sheet?.kind === "carrier" ? sheet.to : null}
        count={cart.length}
        onConfirm={confirmCarrier}
        onClose={() => setSheet(null)}
      />

      {toastRegion}
      {announceRegion}
    </main>
  );
}
