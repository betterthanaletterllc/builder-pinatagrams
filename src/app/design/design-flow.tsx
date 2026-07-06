"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  addressComplete,
  addressKey,
  clearDraft,
  EMPTY_ADDRESS,
  FILLINGS,
  formatAddress,
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
  type HubAddon,
  type HubBodyStyle,
  type HubPrice,
  type LogoZone,
} from "@/lib/hub";
import { deliveryProblem, type DeliveryConfig } from "@/lib/delivery";
import { cdnThumb, clearLibraryState } from "@/lib/library-data";
import EditorShell from "./editor-shell";
import GraphicLibrary from "./graphic-library";
import BoxPreview from "./box-preview";
import DateCalendar from "./date-calendar";

type StyleInfo = {
  id: string;
  name: string;
  imageUrl: string | null;
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
  pinataZone: LogoZone | null;
  cutoutUrl: string | null;
};

const STEPS = ["Graphic", "Message", "Filling", "Delivery", "Send to"] as const;
type Step = (typeof STEPS)[number];

const STEP_SLUGS: Record<Step, string> = {
  Graphic: "graphic",
  Message: "message",
  Filling: "filling",
  Delivery: "delivery",
  "Send to": "sendto",
};
const SLUG_TO_STEP = Object.fromEntries(
  Object.entries(STEP_SLUGS).map(([k, v]) => [v, k]),
) as Record<string, Step>;

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
  deliveryCfg,
}: {
  style: StyleInfo;
  boxInterior: { interiorUrl: string | null; messageZone: LogoZone | null } | null;
  addonOptions: HubAddon[];
  deliveryCfg: DeliveryConfig;
}) {
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
  const [date, setDate] = useState("");
  const [address, setAddress] = useState<DeliveryAddress>(EMPTY_ADDRESS);
  const [savedAddresses, setSavedAddresses] = useState<DeliveryAddress[]>([]);
  const [editLineId, setEditLineId] = useState<string | null>(null);
  const [packedFor, setPackedFor] = useState<{
    name: string;
    art: string | null;
  } | null>(null);
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
    () => deliveryProblem(date, deliveryCfg),
    [date, deliveryCfg],
  );

  /* --- step gating: the furthest step the current state supports ---------- */
  const maxStep = useCallback(
    (g: GraphicChoice | null, f: Filling | null, d: string): number => {
      if (!g) return 0; // Graphic
      if (!f) return 2; // through Filling
      if (deliveryProblem(d, deliveryCfg)) return 3; // through Delivery
      return 4; // everything
    },
    [deliveryCfg],
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
    const applyUrl = () => {
      const p = new URLSearchParams(window.location.search);
      const target = SLUG_TO_STEP[p.get("step") ?? "graphic"] ?? "Graphic";
      const idx = Math.min(STEPS.indexOf(target), maxStep(g, f, dt));
      setStepState(STEPS[Math.max(0, idx)]);
      const view = p.get("view");
      setGraphicModeState(
        STEPS[idx] === "Graphic" && (view === "library" || view === "canvas") && !g
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
      const clamped = STEPS[Math.max(0, idx)];
      setStepState(clamped);
      const view = p.get("view");
      setGraphicModeState(
        clamped === "Graphic" && (view === "library" || view === "canvas")
          ? view
          : null,
      );
      setPackedFor(null);
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
  }, [step, graphicMode, packedFor]);

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
      address,
      editLineId,
    });
  }, [hydrated, styleInfo.id, graphic, message, filling, addons, date, address, editLineId]);

  const stepIndex = STEPS.indexOf(step);
  const reachable = maxStep(graphic, filling, date);

  // Previews composite a CDN-resized variant (~60KB), never the print-res
  // original (multi-MB) — that was a visible delay before the graphic
  // appeared on the box. Checkout still sends the full-res URL to Paper.
  const artUrl = graphic
    ? graphic.type === "custom"
      ? graphic.preview
      : cdnThumb(graphic.art ?? graphic.thumb, 720)
    : null;

  // choosing no longer requires !graphic: entering the canvas to EDIT keeps
  // the saved graphic in state, so Back/refresh can't destroy the design.
  const choosing = step === "Graphic" && graphicMode !== null;
  const docked =
    step === "Filling" || step === "Delivery" || step === "Send to";
  const railVisible = !choosing && !docked && !packedFor;
  // The dock shows on EVERY step (not just the docked ones) — inside the
  // library/canvas it would fight the editor's own bottom UI, so not there.
  const dockVisible = !choosing && !packedFor;

  const selectedAddonLabels = addons
    .map((id) => addonOptions.find((a) => a.id === id)?.label)
    .filter(Boolean) as string[];
  const addonCents = addons.reduce(
    (s, id) => s + (addonOptions.find((a) => a.id === id)?.priceCents ?? 0),
    0,
  );
  const deliveredCents = unitPrice
    ? unitPrice.unitPriceCents + addonCents + unitPrice.shipPerUnitCents
    : null;

  const selectedSavedKey = addressKey(address);
  const addressOk = addressComplete(address);

  const STEP_HEADINGS: Record<Step, string> = {
    Graphic: "Step Two: The graphic",
    Message: "Step Three: Add a gift message",
    Filling: "Step Four: What goes inside?",
    Delivery: "Step Five: Pick the delivery day",
    "Send to": "Step Six: Who's it going to?",
  };
  const showHeading = !choosing && !packedFor;

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
    if (!graphic || !filling || dateProblem || !addressOk) return;
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
      // Only keep ids the catalog still offers — a stale draft can't order
      // an add-on that was deactivated while it sat in sessionStorage.
      addons: addons.filter((id) => addonOptions.some((a) => a.id === id)),
      deliveryDate: date,
      address,
      qty: existing ? existing.qty : 1,
    };
    const next = existing
      ? lines.map((l) => (l.id === existing.id ? line : l))
      : [...lines, line];
    if (!saveCart(next)) {
      setCartError(true);
      return;
    }
    rememberAddress(address);
    clearDraft();
    clearLibraryState(); // the next piñata browses the library fresh
    // Show the packed screen, then fully disarm the flow so browser Back
    // can't resurrect a completed order and duplicate the cart line.
    setPackedFor({ name: address.name || styleInfo.name, art: artUrl });
    setGraphic(null);
    setEditingDraft(null);
    setMessage("");
    setFilling(null);
    setAddons([]);
    setDate("");
    setAddress(EMPTY_ADDRESS);
    setEditLineId(null);
    setStepState("Graphic");
    const u = new URL(window.location.href);
    u.searchParams.set("step", "graphic");
    u.searchParams.delete("view");
    u.searchParams.delete("edit");
    window.history.replaceState({}, "", u);
  };

  /* --- packed! ------------------------------------------------------------- */
  if (packedFor) {
    return (
      <div className="flow-root">
        <div className="packed">
          <BoxPreview
            styleName={styleInfo.name}
            boxImageUrl={styleInfo.boxImageUrl}
            logoZone={styleInfo.logoZone}
            artUrl={packedFor.art}
            message=""
            filling={null}
            deliveryDate={null}
            mode="closed"
            variant="bare"
          />
          <h1 className="step-h1">{packedFor.name}&apos;s box is packed! 🎉</h1>
          <div className="el-controls packed-actions">
            <Link className="btn primary" href="/">
              Send another piñata
            </Link>
            <Link className="btn" href="/cart">
              Checkout →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const steps = (
    <div>
      {/* Step Two — the box IS the screen; buttons morph with state */}
      {step === "Graphic" && !choosing && (
        <div className="step-panel">
          {!graphic ? (
            <div className="choice-cards">
              <button className="choice-card" onClick={() => goView("library")}>
                <span className="choice-title">Pick a graphic</span>
              </button>
              <button
                className="choice-card"
                onClick={() => {
                  setEditingDraft(null);
                  goView("canvas");
                }}
              >
                <span className="choice-title">Design your own</span>
              </button>
            </div>
          ) : (
            <>
              {/* swap actions sit snug under the box (where the style name
                  used to read); the primary Looks good follows below */}
              <div className="el-controls confirm-swap">
                {graphic.type === "custom" && (
                  <button
                    className="btn"
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
                    Edit graphic
                  </button>
                )}
                <button
                  className="btn"
                  onClick={() => {
                    // Straight back into the library, which restores the
                    // exact aisle/search/scroll they picked from. `graphic`
                    // stays set so Back/refresh can't lose the choice.
                    setEditingDraft(null);
                    goView("library");
                  }}
                >
                  Change graphic
                </button>
                {graphic.type === "shopify" && (
                  <button
                    className="btn"
                    onClick={() => {
                      setEditingDraft(null);
                      goView("canvas");
                    }}
                  >
                    Design your own
                  </button>
                )}
              </div>
              <div className="el-controls">
                <button
                  className="btn primary"
                  onClick={() => goStep("Message")}
                >
                  Looks good →
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {choosing && graphicMode === "library" && (
        <GraphicLibrary
          onPick={(g) => {
            setGraphic(g);
            goStep("Graphic");
          }}
        />
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
            onSave={(design, preview, assets) => {
              // stamp the CURRENT style — the body may have been swapped
              // while the canvas was open
              setGraphic({
                type: "custom",
                design: { ...design, bodyStyleId: styleInfo.id },
                preview,
                art: assets.art,
                designUrl: assets.designUrl,
              });
              setEditingDraft(null);
              goStep("Graphic");
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
            placeholder="Add a gift message — it prints on the inside flap. Leave blank to skip."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <p className="note msg-from-nudge">
            💡 Don&apos;t forget to say who it&apos;s from!
          </p>
          <button className="btn primary" onClick={() => goStep("Filling")}>
            Continue →
          </button>
        </div>
      )}

      {step === "Filling" && (
        <div className="step-panel">
          <div className="filling-cards">
            {FILLINGS.map((f) => (
              <button
                key={f}
                className={"filling-card" + (filling === f ? " selected" : "")}
                onClick={() => setFilling(f)}
              >
                {f}
              </button>
            ))}
          </div>
          {addonOptions.length > 0 && (
            <div className="addon-list">
              {addonOptions.map((a) => {
                const on = addons.includes(a.id);
                return (
                  <label
                    key={a.id}
                    className={"addon-row" + (on ? " selected" : "")}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setAddons(
                          on
                            ? addons.filter((id) => id !== a.id)
                            : [...addons, a.id],
                        )
                      }
                    />
                    <span className="addon-label">{a.label}</span>
                    <span className="addon-price">
                      +{formatCents(a.priceCents)}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          <button
            className="btn primary"
            disabled={!filling}
            onClick={() => goStep("Delivery")}
          >
            Continue →
          </button>
        </div>
      )}

      {step === "Delivery" && (
        <div className="step-panel">
          <DateCalendar value={date} onChange={setDate} cfg={deliveryCfg} />
          {!date ? (
            <p className="note">
              Tap a day — grayed-out days aren&apos;t available.
            </p>
          ) : dateProblem ? (
            <div className="notice warn">{dateProblem}</div>
          ) : (
            <div className="notice info">Arriving by {date}.</div>
          )}
          <button
            className="btn primary"
            disabled={!!dateProblem}
            onClick={() => goStep("Send to")}
          >
            Continue →
          </button>
        </div>
      )}

      {step === "Send to" && (
        <div className="step-panel">
          <p className="note">
            Each piñata ships to its own person — add another to the cart to
            send somewhere else.
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

          {ADDRESS_FIELDS.map(([key, label]) => (
            <div className="field" key={key}>
              <label htmlFor={`addr-${key}`}>{label}</label>
              <input
                id={`addr-${key}`}
                value={address[key]}
                onChange={(e) =>
                  setAddress((a) => ({ ...a, [key]: e.target.value }))
                }
              />
            </div>
          ))}

          {cartError && (
            <div className="notice warn">
              This design is too large to save — try fewer or smaller photos.
            </div>
          )}
          <button
            className="btn primary"
            disabled={!addressOk || !graphic || !filling || !!dateProblem}
            onClick={addToCart}
          >
            {editLineId ? "Save changes →" : "Add to cart →"}
          </button>
          <p className="note">
            <Link href="/cart">View cart</Link>
          </p>
        </div>
      )}
    </div>
  );

  return (
    <div className={"flow-root" + (choosing ? " wide" : "")}>
      <div className="chips">
        <button className="chip done" onClick={openSwitcher}>
          ✓ {styleInfo.name} ▾
        </button>
        {STEPS.map((s, i) => {
          const unreachable = i > Math.max(stepIndex, reachable);
          return (
            <button
              key={s}
              className={
                "chip" +
                (s === step ? " active" : "") +
                (i < stepIndex ? " done" : "")
              }
              disabled={unreachable}
              aria-disabled={unreachable}
              aria-current={s === step ? "step" : undefined}
              onClick={() => !unreachable && goStep(s)}
            >
              {i < stepIndex ? "✓ " : ""}
              {s}
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
        <h1 className="step-h1" tabIndex={-1}>
          {STEP_HEADINGS[step]}
        </h1>
      )}

      {railVisible ? (
        <div className={"flow-grid" + (dockVisible ? " has-dock" : "")}>
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
              pinataSrc={styleInfo.cutoutUrl ?? `/pinatas/${styleInfo.id}.png`}
              pinataFallback={styleInfo.imageUrl}
              pinataZone={styleInfo.pinataZone}
            />
          </aside>
        </div>
      ) : (
        <div className={dockVisible ? "has-dock" : undefined}>{steps}</div>
      )}

      {dockVisible &&
        (dockOpen ? (
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
                <strong>
                  {graphic?.type === "custom"
                    ? `Your design — ${styleInfo.name}`
                    : graphic
                      ? `${graphic.title} — ${styleInfo.name}`
                      : styleInfo.name}
                </strong>
                <span>
                  {[
                    message
                      ? `“${message.slice(0, 22)}${message.length > 22 ? "…" : ""}”`
                      : null,
                    filling
                      ? filling +
                        (selectedAddonLabels.length
                          ? ` + ${selectedAddonLabels.join(" + ")}`
                          : "")
                      : null,
                    !dateProblem && date && stepIndex >= 3 ? date : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "building…"}
                </span>
              </div>
              {deliveredCents !== null && (
                <div className="dock-price">
                  <strong>{formatCents(deliveredCents)}</strong>
                  <span>delivered</span>
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
                  {formatCents(deliveredCents)} delivered
                </span>
              )}
              <span className="dock-chev" aria-hidden>
                ⌃
              </span>
            </span>
          </button>
        ))}
    </div>
  );
}
