"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  catalogUrl,
  discountAmountCents,
  formatCents,
  priceUrl,
  resolveBuilderPricing,
  resolveDiscount,
  type BuilderPricing,
  type HubAddon,
  type HubDiscount,
  type HubFilling,
  type HubPrice,
} from "@/lib/hub";
import {
  DEFAULT_VARIANT,
  previewVariantName,
  resolveVariantProfile,
  type VariantProfile,
} from "@/lib/variant";
import {
  addressComplete,
  CART_EVENT,
  cartCarriers,
  cartSaveProblem,
  clearPendingOrder,
  discountParamCode,
  EMPTY_ADDRESS,
  graphicTierCents,
  loadCart,
  loadDiscountCodes,
  loadPendingOrders,
  PENDING_EVENT,
  pendingKey,
  rememberAddress,
  resolveFillings,
  sameDestination,
  saveCart,
  saveDiscountCodes,
  saveDraft,
  stateCode,
  storageAvailable,
  STORAGE_PROBLEM_COPY,
  US_STATES,
  type CartLine,
  type DeliveryAddress,
  type PendingOrder,
} from "@/lib/flow";
import { cdnThumb } from "@/lib/library-data";
import {
  deliveryProblemAtCheckout,
  formatWindow,
  formatYmd,
  resolveDeliveryConfig,
  uspsWindow,
  type Carrier,
  type DeliveryConfig,
} from "@/lib/delivery";
import {
  checkPendingOrders,
  reopenPendingOrder,
  resumePayment,
  startCheckout,
} from "@/lib/checkout-client";
import { CORPORATE_URL } from "@/lib/links";

const MAX_QTY = 25;

// The whole cart ships to ONE address (one order, one invoice). Editing it
// here rewrites every line. Autocomplete tokens put these fields in their
// own "recipient" section, so a browser's saved addresses fill them as a
// set (and never with the buyer's contact details from another form).
type AddrField = {
  key: keyof DeliveryAddress;
  label: string;
  auto: string;
  type?: "text" | "tel";
  inputMode?: "text" | "numeric" | "tel";
  maxLength?: number;
};
const ADDRESS_FIELDS: AddrField[] = [
  { key: "name", label: "Recipient's name", auto: "section-recipient shipping name", maxLength: 80 },
  { key: "address1", label: "Street address", auto: "section-recipient shipping address-line1", maxLength: 120 },
  { key: "address2", label: "Apt, suite, etc. (optional)", auto: "section-recipient shipping address-line2", maxLength: 120 },
  { key: "city", label: "City", auto: "section-recipient shipping address-level2", maxLength: 60 },
  { key: "province", label: "State", auto: "section-recipient shipping address-level1" },
  { key: "zip", label: "ZIP code", auto: "section-recipient shipping postal-code", inputMode: "numeric", maxLength: 10 },
  { key: "phone", label: "Phone (optional)", auto: "section-recipient shipping tel", type: "tel", inputMode: "tel", maxLength: 24 },
];

const ZIP_RE = /^\d{5}(-?\d{4})?$/;
const PO_BOX_RE = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i;

type AddrErrors = Partial<Record<keyof DeliveryAddress, string>>;

function addressErrors(a: DeliveryAddress, fedex: boolean): AddrErrors {
  const e: AddrErrors = {};
  if (!a.name.trim()) e.name = "Enter the recipient's name.";
  if (!a.address1.trim()) e.address1 = "Enter a street address.";
  else if (fedex && PO_BOX_RE.test(`${a.address1} ${a.address2}`))
    e.address1 = "FedEx can't deliver to a PO box — use a street address.";
  if (!a.city.trim()) e.city = "Enter a city.";
  if (!a.province.trim()) e.province = "Choose a state.";
  if (!a.zip.trim()) e.zip = "Enter a ZIP code.";
  else if (!ZIP_RE.test(a.zip.trim())) e.zip = "Enter a 5-digit ZIP code.";
  const digits = a.phone.replace(/\D/g, "");
  if (a.phone.trim() && (digits.length < 10 || digits.length > 11))
    e.phone = "Enter a 10-digit phone number, or leave it blank.";
  return e;
}

// Display prices and the catalog come from the hub; a blip retries with
// backoff instead of leaving the cart stuck on "Getting prices…". A 4xx
// won't get better, so it stops early.
async function fetchJsonRetry<T>(url: string, alive: () => boolean): Promise<T | null> {
  for (let i = 0; i < 4 && alive(); i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return (await r.json()) as T;
      if (r.status >= 400 && r.status < 500 && r.status !== 429) return null;
    } catch {}
    if (i < 3) await new Promise((res) => setTimeout(res, 800 * 2 ** i));
  }
  return null;
}

function lineTitle(l: CartLine): string {
  return l.graphic.type === "custom"
    ? `Your design — ${l.styleName}`
    : l.graphic.type === "hub"
      ? `Your graphic — ${l.styleName}`
      : `${l.graphic.title} — ${l.styleName}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// "Your box" thumbnail: the graphic composited onto the style's box photo
// (same logoZone math as the preview rail); falls back to the raw art.
function CartBoxThumb({ line, className = "" }: { line: CartLine; className?: string }) {
  const art =
    line.graphic.type === "custom"
      ? line.graphic.preview
      : line.graphic.type === "hub"
        ? (line.graphic.thumb ?? line.graphic.art ?? "")
        : (cdnThumb(line.graphic.art ?? line.graphic.thumb, 360) ?? "");
  if (!line.boxImageUrl || !line.logoZone) {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img className={`cart-thumb ${className}`} src={art || undefined} alt="" />;
  }
  return (
    <div className={`cart-thumb box-composite ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={line.boxImageUrl} alt="" className="box-img" />
      {art && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={art}
          alt=""
          className="box-art"
          style={{
            left: `${line.logoZone.x * 100}%`,
            top: `${line.logoZone.y * 100}%`,
            width: `${line.logoZone.w * 100}%`,
            height: `${line.logoZone.h * 100}%`,
          }}
        />
      )}
    </div>
  );
}

/**
 * A checkout that's waiting for payment. The drafted piñatas live HERE, not
 * in the cart, until Shopify says paid (the card disappears) or the draft
 * is gone (they return to the cart). "Change order" / merge re-ask Shopify
 * first, then move them back so the next checkout replaces this draft.
 */
function PendingCard({
  order,
  verifying,
  busy,
  hasActive,
  compatible,
  dateStale,
  onResume,
  onReopen,
  onDiscard,
}: {
  order: PendingOrder;
  verifying: boolean;
  busy: boolean;
  hasActive: boolean;
  compatible: boolean;
  dateStale: boolean;
  onResume: () => void;
  onReopen: () => void;
  onDiscard: () => void;
}) {
  const units = order.lines.reduce((s, l) => s + l.qty, 0);
  const to = order.lines.find((l) => addressComplete(l.address))?.address;
  const headId = `pending-${pendingKey(order).replace(/\W/g, "")}`;
  const locked = busy || verifying;
  const summary = order.lines.length ? (
    <>
      <ul className="pending-lines">
        {order.lines.map((l) => (
          <li key={l.id}>
            <CartBoxThumb line={l} className="mini" />
            <span>
              {lineTitle(l)}
              {l.qty > 1 ? ` × ${l.qty}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <p className="note pending-to">
        {units} {plural(units, "piñata", "piñatas")}
        {to ? ` to ${to.name}, ${to.city} ${to.province}` : ""}
      </p>
    </>
  ) : null;

  if (order.expired) {
    return (
      <section className="pending-order expired" aria-labelledby={headId}>
        <div className="pending-head">
          <strong id={headId}>
            An earlier order wasn&apos;t paid, and its checkout has closed.
          </strong>
        </div>
        {summary}
        {!compatible && (
          <p className="note">
            It ships to a different address than your cart — check out or
            clear your cart first, then move it back.
          </p>
        )}
        <div className="pending-actions">
          {compatible && (
            <button className="btn primary" onClick={onReopen} disabled={locked}>
              Move it to your cart
            </button>
          )}
          <button className="btn ghost" onClick={onDiscard} disabled={locked}>
            Discard it
          </button>
        </div>
      </section>
    );
  }

  const canReopen = order.lines.length > 0;
  return (
    <section className="pending-order" aria-labelledby={headId} aria-busy={verifying}>
      <div className="pending-head">
        <strong id={headId}>
          Almost there — your order isn&apos;t placed until you pay.
        </strong>
      </div>
      {summary}
      {verifying ? (
        <p className="note" role="status">
          Checking whether it&apos;s been paid…
        </p>
      ) : dateStale ? (
        <p className="pending-warn">
          Its delivery date is no longer available — change the order to pick
          a new date before paying.
        </p>
      ) : hasActive ? (
        <p className="note">
          {compatible
            ? "You also have piñatas in your cart below. Add this waiting order to them and check out once — or pay for it separately."
            : `It ships to ${to?.name ?? "a different address"}, and your cart ships somewhere else — each address is its own order, so pay for it separately.`}
        </p>
      ) : (
        <p className="note">
          Finish paying on our secure checkout to lock it in, or change it and
          check out again.
        </p>
      )}
      <div className="pending-actions">
        {hasActive ? (
          <>
            {compatible && canReopen && (
              <button className="btn primary" onClick={onReopen} disabled={locked}>
                Add the waiting order to this one
              </button>
            )}
            {!dateStale && (
              <button
                className={"btn" + (compatible && canReopen ? "" : " primary")}
                onClick={onResume}
                disabled={locked}
              >
                Pay for it separately
              </button>
            )}
            {dateStale && !compatible && (
              <button className="btn ghost" onClick={onDiscard} disabled={locked}>
                Discard it
              </button>
            )}
          </>
        ) : (
          <>
            {!dateStale && (
              <button className="btn primary" onClick={onResume} disabled={locked}>
                Resume payment →
              </button>
            )}
            {canReopen && (
              <button
                className={"btn" + (dateStale ? " primary" : "")}
                onClick={onReopen}
                disabled={locked}
              >
                Change order
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

type FocusTarget =
  | { kind: "line"; id: string }
  | { kind: "address" }
  | { kind: "carrier" }
  | { kind: "error" };

export default function CartView() {
  const router = useRouter();
  const [lines, setLines] = useState<CartLine[] | null>(null);
  // Checkouts waiting for payment (their lines are NOT in `lines`).
  const [pendings, setPendings] = useState<PendingOrder[]>([]);
  // True while the forced paid check runs — the pending cards hold their
  // actions so nobody reopens an order that was just paid.
  const [verifying, setVerifying] = useState(false);
  // Waiting orders Shopify confirmed as paid during this visit.
  const [confirmed, setConfirmed] = useState<PendingOrder[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [unitPrice, setUnitPrice] = useState<HubPrice | null>(null);
  const [pricesFailed, setPricesFailed] = useState(false);
  const [addonCatalog, setAddonCatalog] = useState<HubAddon[]>([]);
  const [fillingCatalog, setFillingCatalog] = useState<HubFilling[]>(
    resolveFillings(undefined),
  );
  // Graphic-tier upcharges + USPS rate, and the delivery calendars (USPS
  // window strings) — both from the catalog; compiled defaults until it lands.
  const [pricing, setPricing] = useState<BuilderPricing>(
    resolveBuilderPricing(undefined),
  );
  const [deliveryCfg, setDeliveryCfg] = useState<DeliveryConfig>(
    resolveDeliveryConfig(undefined),
  );
  // The live catalog arrived. Until then the compiled delivery calendar may
  // disagree with the hub's, so stale dates are flagged but don't block.
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  // The storefront's variant profile (resolved by hostname; preview override
  // outside production). Flat = no tier upcharges; carriers gate USPS.
  const [variant, setVariant] = useState<VariantProfile>(DEFAULT_VARIANT);
  // True only once the catalog fetch DELIVERED a profile. The self-heal
  // below must never run against the compiled default — the fetch races the
  // cart load, and healing on the placeholder would rewrite a legitimate
  // USPS cart to FedEx on a storefront that offers USPS.
  const [variantLoaded, setVariantLoaded] = useState(false);
  // Set when the cart self-healed a USPS line on a FedEx-only variant.
  const [carrierNotice, setCarrierNotice] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Dry-run (no Shopify creds): the server's reason + payload, shown as-is.
  const [dryRun, setDryRun] = useState<{
    reason: string;
    draftOrders: { groupKey?: string; shipTo?: string; input?: unknown }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-line problems from the server (lineErrors), by line id.
  const [serverIssues, setServerIssues] = useState<
    Record<string, { code: string; message: string }>
  >({});
  // Lines the last checkout attempt flagged client-side (stale dates).
  const [flagged, setFlagged] = useState<string[]>([]);
  const [focusReq, setFocusReq] = useState<{ target: FocusTarget; n: number } | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [codeOpen, setCodeOpen] = useState(false);
  const [discounts, setDiscounts] = useState<HubDiscount[]>([]);
  // Saved/linked codes that didn't resolve (expired, used up — or the check
  // itself failed): shown with Try again / Remove, never dropped silently.
  const [deadCodes, setDeadCodes] = useState<string[]>([]);
  const [discountMsg, setDiscountMsg] = useState<string | null>(null);
  const [checkingCode, setCheckingCode] = useState(false);
  // True once the shopper applies/removes a code — stops the async mount
  // restore from clobbering a code they added before it resolved.
  const userTouched = useRef(false);
  // Non-null while editing the single ship-to address.
  const [editingAddr, setEditingAddr] = useState<DeliveryAddress | null>(null);
  const [addrErrors, setAddrErrors] = useState<AddrErrors>({});
  const [addrTouched, setAddrTouched] = useState<Set<keyof DeliveryAddress>>(new Set());
  const [storageOk, setStorageOk] = useState(true);
  // Phones get the sticky bar; checkout feedback lands next to it there.
  const [narrow, setNarrow] = useState(false);
  const narrowRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const barErrorRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    // Pending first: it migrates a pre-v2 record's lines out of the cart.
    setPendings(loadPendingOrders());
    setLines(loadCart());
  }, []);

  // Ask Shopify about waiting orders NOW (not on the header's 10-minute
  // throttle) — this page is where they get resumed or reopened.
  const verifyPending = useCallback(() => {
    if (!loadPendingOrders().some((p) => p.draftOrderId && !p.expired)) return;
    setVerifying(true);
    checkPendingOrders({ force: true })
      .then((res) => {
        if (res.paid.length) setConfirmed((c) => [...c, ...res.paid]);
        refresh();
      })
      .finally(() => setVerifying(false));
  }, [refresh]);

  const loadPrices = useCallback(() => {
    setPricesFailed(false);
    const isAlive = () => alive.current;
    const price = fetchJsonRetry<HubPrice>(
      priceUrl({
        qty: 1,
        fill: "filled",
        bodyType: "standard",
        graphicType: "custom",
        mode: "individual",
        carrier: "standard",
      }),
      isAlive,
    ).then((p) => {
      if (p && Number.isFinite(p.unitPriceCents)) setUnitPrice(p);
      return !!p;
    });
    // Add-on/filling labels + prices come from the live catalog (display
    // only — checkout re-resolves everything server-side). The fetch carries
    // this page's hostname so the variant profile matches what the server
    // pages resolved (and what checkout will re-resolve).
    const catalog = fetchJsonRetry<Record<string, unknown>>(
      catalogUrl({
        host: window.location.hostname,
        previewVariant: previewVariantName(),
      }),
      isAlive,
    ).then((c) => {
      if (!c) return false;
      setAddonCatalog((c.addons as HubAddon[] | undefined) ?? []);
      setFillingCatalog(resolveFillings(c.fillings as HubFilling[] | undefined));
      setPricing(resolveBuilderPricing(c.pricing));
      setDeliveryCfg(resolveDeliveryConfig(c.delivery));
      setCatalogLoaded(true);
      if (c.variant) {
        setVariant(resolveVariantProfile(c.variant));
        setVariantLoaded(true);
      }
      return true;
    });
    Promise.all([price, catalog]).then(([a, b]) => {
      if (alive.current && !(a && b)) setPricesFailed(true);
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    setStorageOk(storageAvailable());
    verifyPending();
    loadPrices();

    // Restore previously applied codes (they survive a cart refresh) and
    // any ?discount=CODE riding the URL (a QR/marketing link straight to
    // the cart) — read here directly because this child effect runs before
    // the layout's capture effect can stash it.
    const fromUrl = discountParamCode();
    const codes = [
      ...(fromUrl ? [fromUrl] : []),
      ...loadDiscountCodes().filter((c) => c !== fromUrl),
    ].slice(0, 2);
    if (codes.length) {
      Promise.all(codes.map((c) => resolveDiscount(c))).then((rs) => {
        // If the shopper already applied/removed a code while this resolved,
        // theirs wins — don't overwrite it with the restored set.
        if (userTouched.current || !alive.current) return;
        // One code per kind; a code that no longer resolves stays visible
        // as "couldn't be applied" (it may be a lookup blip — Try again).
        const live: HubDiscount[] = [];
        const dead: string[] = [];
        const clashed: string[] = [];
        rs.forEach((d, i) => {
          if (!d) dead.push(codes[i]);
          else if (live.some((x) => x.kind === d.kind)) clashed.push(d.code);
          else live.push(d);
        });
        setDiscounts(live);
        setDeadCodes(dead);
        saveDiscountCodes([...live.map((d) => d.code), ...dead]);
        if (clashed.length) {
          setDiscountMsg(
            `${clashed.join(", ")} can't be combined with ${live
              .map((d) => d.code)
              .join(", ")}, so we kept ${live.length === 1 ? "that one" : "those"}.`,
          );
        }
      });
    }

    // Another tab, or the header's paid check (a gone draft's lines come
    // back), can change the cart or the waiting orders under this page.
    // (Other keys — analytics libraries write constantly — are ignored.)
    const onChange = () => refresh();
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith("pinatagrams-builder-")) refresh();
    };
    window.addEventListener(CART_EVENT, onChange);
    window.addEventListener(PENDING_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    // Back from Shopify's invoice restores this page from the back/forward
    // cache with its OLD state (lines that have since moved to a waiting
    // order, a stuck "Heading to checkout…") — reload it all.
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      setSubmitting(false);
      refresh();
      verifyPending();
    };
    window.addEventListener("pageshow", onShow);
    const mq = window.matchMedia("(max-width: 900px)");
    const onMq = () => {
      narrowRef.current = mq.matches;
      setNarrow(mq.matches);
    };
    onMq();
    mq.addEventListener?.("change", onMq);
    return () => {
      alive.current = false;
      window.removeEventListener(CART_EVENT, onChange);
      window.removeEventListener(PENDING_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onShow);
      mq.removeEventListener?.("change", onMq);
    };
  }, [refresh, verifyPending, loadPrices]);

  // Self-heal: a cart built while USPS was offered, now viewed on a variant
  // without it (profile change mid-sitting, or a cross-variant link) —
  // rewrite the lines to FedEx VISIBLY, never leave a cart whose display
  // and checkout disagree. Mirrors the single-address collapse pattern.
  // Gated on a RESOLVED profile: a failed/slow catalog fetch must never
  // heal against the placeholder (checkout's own re-resolution is the
  // loud backstop for a genuinely invalid USPS order).
  useEffect(() => {
    if (!lines || !variantLoaded || variant.carriers.includes("usps")) return;
    if (!lines.some((l) => l.carrier === "usps")) return;
    const healed = lines.map((l) =>
      l.carrier === "usps" ? { ...l, carrier: "fedex" as const } : l,
    );
    if (saveCart(healed) || cartSaveProblem() === "blocked") {
      setLines(healed);
      setCarrierNotice(true);
    }
  }, [lines, variant, variantLoaded]);

  // Move focus to whatever the last checkout attempt needs fixed: the
  // flagged piñata, the address form, or the message beside the button the
  // shopper pressed (the sticky bar's on phones).
  useEffect(() => {
    if (!focusReq) return;
    const t = focusReq.target;
    const id = requestAnimationFrame(() => {
      const q = (sel: string) => document.querySelector<HTMLElement>(sel);
      let el: HTMLElement | null = null;
      let scroll = true;
      if (t.kind === "line") {
        el =
          document.getElementById(`issue-${t.id}`) ??
          document.getElementById(`line-${t.id}`);
      } else if (t.kind === "address") {
        el =
          q(".cart-addr [aria-invalid='true']") ??
          q(".cart-addr input") ??
          document.getElementById("ship-to");
      } else if (t.kind === "carrier") {
        el = document.getElementById("carrier-choice");
      } else if (narrowRef.current) {
        el = barErrorRef.current;
        scroll = false; // the bar is pinned in view
      } else {
        el = errorRef.current;
      }
      if (!el) return;
      if (scroll) el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [focusReq]);

  const addonById = new Map(addonCatalog.map((a) => [a.id, a]));
  const fillingByLabel = new Map(fillingCatalog.map((f) => [f.label, f]));
  // Per-unit add-on/filling cost for one line; unknown ids price at 0 here
  // and get rejected server-side if they somehow reach checkout.
  const lineAddonCents = (l: CartLine) =>
    (l.addons ?? []).reduce(
      (s, id) => s + (addonById.get(id)?.priceCents ?? 0),
      0,
    );
  const lineFillingCents = (l: CartLine) =>
    fillingByLabel.get(l.filling)?.priceCents ?? 0;

  const showError = (msg: string, target: FocusTarget = { kind: "error" }) => {
    setError(msg);
    setFocusReq((r) => ({ target, n: (r?.n ?? 0) + 1 }));
  };

  // Persist FIRST: if the browser's storage is full (photo-heavy custom
  // designs are large), commit nothing and say so — better than a change
  // that looks saved but silently vanishes on refresh. A browser that
  // blocks storage outright keeps the cart in memory for this visit (the
  // banner says so). Removing a line shrinks the cart, so it always saves.
  const update = (next: CartLine[]): boolean => {
    if (saveCart(next) || cartSaveProblem() === "blocked") {
      setLines(next);
      setError(null);
      setServerIssues({});
      setFlagged([]);
      if (cartSaveProblem() === "blocked") setStorageOk(false);
      return true;
    }
    showError(STORAGE_PROBLEM_COPY.full);
    return false;
  };

  // Reopen the flow loaded with this line; saving replaces it. Lands on the
  // delivery step (the address is inherited, so Send-to is skipped) — ready
  // to re-save, with the chips to jump back to graphic/message/etc.
  const editLine = (l: CartLine) => {
    saveDraft({
      styleId: l.styleId,
      graphic: l.graphic,
      message: l.message,
      filling: l.filling,
      addons: l.addons ?? [],
      date: l.deliveryDate,
      carrier: l.carrier,
      address: l.address,
      editLineId: l.id,
    });
    // v2 names its delivery step "deliver". Preview sittings carry the
    // variant across the server-rendered hop, or the design page would
    // render the default.
    const step = document.body.dataset.flow === "v2" ? "deliver" : "delivery";
    const pv = previewVariantName();
    router.push(
      `/design?style=${encodeURIComponent(l.styleId)}&edit=${encodeURIComponent(l.id)}&step=${step}${
        pv ? `&variant=${encodeURIComponent(pv)}` : ""
      }`,
    );
  };

  const storeCodes = (live: HubDiscount[], dead: string[]) =>
    saveDiscountCodes([...live.map((d) => d.code), ...dead]);

  const applyCode = async () => {
    const code = codeInput.trim().toUpperCase();
    if (!code) {
      setDiscountMsg(null);
      return;
    }
    if (discounts.some((d) => d.code === code)) {
      setDiscountMsg("That code is already applied.");
      return;
    }
    if (discounts.length >= 2) {
      setDiscountMsg("You can apply up to two codes.");
      return;
    }
    setCheckingCode(true);
    setDiscountMsg(null);
    const d = await resolveDiscount(code);
    setCheckingCode(false);
    if (!d) {
      setDiscountMsg("That code isn’t valid.");
      return;
    }
    // Codes stack only ACROSS kinds — one order discount + one free-shipping.
    if (discounts.some((x) => x.kind === d.kind)) {
      setDiscountMsg(
        d.kind === "shipping"
          ? "You already have a free-shipping code."
          : "You already have an order discount — it only stacks with a free-shipping code.",
      );
      return;
    }
    userTouched.current = true;
    const next = [...discounts, d];
    // Two codes max in storage: a dead one yields its slot to a live one.
    const dead = deadCodes.slice(0, Math.max(0, 2 - next.length));
    setDiscounts(next);
    setDeadCodes(dead);
    storeCodes(next, dead);
    setCodeInput("");
    setCodeOpen(false);
  };

  const removeCode = (code: string) => {
    userTouched.current = true;
    const next = discounts.filter((d) => d.code !== code);
    const dead = deadCodes.filter((c) => c !== code);
    setDiscounts(next);
    setDeadCodes(dead);
    storeCodes(next, dead);
    setDiscountMsg(null);
  };

  const retryCode = async (code: string) => {
    userTouched.current = true;
    setCheckingCode(true);
    setDiscountMsg(null);
    const d = await resolveDiscount(code);
    setCheckingCode(false);
    if (!d) {
      setDiscountMsg(`${code} still isn’t valid — remove it or try another code.`);
      return;
    }
    if (discounts.some((x) => x.kind === d.kind) || discounts.length >= 2) {
      setDiscountMsg(`${code} can't be combined with the code you already have.`);
      return;
    }
    const next = [...discounts, d];
    const dead = deadCodes.filter((c) => c !== code);
    setDiscounts(next);
    setDeadCodes(dead);
    storeCodes(next, dead);
  };

  // Waiting-order actions.
  const reopen = async (p: PendingOrder, merge: boolean) => {
    const key = pendingKey(p);
    setBusyKey(key);
    setFlash(null);
    const r = await reopenPendingOrder(key);
    setBusyKey(null);
    refresh();
    if (r === "paid") {
      setConfirmed((c) => [...c, p]);
    } else if (r === "restored") {
      setFlash(
        p.expired
          ? "Those piñatas are back in your cart."
          : merge
            ? "Added — the waiting order is part of this one now. Check out once for everything."
            : "Your order is back in the cart. Make your changes, then check out again — we'll replace the old checkout.",
      );
    } else if (r === "address") {
      setFlash(
        "That order ships to a different address than your cart — each address is its own order.",
      );
    } else if (r === "full") {
      setFlash(STORAGE_PROBLEM_COPY.full);
    }
  };

  const discard = (p: PendingOrder) => {
    clearPendingOrder(pendingKey(p));
    refresh();
  };

  // --- address editor -------------------------------------------------------
  const cartLines = lines ?? [];
  const carriers = cartCarriers(cartLines);
  const mixedCarriers = carriers.length > 1;
  // One carrier for the whole order (single-carrier invariant, like the one
  // address); pre-USPS carts read as FedEx.
  const carrier: Carrier = carriers[0] ?? "fedex";
  const hasFedex = carriers.includes("fedex") || !cartLines.length;

  // The one ship-to address (all lines share it). Editing rewrites every
  // line so the whole cart stays one destination → one draft → one invoice.
  const shipTo = cartLines.find((l) => addressComplete(l.address))?.address ?? null;

  const openAddr = () => {
    const a = shipTo ?? EMPTY_ADDRESS;
    // Legacy free-text states ("California") become the select's code.
    setEditingAddr({ ...a, province: stateCode(a.province) || a.province });
    setAddrErrors({});
    setAddrTouched(new Set());
  };

  const setAddrField = (key: keyof DeliveryAddress, value: string) => {
    if (!editingAddr) return;
    const next = { ...editingAddr, [key]: value };
    setEditingAddr(next);
    // Once a field has been left (or a save tried), keep its error live.
    if (addrTouched.has(key)) {
      const errs = addressErrors(next, hasFedex);
      setAddrErrors((prev) => ({ ...prev, [key]: errs[key] }));
    }
  };

  const blurAddrField = (key: keyof DeliveryAddress) => {
    if (!editingAddr) return;
    setAddrTouched((t) => new Set(t).add(key));
    const errs = addressErrors(editingAddr, hasFedex);
    setAddrErrors((prev) => ({ ...prev, [key]: errs[key] }));
  };

  const saveAddr = () => {
    if (!editingAddr || !lines) return;
    const clean: DeliveryAddress = {
      name: editingAddr.name.trim(),
      address1: editingAddr.address1.trim(),
      address2: editingAddr.address2.trim(),
      city: editingAddr.city.trim(),
      province: stateCode(editingAddr.province) || editingAddr.province.trim(),
      zip: editingAddr.zip.trim(),
      phone: editingAddr.phone.trim(),
    };
    const errs = addressErrors(clean, hasFedex);
    const first = ADDRESS_FIELDS.find((f) => errs[f.key]);
    if (first) {
      setAddrErrors(errs);
      setAddrTouched(new Set(ADDRESS_FIELDS.map((f) => f.key)));
      requestAnimationFrame(() =>
        document.getElementById(`cart-addr-${first.key}`)?.focus(),
      );
      return;
    }
    if (update(lines.map((l) => ({ ...l, address: clean })))) {
      rememberAddress(clean);
      setEditingAddr(null);
      setAddrErrors({});
    }
  };

  if (lines === null) return <p className="note">Loading…</p>;

  const hasActive = lines.length > 0;

  // Is a line's date still orderable? Same rule as checkout (incl. its
  // one-day grace), against the order's carrier — or the line's own while
  // the cart disagrees about carriers.
  const lineDateIssue = (l: CartLine): "missing" | "stale" | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.deliveryDate)) return "missing";
    const c: Carrier = mixedCarriers ? (l.carrier === "usps" ? "usps" : "fedex") : carrier;
    return deliveryProblemAtCheckout(l.deliveryDate, deliveryCfg, c) ? "stale" : null;
  };
  const orderDateStale = (p: PendingOrder) =>
    p.lines.some((l) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(l.deliveryDate)) return false;
      return !!deliveryProblemAtCheckout(
        l.deliveryDate,
        deliveryCfg,
        l.carrier === "usps" ? "usps" : "fedex",
      );
    });

  const pendingCards = pendings.map((p) => (
    <PendingCard
      key={pendingKey(p)}
      order={p}
      verifying={verifying && !p.expired}
      busy={busyKey !== null}
      hasActive={hasActive}
      compatible={sameDestination(lines, p.lines)}
      // Only the live calendar may hide "Resume payment" — never the
      // compiled fallback.
      dateStale={catalogLoaded && orderDateStale(p)}
      onResume={() => resumePayment(p)}
      onReopen={() => reopen(p, hasActive)}
      onDiscard={() => discard(p)}
    />
  ));

  const flashNote = flash && (
    <div className="notice info" role="status">
      {flash}
    </div>
  );

  const storageNote = !storageOk && (
    <div className="notice warn storage-note" role="status">
      {STORAGE_PROBLEM_COPY.blocked}
    </div>
  );

  // Paid while away and nothing else is waiting — thank-you.
  if (!hasActive && pendings.length === 0 && confirmed.length > 0) {
    return (
      <div className="step-panel">
        <div className="pending-order">
          <div className="pending-head">
            <strong>Thanks — your order is confirmed! 🎉</strong>
          </div>
          <p className="note">
            We&apos;ve got it from here. Watch for a confirmation, and we&apos;ll
            get your piñata on its way.
          </p>
        </div>
        <p>
          <Link className="btn" href="/">
            + Send another piñata
          </Link>
        </p>
      </div>
    );
  }

  if (!hasActive) {
    return (
      <div className="step-panel">
        {confirmed.length > 0 && (
          <div className="notice info" role="status">
            One of your orders is confirmed — thank you!
          </div>
        )}
        {flashNote}
        {pendingCards}
        {pendings.length === 0 && <p>Nothing here yet.</p>}
        {!storageOk && pendings.length === 0 && (
          <p className="note">
            Added a piñata and it isn&apos;t here? Your browser is blocking
            storage, so the cart can&apos;t carry it between pages — turn off
            private browsing (or open this page in Safari or Chrome) and try
            again.
          </p>
        )}
        <Link className={"btn" + (pendings.length ? "" : " primary")} href="/">
          {pendings.length ? "+ Send another piñata" : "Design a piñata →"}
        </Link>
      </div>
    );
  }

  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  const unitCents = unitPrice?.unitPriceCents ?? null;
  const fedexShipCents = unitPrice?.shipPerUnitCents ?? null;
  const lineShipCents = (l: CartLine): number | null =>
    (mixedCarriers ? l.carrier === "usps" : carrier === "usps")
      ? pricing.uspsShipPerUnitCents
      : fedexShipCents;
  // Graphic tiers apply only on tiered variants: Classic default = base
  // price; library/custom lines carry their upcharge (folded into the
  // piñatas row below). Flat variants price every graphic the same.
  const lineTierCents = (l: CartLine) =>
    variant.pricing === "tiered" ? graphicTierCents(l.graphic, pricing) : 0;
  const tierTotalCents = lines.reduce(
    (s, l) => s + lineTierCents(l) * l.qty,
    0,
  );
  const extrasTotalCents = lines.reduce(
    (s, l) => s + (lineAddonCents(l) + lineFillingCents(l)) * l.qty,
    0,
  );
  // Merchandise (piñatas + tiers + fillings + add-ons) and shipping, for the
  // PREVIEW estimate only — the real discount is the native Shopify code
  // applied to the draft, so the Shopify invoice is the true total. An order
  // code takes %/$ off merchandise; a shipping code zeroes shipping. Both the
  // price AND the catalog must have landed: without the catalog, add-ons
  // would price at $0 and the total would understate.
  const merchandiseCents =
    unitCents !== null && catalogLoaded
      ? unitCents * totalUnits + tierTotalCents + extrasTotalCents
      : null;
  const shipTotalCents = lines.reduce<number | null>((s, l) => {
    const c = lineShipCents(l);
    return s === null || c === null ? null : s + c * l.qty;
  }, 0);
  // One row per applied code. Amount/eligibility need loaded prices; until
  // they arrive (or if the price fetch failed) we still LIST the code — so it
  // stays visible and removable — but as amount-unknown, not below-minimum.
  // An order code comes off merchandise, a shipping code off shipping; kinds
  // are distinct (enforced on apply) so the amounts sum without double
  // counting. Shopify recomputes the authoritative invoice total.
  const pricesKnown = merchandiseCents !== null && shipTotalCents !== null;
  const codePreview = discounts.map((d) => {
    const minOk = pricesKnown && merchandiseCents! >= d.minSubtotalCents;
    // A capped Shopify free-shipping code ("rates under $X") covers nothing
    // when this order's shipping meets the cap — flag it like below-minimum
    // so the customer isn't promised a discount the invoice won't show.
    const capBlocked =
      pricesKnown &&
      d.kind === "shipping" &&
      d.maxShippingCents != null &&
      shipTotalCents! >= d.maxShippingCents;
    return {
      d,
      known: pricesKnown,
      eligible: minOk && !capBlocked,
      belowMin: pricesKnown && !minOk,
      capBlocked,
      off: minOk
        ? discountAmountCents(d, merchandiseCents!, shipTotalCents!)
        : 0,
    };
  });
  const discountOffCents = codePreview.reduce((s, c) => s + c.off, 0);
  const totalCents = pricesKnown
    ? merchandiseCents! + shipTotalCents! - discountOffCents
    : null;

  const shippingLabel = mixedCarriers
    ? "Shipping"
    : carrier === "usps"
      ? "USPS First Class"
      : "Guaranteed FedEx delivery";

  // Everything checkout would refuse that the cart can see for itself —
  // caught here so the shopper fixes it in place, told exactly where.
  const precheck = (current: CartLine[]): boolean => {
    const to = current.find((l) => addressComplete(l.address))?.address;
    const cs = cartCarriers(current);
    // An open, unsaved address edit would otherwise be silently ignored —
    // the order would ship to the OLD address.
    if (editingAddr) {
      showError("Save the delivery address (or cancel the edit) before checking out.", {
        kind: "address",
      });
      return false;
    }
    if (!to) {
      openAddr();
      showError("Add the delivery address to check out.", { kind: "address" });
      return false;
    }
    if (cs.includes("fedex") && PO_BOX_RE.test(`${to.address1} ${to.address2}`)) {
      openAddr();
      setAddrErrors({ address1: "FedEx can't deliver to a PO box — use a street address." });
      setAddrTouched(new Set<keyof DeliveryAddress>(["address1"]));
      showError("FedEx can't deliver to a PO box — edit the delivery address.", {
        kind: "address",
      });
      return false;
    }
    if (cs.length > 1) {
      showError("Choose one delivery service for the whole order.", { kind: "carrier" });
      return false;
    }
    // Stale dates block only once the live calendar is in: the compiled
    // fallback could disagree with the hub (the server decides otherwise).
    const stale = catalogLoaded ? current.filter((l) => lineDateIssue(l)) : [];
    if (stale.length) {
      setFlagged(stale.map((l) => l.id));
      showError(
        stale.length === 1
          ? "One piñata needs a new delivery date — see the highlighted item."
          : `${stale.length} piñatas need a new delivery date — see the highlighted items.`,
        { kind: "line", id: stale[0].id },
      );
      return false;
    }
    return true;
  };

  const checkout = async () => {
    if (submitting) return;
    setError(null);
    setServerIssues({});
    setFlagged([]);
    setDryRun(null);
    // Re-read storage NOW: a background art upload may have patched the
    // cart since this page mounted, and the "give it a few seconds and try
    // again" retry only works if the retry actually sees the patch.
    const current = loadCart();
    setLines(current);
    if (!current.length || !precheck(current)) return;
    setSubmitting(true);
    const res = await startCheckout({
      lines: current,
      discountCodes: discounts.map((d) => d.code),
      valueCents: totalCents,
    });
    if (res.ok && res.kind === "redirect") {
      // The lines now wait on a pending order; stay "busy" while the browser
      // leaves for Shopify (a back/forward restore resets it — see pageshow).
      window.location.assign(res.invoiceUrl);
      return;
    }
    setSubmitting(false);
    refresh(); // a partial failure may have moved created lines to pending
    if (res.ok) {
      const p = (res.payload ?? {}) as { reason?: unknown; draftOrders?: unknown };
      setDryRun({
        reason: typeof p.reason === "string" ? p.reason : "Checkout ran in test mode.",
        draftOrders: Array.isArray(p.draftOrders) ? p.draftOrders : [],
      });
      setFocusReq((r) => ({ target: { kind: "error" }, n: (r?.n ?? 0) + 1 }));
      return;
    }
    const ids = new Set(current.map((l) => l.id));
    const onLines = (res.lineErrors ?? []).filter((e) => ids.has(e.lineId));
    const elsewhere = (res.lineErrors ?? []).filter((e) => !ids.has(e.lineId));
    if (onLines.length) {
      const issues: Record<string, { code: string; message: string }> = {};
      for (const e of onLines) issues[e.lineId] ??= { code: e.code, message: e.message };
      setServerIssues(issues);
      const n = Object.keys(issues).length;
      showError(
        [
          n === 1
            ? "One piñata needs attention — see the highlighted item."
            : `${n} piñatas need attention — see the highlighted items.`,
          ...elsewhere.map((e) => e.message),
        ].join(" "),
        { kind: "line", id: onLines[0].lineId },
      );
    } else {
      showError(res.error);
    }
  };

  const issueCount = new Set([...flagged, ...Object.keys(serverIssues)]).size;
  const barMessage =
    error && issueCount > 0
      ? `${issueCount} ${plural(issueCount, "piñata needs", "piñatas need")} attention — see above.`
      : error;
  const checkoutFeedback = error ?? dryRun?.reason ?? null;

  return (
    <>
    <div className="cart-grid">
      <div>
        {confirmed.length > 0 && (
          <div className="pending-order">
            <div className="pending-head">
              <strong>Your order is confirmed! 🎉</strong>
            </div>
            <p className="note">
              That piñata&apos;s on its way. Anything below is a separate order
              you haven&apos;t placed yet.
            </p>
          </div>
        )}
        {storageNote}
        {flashNote}
        {pendingCards}
        {pendings.length > 0 && <h2 className="cart-section-h">In your cart</h2>}
        {lines.map((l) => {
          const dateIssue = lineDateIssue(l);
          const serverIssue = serverIssues[l.id];
          const highlighted = !!serverIssue || flagged.includes(l.id);
          const lineCarrier: Carrier = mixedCarriers
            ? l.carrier === "usps"
              ? "usps"
              : "fedex"
            : carrier;
          const ship = lineShipCents(l);
          return (
            <div
              className={"cart-line" + (highlighted ? " has-issue" : "")}
              key={l.id}
              id={`line-${l.id}`}
            >
              <CartBoxThumb line={l} />
              <div className="cart-line-info">
                <strong className="cart-line-title">{lineTitle(l)}</strong>
                <dl className="cart-detail">
                  <div>
                    <dt>Filling</dt>
                    <dd>{l.filling}</dd>
                  </div>
                  {(l.addons ?? []).some((id) => addonById.get(id)?.label) && (
                    <div>
                      <dt>Add-ons</dt>
                      <dd>
                        {(l.addons ?? [])
                          .map((id) => addonById.get(id)?.label)
                          .filter(Boolean)
                          .join(", ")}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Arrives</dt>
                    <dd className={dateIssue === "stale" ? "cart-date-bad" : undefined}>
                      {dateIssue === "missing"
                        ? "No date picked"
                        : lineCarrier === "usps"
                          ? `${formatWindow(uspsWindow(l.deliveryDate, deliveryCfg))} (USPS window)`
                          : formatYmd(l.deliveryDate)}
                    </dd>
                  </div>
                  {l.message && (
                    <div>
                      <dt>Message</dt>
                      <dd className="cart-msg">“{l.message}”</dd>
                    </div>
                  )}
                  {addressComplete(l.address) && (
                    <div className="cart-shipto">
                      <dt>Ships to</dt>
                      <dd>
                        {l.address.name} · {l.address.address1}
                        {l.address.address2 ? `, ${l.address.address2}` : ""},{" "}
                        {l.address.city}, {l.address.province} {l.address.zip}
                      </dd>
                    </div>
                  )}
                </dl>
                {serverIssue ? (
                  <p className="line-issue" id={`issue-${l.id}`} tabIndex={-1}>
                    {serverIssue.message}{" "}
                    {/address/i.test(`${serverIssue.code} ${serverIssue.message}`) ? (
                      <button className="link-btn" onClick={openAddr}>
                        Edit the address
                      </button>
                    ) : (
                      <button className="link-btn" onClick={() => editLine(l)}>
                        Edit this piñata
                      </button>
                    )}
                  </p>
                ) : dateIssue ? (
                  <p className="line-issue" id={`issue-${l.id}`} tabIndex={-1}>
                    {dateIssue === "missing"
                      ? "This piñata needs a delivery date — "
                      : "This date is no longer available — "}
                    <button className="link-btn" onClick={() => editLine(l)}>
                      {dateIssue === "missing" ? "Pick a date" : "Change date"}
                    </button>
                  </p>
                ) : null}
              </div>
              {unitCents !== null && ship !== null && catalogLoaded && (
                <div className="cart-line-price">
                  {formatCents(
                    (unitCents +
                      lineTierCents(l) +
                      lineAddonCents(l) +
                      lineFillingCents(l) +
                      ship) *
                      l.qty,
                  )}
                  <span className="cart-line-price-note">incl. shipping</span>
                </div>
              )}
              <div className="cart-line-actions">
                <button className="btn sm ghost" onClick={() => editLine(l)}>
                  Edit
                </button>
                <div className="qty-stepper" role="group" aria-label="Quantity">
                  <button
                    className="qty-btn"
                    aria-label="Decrease quantity"
                    disabled={l.qty <= 1}
                    onClick={() =>
                      update(
                        lines.map((x) =>
                          x.id === l.id ? { ...x, qty: Math.max(1, x.qty - 1) } : x,
                        ),
                      )
                    }
                  >
                    −
                  </button>
                  <span className="qty" aria-live="polite">
                    {l.qty}
                  </span>
                  <button
                    className="qty-btn"
                    aria-label="Increase quantity"
                    disabled={l.qty >= MAX_QTY}
                    onClick={() =>
                      update(
                        lines.map((x) =>
                          x.id === l.id
                            ? { ...x, qty: Math.min(MAX_QTY, x.qty + 1) }
                            : x,
                        ),
                      )
                    }
                  >
                    +
                  </button>
                </div>
                <button
                  className="link-btn cart-remove"
                  aria-label={`Remove ${lineTitle(l)}`}
                  onClick={() => update(lines.filter((x) => x.id !== l.id))}
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}

        <p>
          <Link className="btn" href="/">
            + Add another piñata
          </Link>
        </p>

        {dryRun && dryRun.draftOrders.some((o) => o.input != null) && (
          <div className="notice info" style={{ overflowX: "auto" }}>
            <strong>Heads up</strong> — {dryRun.reason}
            {dryRun.draftOrders.map((o, i) => (
              <div key={o.groupKey ?? i}>
                <p className="note">
                  Order {i + 1} → {o.shipTo}
                </p>
                {o.input != null && (
                  <pre className="payload-pre">
                    {JSON.stringify(o.input, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <aside className="panel cart-panel">
        <h2>Checkout</h2>

        <div className="ship-to" id="ship-to" tabIndex={-1}>
          <div className="ship-to-head">
            <strong>Ship to</strong>
            {!editingAddr && (
              <button className="link-btn" onClick={openAddr}>
                {shipTo ? "Edit" : "Add address"}
              </button>
            )}
          </div>
          {editingAddr ? (
            <form
              className="addr-edit cart-addr"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                saveAddr();
              }}
            >
              {ADDRESS_FIELDS.map((f) => {
                const id = `cart-addr-${f.key}`;
                const err = addrErrors[f.key];
                const value = editingAddr[f.key];
                const known = f.key === "province" && !!stateCode(value);
                return (
                  <div
                    key={f.key}
                    className={`cart-field f-${f.key}` + (err ? " invalid" : "")}
                  >
                    <label htmlFor={id}>{f.label}</label>
                    {f.key === "province" ? (
                      <select
                        id={id}
                        name={f.key}
                        autoComplete={f.auto}
                        value={value}
                        aria-invalid={!!err}
                        aria-describedby={err ? `${id}-err` : undefined}
                        onChange={(e) => setAddrField(f.key, e.target.value)}
                        onBlur={() => blurAddrField(f.key)}
                      >
                        <option value="">Select…</option>
                        {/* a legacy free-text value we can't map stays
                            selectable rather than silently blanked */}
                        {value && !known && <option value={value}>{value}</option>}
                        {US_STATES.map(([code, name]) => (
                          <option key={code} value={code}>
                            {name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={id}
                        name={f.key}
                        type={f.type ?? "text"}
                        inputMode={f.inputMode}
                        autoComplete={f.auto}
                        maxLength={f.maxLength}
                        value={value}
                        // the form opens on a tap of Edit / Add address
                        autoFocus={f.key === "name"}
                        aria-invalid={!!err}
                        aria-describedby={err ? `${id}-err` : undefined}
                        onChange={(e) => setAddrField(f.key, e.target.value)}
                        onBlur={() => blurAddrField(f.key)}
                      />
                    )}
                    {err && (
                      <p className="cart-field-error" id={`${id}-err`}>
                        {err}
                      </p>
                    )}
                  </div>
                );
              })}
              <div className="row addr-edit-actions">
                <button type="submit" className="btn sm primary">
                  Save address
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    setEditingAddr(null);
                    setAddrErrors({});
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : shipTo ? (
            <p className="note ship-to-addr">
              {shipTo.name}
              <br />
              {shipTo.address1}
              {shipTo.address2 ? `, ${shipTo.address2}` : ""}
              <br />
              {shipTo.city}, {shipTo.province} {shipTo.zip}
            </p>
          ) : (
            <p className="note" style={{ color: "var(--warn)" }}>
              No delivery address yet — add one to check out.
            </p>
          )}
          <p className="note ship-to-hint">
            Everything here ships to one address. Sending to more people? Check
            out, then start the next — or{" "}
            <a href={CORPORATE_URL}>
              send to a whole team with corporate gifting →
            </a>
          </p>
        </div>

        {carrierNotice && (
          <div className="notice info">
            Shipping updated — USPS isn&apos;t offered here, so your order
            ships FedEx 2-Day and arrives on your selected dates.
          </div>
        )}
        {mixedCarriers && (
          <div
            className="notice warn carrier-choice"
            id="carrier-choice"
            tabIndex={-1}
            role="group"
            aria-labelledby="carrier-choice-h"
          >
            <p id="carrier-choice-h">
              Your piñatas are set to different delivery services, and one
              order ships one way. Pick one for everything:
            </p>
            <div className="row">
              <button
                className="btn sm"
                onClick={() =>
                  update(lines.map((l) => ({ ...l, carrier: "fedex" as const })))
                }
              >
                FedEx 2-Day (guaranteed date)
              </button>
              {variant.carriers.includes("usps") && (
                <button
                  className="btn sm"
                  onClick={() =>
                    update(lines.map((l) => ({ ...l, carrier: "usps" as const })))
                  }
                >
                  USPS First Class
                </button>
              )}
            </div>
            <p className="note">We&apos;ll re-check each delivery date for it.</p>
          </div>
        )}
        <div className="price-lines">
          {pricesKnown ? (
            <>
              <div className="row">
                <span>
                  {totalUnits} {plural(totalUnits, "piñata", "piñatas")}
                </span>
                <span>{formatCents(unitCents! * totalUnits + tierTotalCents)}</span>
              </div>
              {extrasTotalCents > 0 && (
                <div className="row">
                  <span>Add-ons &amp; extras</span>
                  <span>{formatCents(extrasTotalCents)}</span>
                </div>
              )}
              {codePreview.map(({ d, off }) =>
                off > 0 ? (
                  <div className="row discount-row" key={d.code}>
                    <span>
                      {d.code}
                      {d.kind === "shipping"
                        ? " (free shipping)"
                        : d.freeShipping
                          ? " (incl. free shipping)"
                          : ""}
                    </span>
                    <span>−{formatCents(off)}</span>
                  </div>
                ) : null,
              )}
              <div className="row">
                <span>{shippingLabel}</span>
                <span>{formatCents(shipTotalCents!)}</span>
              </div>
              <div className="row total">
                <span>Total</span>
                <span>{totalCents !== null ? formatCents(totalCents) : ""}</span>
              </div>
              <p className="note tax-note">
                Taxes calculated at checkout.
              </p>
            </>
          ) : pricesFailed ? (
            <p className="note">
              Prices didn&apos;t load just now — you&apos;ll see your exact total
              at checkout.{" "}
              <button className="link-btn" onClick={loadPrices}>
                Try again
              </button>
            </p>
          ) : (
            <p className="note">Getting prices…</p>
          )}
        </div>

        <div className="discount-field">
          {codePreview.map(({ d, eligible, known }) => (
            <div
              key={d.code}
              className={"discount-applied" + (known && !eligible ? " below" : "")}
            >
              <span>
                {known && !eligible ? "○" : "✓"} <strong>{d.code}</strong>{" "}
                {d.kind === "shipping"
                  ? "free shipping"
                  : (d.type === "percent"
                      ? `${d.value}% off`
                      : `${formatCents(d.value)} off`) +
                    (d.freeShipping ? " + free shipping" : "")}
              </span>
              <button
                className="btn mini ghost"
                onClick={() => removeCode(d.code)}
              >
                Remove
              </button>
            </div>
          ))}
          {deadCodes.map((code) => (
            <div key={code} className="discount-applied below dead">
              <span>
                ✕ <strong>{code}</strong> couldn&apos;t be applied — it may have
                expired or been used up.
              </span>
              <span className="dead-actions">
                <button
                  className="btn mini ghost"
                  onClick={() => retryCode(code)}
                  disabled={checkingCode}
                >
                  Try again
                </button>
                <button className="btn mini ghost" onClick={() => removeCode(code)}>
                  Remove
                </button>
              </span>
            </div>
          ))}
          {codePreview.map(({ d, belowMin, capBlocked }) =>
            belowMin ? (
              <p className="note discount-msg" key={d.code + "-min"}>
                {d.code} needs a {formatCents(d.minSubtotalCents)} minimum — add
                more to use it.
              </p>
            ) : capBlocked ? (
              <p className="note discount-msg" key={d.code + "-cap"}>
                {d.code} only covers shipping under{" "}
                {formatCents(d.maxShippingCents!)} — this order ships for{" "}
                {formatCents(shipTotalCents!)}.
              </p>
            ) : null,
          )}
          {discounts.length < 2 &&
            (codeOpen ? (
              <div className="row discount-entry">
                <input
                  className="in"
                  placeholder={discounts.length ? "Add another code" : "Discount code"}
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyCode()}
                  style={{ textTransform: "uppercase" }}
                  aria-label="Discount code"
                  autoComplete="off"
                  autoFocus
                />
                <button
                  className="btn ghost"
                  onClick={applyCode}
                  disabled={checkingCode || !codeInput.trim()}
                >
                  {checkingCode ? "…" : "Apply"}
                </button>
              </div>
            ) : (
              <button
                className="link-btn discount-toggle"
                aria-expanded={false}
                onClick={() => setCodeOpen(true)}
              >
                {discounts.length ? "Have another code?" : "Have a code?"}
              </button>
            ))}
          {discounts.length === 1 && codeOpen && (
            <p className="note discount-hint">
              An order code and a free-shipping code can stack.
            </p>
          )}
          {discountMsg && <p className="note discount-msg">{discountMsg}</p>}
        </div>

        <button
          className="btn primary block checkout-btn"
          disabled={submitting}
          aria-describedby={checkoutFeedback ? "checkout-feedback" : undefined}
          onClick={checkout}
        >
          {submitting ? "Heading to checkout…" : "Check out"}
        </button>
        {checkoutFeedback && (
          <div
            id="checkout-feedback"
            ref={errorRef}
            tabIndex={-1}
            className={"notice checkout-msg " + (error ? "warn" : "info")}
            // One live announcement: the sticky bar's copy speaks on phones.
            role={narrow ? undefined : error ? "alert" : "status"}
            aria-hidden={narrow ? true : undefined}
          >
            {checkoutFeedback}
          </div>
        )}
        <p className="note secure-note">
          <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12">
            <path
              fill="currentColor"
              d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 1 0-4 0v2Z"
            />
          </svg>
          Secure checkout by Shopify
        </p>
      </aside>
    </div>

    {/* Sticky checkout bar — mobile only: the panel's Check out button sits
        far below the fold, so keep an always-visible one at the bottom, with
        checkout feedback right above it where the shopper is looking. The
        button never waits on display prices — checkout re-prices anyway. */}
    <div className={"mobile-checkout-bar" + (checkoutFeedback ? " has-msg" : "")}>
      {checkoutFeedback && (
        <div
          ref={barErrorRef}
          tabIndex={-1}
          className={"mcb-msg " + (error ? "warn" : "info")}
          role={narrow ? (error ? "alert" : "status") : undefined}
          aria-hidden={narrow ? undefined : true}
        >
          {error ? barMessage : checkoutFeedback}
        </div>
      )}
      <span className="mcb-total">
        {totalCents !== null ? formatCents(totalCents) : pricesFailed ? "" : "…"}
      </span>
      <button className="btn primary" disabled={submitting} onClick={checkout}>
        {submitting ? "Heading out…" : "Check out →"}
      </button>
    </div>
    </>
  );
}
