"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LogoZone } from "@/lib/hub";
import {
  addressComplete,
  addressKey,
  EMPTY_ADDRESS,
  FILLINGS,
  formatAddress,
  loadAddresses,
  loadCart,
  newLineId,
  rememberAddress,
  saveCart,
  type DeliveryAddress,
  type Filling,
  type GraphicChoice,
} from "@/lib/flow";
import type { DesignDocument } from "@/lib/design-document";
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
  const router = useRouter();
  const [step, setStep] = useState<Step>("Graphic");
  const [graphicMode, setGraphicMode] = useState<"library" | "canvas" | null>(
    null,
  );
  const [graphic, setGraphic] = useState<GraphicChoice | null>(null);
  // Holds the design while re-editing it ("Edit graphic") so the canvas
  // reopens with the photos and text intact.
  const [editingDraft, setEditingDraft] = useState<DesignDocument | null>(null);
  const [message, setMessage] = useState("");
  const [filling, setFilling] = useState<Filling | null>(null);
  // Empty until the customer taps a day — nothing pre-selected.
  const [date, setDate] = useState("");
  const [address, setAddress] = useState<DeliveryAddress>(EMPTY_ADDRESS);
  const [savedAddresses, setSavedAddresses] = useState<DeliveryAddress[]>([]);
  const [cartError, setCartError] = useState(false);

  useEffect(() => {
    setSavedAddresses(loadAddresses());
  }, []);

  // Deep in the library, picking a graphic lands on the next screen — start
  // it at the top, not wherever the last page was scrolled to.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step, graphic, graphicMode]);

  const dateProblem = useMemo(() => deliveryProblem(date), [date]);
  const stepIndex = STEPS.indexOf(step);
  const doneThrough =
    (graphic ? 1 : 0) +
    (stepIndex > 1 ? 1 : 0) +
    (filling ? 1 : 0) +
    (!dateProblem ? 1 : 0);

  const artUrl = graphic
    ? graphic.type === "custom"
      ? graphic.preview
      : (graphic.art ?? graphic.thumb)
    : null;

  const choosing = step === "Graphic" && !graphic && graphicMode !== null;
  // Big box preview only where the box IS the subject (confirm + message).
  // Later steps collapse it into a small "building…" dock at the bottom.
  const docked =
    step === "Filling" || step === "Delivery" || step === "Send to";
  const railVisible =
    !choosing && !docked && (graphic !== null || step !== "Graphic");

  const selectedSavedKey = addressKey(address);
  const addressOk = addressComplete(address);

  // "Step One" is the body-style picker on the landing page.
  const STEP_HEADINGS: Record<Step, string> = {
    Graphic: "Step Two: The graphic",
    Message: "Step Three: Add a gift message",
    Filling: "Step Four: What goes inside?",
    Delivery: "Step Five: Pick the delivery day",
    "Send to": "Step Six: Who's it going to?",
  };
  // Inside the library or canvas the tools need the room — no heading there.
  const showHeading = !choosing;

  const addToCart = () => {
    if (!graphic || !filling || dateProblem || !addressOk) return;
    const lines = loadCart();
    lines.push({
      id: newLineId(),
      styleId: style.id,
      styleName: style.name,
      boxImageUrl: style.boxImageUrl,
      logoZone: style.logoZone,
      graphic,
      message: message.trim(),
      filling,
      deliveryDate: date,
      address,
      qty: 1,
    });
    if (!saveCart(lines)) {
      setCartError(true);
      return;
    }
    rememberAddress(address);
    router.push("/cart");
  };

  const steps = (
    <div>
      {step === "Graphic" && !graphicMode && !graphic && (
        <div className="choice-cards">
          <button className="choice-card" onClick={() => setGraphicMode("library")}>
            <span className="choice-title">Pick a graphic</span>
          </button>
          <button
            className="choice-card"
            onClick={() => {
              setEditingDraft(null);
              setGraphicMode("canvas");
            }}
          >
            <span className="choice-title">Design your own</span>
          </button>
        </div>
      )}

      {step === "Graphic" && graphicMode === "library" && !graphic && (
        <GraphicLibrary
          onBack={() => setGraphicMode(null)}
          onPick={(g) => setGraphic(g)}
        />
      )}

      {step === "Graphic" && graphicMode === "canvas" && !graphic && (
        <div>
          <p className="note">
            <button className="btn mini" onClick={() => setGraphicMode(null)}>
              ← Back
            </button>
          </p>
          <EditorShell
            key={editingDraft ? "edit" : "new"}
            bodyStyleId={style.id}
            boxImageUrl={style.boxImageUrl}
            logoZone={style.logoZone}
            initialDesign={editingDraft}
            onSave={(design, preview) => {
              setGraphic({ type: "custom", design, preview });
              setEditingDraft(null);
            }}
          />
        </div>
      )}

      {step === "Graphic" && graphic && (
        <div className="step-panel">
          <div className="el-controls">
            <button className="btn primary" onClick={() => setStep("Message")}>
              Looks good →
            </button>
            {graphic.type === "custom" && (
              <button
                className="btn"
                onClick={() => {
                  // reopen the SAME design — photos and text intact
                  setEditingDraft(graphic.design);
                  setGraphicMode("canvas");
                  setGraphic(null);
                }}
              >
                Edit graphic
              </button>
            )}
            <button
              className="btn"
              onClick={() => {
                // back to the pick-one / design-one choice
                setEditingDraft(null);
                setGraphicMode(null);
                setGraphic(null);
              }}
            >
              Change graphic
            </button>
          </div>
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
          <button className="btn primary" onClick={() => setStep("Filling")}>
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
            onClick={() => setStep("Delivery")}
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
            onClick={() => setStep("Send to")}
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
            Add to cart →
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
        <span className="chip done">✓ {style.name}</span>
        {STEPS.map((s, i) => (
          <button
            key={s}
            className={
              "chip" +
              (s === step ? " active" : "") +
              (i < stepIndex ? " done" : "")
            }
            onClick={() => i <= Math.max(stepIndex, doneThrough) && setStep(s)}
          >
            {i < stepIndex ? "✓ " : ""}
            {s}
          </button>
        ))}
      </div>

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
              styleName={style.name}
              boxImageUrl={style.boxImageUrl}
              logoZone={style.logoZone}
              artUrl={artUrl}
              message={message}
              filling={filling}
              deliveryDate={null}
              mode={step === "Message" ? "open" : "closed"}
              variant={step === "Message" ? "bare" : "full"}
              interiorUrl={boxInterior?.interiorUrl}
              messageZone={boxInterior?.messageZone}
              pinataSrc={style.cutoutUrl ?? `/pinatas/${style.id}.png`}
              pinataFallback={style.imageUrl}
              pinataZone={style.pinataZone}
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
            {style.boxImageUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={style.boxImageUrl} alt="" className="box-img" />
            ) : null}
            {artUrl && style.logoZone && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={artUrl}
                alt=""
                className="box-art"
                style={{
                  left: `${style.logoZone.x * 100}%`,
                  top: `${style.logoZone.y * 100}%`,
                  width: `${style.logoZone.w * 100}%`,
                  height: `${style.logoZone.h * 100}%`,
                }}
              />
            )}
          </div>
          <div className="dock-info">
            <strong>
              {graphic?.type === "custom"
                ? `Your design — ${style.name}`
                : graphic
                  ? `${graphic.title} — ${style.name}`
                  : style.name}
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
