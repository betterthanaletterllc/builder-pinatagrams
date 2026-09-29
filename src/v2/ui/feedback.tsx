"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { formatCents } from "@/lib/hub";
import { Alert, CheckCircle, Info } from "./icons";
import u from "./ui.module.css";

/* --- Callout: tint + icon + navy text ------------------------------------- */

export function Callout({
  tone = "info",
  children,
  role,
  id,
  style,
}: {
  tone?: "info" | "success" | "error" | "warning";
  children: ReactNode;
  role?: "status" | "alert";
  id?: string;
  style?: CSSProperties;
}) {
  const toneClass =
    tone === "success"
      ? u.success
      : tone === "error"
        ? u.errorTone
        : tone === "warning"
          ? u.warning
          : "";
  const Icon = tone === "success" ? CheckCircle : tone === "info" ? Info : Alert;
  return (
    <div id={id} className={`${u.callout} ${toneClass}`} role={role} style={style}>
      <Icon size={20} />
      <div className={u.calloutBody}>{children}</div>
    </div>
  );
}

/* --- Skeleton --------------------------------------------------------------- */

export function Skeleton({
  width = "100%",
  height = 16,
  radius,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      className={u.skeleton}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/* --- StepHeader: eyebrow + the Arbotek h1 that receives focus ------------- */

export const StepHeader = forwardRef<
  HTMLHeadingElement,
  { index: number; title: string; sub?: ReactNode }
>(function StepHeader({ index, title, sub }, ref) {
  return (
    <header className={u.stepHeader}>
      <p className={u.eyebrow}>Step {index + 1} of 4</p>
      <h1 ref={ref} className={u.stepTitle} tabIndex={-1}>
        {title}
      </h1>
      {sub && <p className={u.stepSub}>{sub}</p>}
    </header>
  );
});

/* --- PriceTag ---------------------------------------------------------------- */

/** "$44.99 delivered" / "From $41.49 delivered" / "—" while unknown. */
export function PriceTag({
  cents,
  from,
  note,
}: {
  cents: number | null;
  from?: boolean;
  note?: string;
}) {
  if (cents === null) {
    return (
      <span className={u.price}>
        <span aria-hidden="true">—</span>
        <span className={u.srOnly}>Price loading</span>
      </span>
    );
  }
  return (
    <span className={u.price}>
      {from && <span className={u.priceFrom}>From </span>}
      {formatCents(cents)}
      {note && <span className={u.priceNote}> {note}</span>}
    </span>
  );
}

/* --- Toast: one polite live region, newest message wins -------------------- */

export function useToast(): { region: ReactNode; show: (msg: string) => void } {
  const [msg, setMsg] = useState<{ text: string; key: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    setMsg({ text, key: Date.now() });
    timer.current = window.setTimeout(() => setMsg(null), 4200);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // The region is ALWAYS in the DOM (empty when idle): a live region that
  // mounts together with its text is often not announced.
  const region = (
    <div className={u.toastRegion} role="status" aria-live="polite">
      {msg && (
        <div className={u.toast} key={msg.key}>
          <CheckCircle size={18} />
          <span>{msg.text}</span>
        </div>
      )}
    </div>
  );
  return { region, show };
}

/* --- Announcer: debounced polite announcements (price changes) ------------- */

export function useAnnouncer(delayMs = 900): {
  region: ReactNode;
  announce: (text: string) => void;
} {
  const [text, setText] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const announce = useCallback(
    (t: string) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setText(t), delayMs);
    },
    [delayMs],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const region = (
    <div className={u.srOnly} aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
  return { region, announce };
}
