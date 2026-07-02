"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LogoZone } from "@/lib/hub";
import {
  FILLINGS,
  loadCart,
  newLineId,
  saveCart,
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

type StyleInfo = {
  id: string;
  name: string;
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
};

const STEPS = ["Graphic", "Message", "Filling", "Delivery"] as const;
type Step = (typeof STEPS)[number];

export default function DesignFlow({ style }: { style: StyleInfo }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("Graphic");
  const [graphicMode, setGraphicMode] = useState<"library" | "canvas" | null>(
    null,
  );
  const [graphic, setGraphic] = useState<GraphicChoice | null>(null);
  const [message, setMessage] = useState("");
  const [filling, setFilling] = useState<Filling | null>(null);
  const [date, setDate] = useState(firstAvailableDate());
  const [cartError, setCartError] = useState(false);

  const dateProblem = useMemo(() => deliveryProblem(date), [date]);
  const stepIndex = STEPS.indexOf(step);
  const doneThrough =
    (graphic ? 1 : 0) + (stepIndex > 1 ? 1 : 0) + (filling ? 1 : 0);

  const addToCart = () => {
    if (!graphic || !filling || dateProblem) return;
    const lines = loadCart();
    lines.push({
      id: newLineId(),
      styleId: style.id,
      styleName: style.name,
      graphic,
      message: message.trim(),
      filling,
      deliveryDate: date,
      qty: 1,
    });
    if (!saveCart(lines)) {
      setCartError(true);
      return;
    }
    router.push("/cart");
  };

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
          onPick={(g) => {
            setGraphic(g);
            setStep("Message");
          }}
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
              setStep("Message");
            }}
          />
        </div>
      )}

      {step === "Graphic" && graphic && (
        <div className="step-panel">
          <div className="picked-graphic">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={
                graphic.type === "custom"
                  ? graphic.preview
                  : (graphic.thumb ?? "")
              }
              alt="chosen graphic"
            />
            <div>
              <strong>
                {graphic.type === "custom" ? "Your design" : graphic.title}
              </strong>
              <p className="note">
                <button
                  className="btn mini"
                  onClick={() => {
                    setGraphic(null);
                    setGraphicMode(null);
                  }}
                >
                  Change graphic
                </button>
              </p>
            </div>
          </div>
          <button className="btn primary" onClick={() => setStep("Message")}>
            Continue →
          </button>
        </div>
      )}

      {step === "Message" && (
        <div className="step-panel">
          <h2>Add a gift message</h2>
          <p className="note">
            Printed on a card that ships inside the box — the first thing they
            read when they open it. Leave it blank to skip.
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
          {cartError && (
            <div className="notice warn">
              This design is too large to save — try fewer or smaller photos.
            </div>
          )}
          <button
            className="btn primary"
            disabled={!!dateProblem || !graphic || !filling}
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
}
