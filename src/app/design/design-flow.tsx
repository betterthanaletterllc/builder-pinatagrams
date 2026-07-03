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
import type { DesignDocument } from "@/lib/design-document";
import { HUB_URL, type HubBodyStyle, type LogoZone } from "@/lib/hub";
import { deliveryProblem } from "@/lib/delivery";
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
}: {
  style: StyleInfo;
  boxInterior: { interiorUrl: string | null; messageZone: LogoZone | null } | null;
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
  const [date, setDate] = useState("");
  const [address, setAddress] = useState<DeliveryAddress>(EMPTY_ADDRESS);
  const [savedAddresses, setSavedAddresses] = useState<DeliveryAddress[]>([]);
  const [editLineId, setEditLineId] = useState<string | null>(null);
  const [packedFor, setPackedFor] = useState<string | null>(null);
  const [cartError, setCartError] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherStyles, setSwitcherStyles] = useState<HubBodyStyle[] | null>(null);
  // STATE, not a ref: the persist effect must not run until the commit AFTER
  // the restore lands, or it clobbers the stored draft with empty state.
  const [hydrated, setHydrated] = useState(false);

  const dateProblem = useMemo(() => deliveryProblem(date), [date]);

  /* --- step gating: the furthest step the current state supports ---------- */
  const maxStep = useCallback(
    (g: GraphicChoice | null, f: Filling | null, d: string): number => {
      if (!g) return 0; // Graphic
      if (!f) return 2; // through Filling
      if (deliveryProblem(d)) return 3; // through Delivery
      return 4; // everything
    },
    [],
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
    const d = loadDraft();
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
      // re-derive gating from the CURRENT state via a fresh draft read (state
      // not in scope here) — clamp generously: allow any step, the render
      // guards handle missing data gracefully.
      const p = new URLSearchParams(window.location.search);
      const target = SLUG_TO_STEP[p.get("step") ?? "graphic"] ?? "Graphic";
      setStepState(target);
      const view = p.get("view");
      setGraphicModeState(
        target === "Graphic" && (view === "library" || view === "canvas")
          ? view
          : null,
      );
      setPackedFor(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the draft on every meaningful change (only once hydrated —
  // never on the initial commit, which still holds empty state).
  useEffect(() => {
    if (!hydrated) return;
    saveDraft({
      styleId: styleInfo.id,
      graphic,
      message,
      filling,
      date,
      address,
      editLineId,
    });
  }, [hydrated, styleInfo.id, graphic, message, filling, date, address, editLineId]);

  const stepIndex = STEPS.indexOf(step);
  const reachable = maxStep(graphic, filling, date);

  const artUrl = graphic
    ? graphic.type === "custom"
      ? graphic.preview
      : (graphic.art ?? graphic.thumb)
    : null;

  const choosing = step === "Graphic" && !graphic && graphicMode !== null;
  const docked =
    step === "Filling" || step === "Delivery" || step === "Send to";
  const railVisible = !choosing && !docked && !packedFor;

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
    const line = {
      id: editLineId ?? newLineId(),
      styleId: styleInfo.id,
      styleName: styleInfo.name,
      boxImageUrl: styleInfo.boxImageUrl,
      logoZone: styleInfo.logoZone,
      graphic,
      message: message.trim(),
      filling,
      deliveryDate: date,
      address,
      qty: 1,
    };
    const lines = loadCart();
    const next = editLineId
      ? lines.map((l) => (l.id === editLineId ? { ...line, qty: l.qty } : l))
      : [...lines, line];
    if (!saveCart(next)) {
      setCartError(true);
      return;
    }
    rememberAddress(address);
    clearDraft();
    setPackedFor(address.name || styleInfo.name);
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
            artUrl={artUrl}
            message=""
            filling={null}
            deliveryDate={null}
            mode="closed"
            variant="bare"
          />
          <h1 className="step-h1">{packedFor}&apos;s box is packed! 🎉</h1>
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
            <div className="el-controls">
              <button className="btn primary" onClick={() => goStep("Message")}>
                Looks good →
              </button>
              {graphic.type === "custom" && (
                <button
                  className="btn"
                  onClick={() => {
                    setEditingDraft(graphic.design);
                    setGraphic(null);
                    goView("canvas");
                  }}
                >
                  Edit graphic
                </button>
              )}
              <button
                className="btn"
                onClick={() => {
                  setEditingDraft(null);
                  setGraphic(null);
                }}
              >
                Change graphic
              </button>
            </div>
          )}
        </div>
      )}

      {choosing && graphicMode === "library" && (
        <GraphicLibrary
          onBack={() => window.history.back()}
          onPick={(g) => {
            setGraphic(g);
            goStep("Graphic");
          }}
        />
      )}

      {choosing && graphicMode === "canvas" && (
        <div>
          <p className="note">
            <button className="btn mini" onClick={() => window.history.back()}>
              ← Back
            </button>
          </p>
          <EditorShell
            key={editingDraft ? "edit" : "new"}
            bodyStyleId={styleInfo.id}
            boxImageUrl={styleInfo.boxImageUrl}
            logoZone={styleInfo.logoZone}
            initialDesign={editingDraft}
            onSave={(design, preview) => {
              setGraphic({ type: "custom", design, preview });
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
          <DateCalendar value={date} onChange={setDate} />
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
        {STEPS.map((s, i) => (
          <button
            key={s}
            className={
              "chip" +
              (s === step ? " active" : "") +
              (i < stepIndex ? " done" : "")
            }
            onClick={() => i <= Math.max(stepIndex, reachable) && goStep(s)}
          >
            {i < stepIndex ? "✓ " : ""}
            {s}
          </button>
        ))}
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

      {showHeading && <h1 className="step-h1">{STEP_HEADINGS[step]}</h1>}

      {railVisible ? (
        <div className="flow-grid">
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
              variant={step === "Message" ? "bare" : "full"}
              interiorUrl={boxInterior?.interiorUrl}
              messageZone={boxInterior?.messageZone}
              pinataSrc={styleInfo.cutoutUrl ?? `/pinatas/${styleInfo.id}.png`}
              pinataFallback={styleInfo.imageUrl}
              pinataZone={styleInfo.pinataZone}
            />
          </aside>
        </div>
      ) : (
        <div className={docked ? "has-dock" : undefined}>{steps}</div>
      )}

      {docked && (
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
                  filling,
                  !dateProblem && date && stepIndex >= 3 ? date : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "building…"}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
