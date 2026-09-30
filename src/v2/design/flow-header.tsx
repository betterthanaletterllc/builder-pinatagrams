"use client";

import Image from "next/image";
import Link from "next/link";
import logo from "../../../public/pinatagrams-logo.png";
import CartButton from "../chrome/cart-button";
import { STEPS } from "../lib/steps";
import { STEP_IDS, type StepId } from "../lib/types";
import { Check, ChevronLeft } from "../ui/icons";
import f from "./flow.module.css";

/**
 * The journey's own header. Phones: back chevron · "Step N of 4 · Name" ·
 * cart, with a 4-segment progress bar. Desktop: logo · a labelled stepper
 * (reachable steps are buttons) · cart. The site header steps aside on
 * /design, so there's never a double header.
 */
export default function FlowHeader({
  step,
  maxReachable,
  backLabel,
  onBack,
  onStep,
  onCart,
  cartExtra,
  reviewOnly,
}: {
  step: StepId;
  /** Highest step index the current draft can open. */
  maxReachable: number;
  backLabel: string;
  onBack: () => void;
  onStep: (s: StepId) => void;
  onCart: () => void;
  /** added to the cart badge: the piñata in progress, when it counts */
  cartExtra?: number;
  /** Order review with no piñata in progress: only Step 4 exists. */
  reviewOnly: boolean;
}) {
  const idx = STEPS[step].index;
  return (
    <header className={f.header}>
      <div className={f.hMobile}>
        <button type="button" className={f.iconBtn} onClick={onBack} aria-label={backLabel}>
          <ChevronLeft size={24} />
        </button>
        <p className={f.hTitle} style={{ margin: 0 }}>
          <span className={f.hEyebrow}>
            {reviewOnly ? "Your order" : `Step ${idx + 1} of 4`}
          </span>
          <span className={f.hName}>{STEPS[step].name}</span>
        </p>
        <CartButton onClick={onCart} extra={cartExtra} />
      </div>
      <div className={f.progress} aria-hidden="true">
        {STEP_IDS.map((id, i) => (
          <span key={id} data-on={i <= idx} />
        ))}
      </div>

      <div className={f.hDesktop}>
        <Link href="/" className={f.logoLink}>
          <Image src={logo} alt="Piñatagrams home" className={f.logo} sizes="90px" />
        </Link>
        <nav className={f.stepper} aria-label="Steps">
          <ol>
            {STEP_IDS.map((id, i) => {
              const done = !reviewOnly && i < idx;
              const reachable = reviewOnly ? i === idx : i <= maxReachable;
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={f.stepBtn}
                    aria-current={id === step ? "step" : undefined}
                    data-done={done}
                    disabled={!reachable}
                    onClick={() => id !== step && onStep(id)}
                  >
                    <span className={f.stepNum} aria-hidden="true">
                      {done ? <Check size={13} /> : i + 1}
                    </span>
                    {STEPS[id].name}
                    {done && <span className={f.srOnly}> (done)</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <CartButton onClick={onCart} extra={cartExtra} />
      </div>
    </header>
  );
}
