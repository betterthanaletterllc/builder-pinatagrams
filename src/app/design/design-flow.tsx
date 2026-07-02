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
import {
  deliveryProblem,
  firstAvailableDate,
  maxDeliveryDate,
  minDeliveryDate,
} from "@/lib/delivery";
import EditorShell from "./editor-shell";
import GraphicLibrary from "./graphic-library";
import BoxPreview from "./box-preview";

type StyleInfo = {
  id: string;
  name: string;
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
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
  const [message, setMessage] = useState("");
  const [filling, setFilling] = useState<Filling | null>(null);
  const [date, setDate] = useState(firstAvailableDate());
  const [address, setAddress] = useState<DeliveryAddress>(EMPTY_ADDRESS);
  const [savedAddresses, setSavedAddresses] = useState<DeliveryAddress[]>([]);
  const [cartError, setCartError] = useState(false);

  useEffect(() => {
    setSavedAddresses(loadAddresses());
  }, []);

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
  const railVisible = !choosing && (graphic !== null || step !== "Graphic");

  const selectedSavedKey = addressKey(address);
  const addressOk = addressComplete(address);

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
            <span className="choice-sub">
              Browse our library of ready-made front graphics.
            </span>
          </button>
          <button className="choice-card" onClick={() => setGraphicMode("canvas")}>
            <span className="choice-title">Design a graphic</span>
            <span className="choice-sub">
              Your words and photos, on the box — you make it.
            </span>
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
            bodyStyleId={style.id}
            boxImageUrl={style.boxImageUrl}
            logoZone={style.logoZone}
            onSave={(design, preview) => {
              setGraphic({ type: "custom", design, preview });
            }}
          />
        </div>
      )}

      {step === "Graphic" && graphic && (
        <div className="step-panel">
          <h2>That&apos;s the one?</h2>
          <p className="note">
            {graphic.type === "custom" ? "Your design" : graphic.title}, on
            your {style.name} box.
          </p>
          <div className="el-controls">
            <button className="btn primary" onClick={() => setStep("Message")}>
              Looks good →
            </button>
            <button
              className="btn"
              onClick={() => {
                setGraphic(null);
                setGraphicMode(null);
              }}
            >
              Change graphic
            </button>
          </div>
        </div>
      )}

      {step === "Message" && (
        <div className="step-panel">
          <h2>Add a gift message</h2>
          <p className="note">
            It&apos;s printed on the inside flap — the first thing they read
            when the box opens. Leave blank to skip.
          </p>
          <textarea
            className="message-box"
            maxLength={300}
            rows={5}
            placeholder="Happy birthday! Smash responsibly…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <p className="note">{300 - message.length} characters left</p>
          <button className="btn primary" onClick={() => setStep("Filling")}>
            Continue →
          </button>
        </div>
      )}

      {step === "Filling" && (
        <div className="step-panel">
          <h2>What goes inside?</h2>
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
          <h2>When should it arrive?</h2>
          <input
            type="date"
            className="date-input"
            value={date}
            min={minDeliveryDate()}
            max={maxDeliveryDate()}
            onChange={(e) => setDate(e.target.value)}
          />
          {dateProblem ? (
            <div className="notice warn">{dateProblem}</div>
          ) : (
            <div className="notice info">
              We&apos;ll make it, box it, and get it there by {date}.
            </div>
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
          <h2>Who&apos;s it going to?</h2>
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
    <div>
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

      {railVisible ? (
        <div className="flow-grid">
          {steps}
          <aside className="flow-rail">
            <BoxPreview
              styleName={style.name}
              boxImageUrl={style.boxImageUrl}
              logoZone={style.logoZone}
              artUrl={artUrl}
              message={message}
              filling={filling}
              deliveryDate={
                (step === "Delivery" || step === "Send to") && !dateProblem
                  ? date
                  : null
              }
              mode={step === "Message" ? "open" : "closed"}
              interiorUrl={boxInterior?.interiorUrl}
              messageZone={boxInterior?.messageZone}
            />
          </aside>
        </div>
      ) : (
        steps
      )}
    </div>
  );
}
