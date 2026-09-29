"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useRef, useState } from "react";
import DateCalendar from "@/app/design/date-calendar";
import { formatWindow, uspsWindow, type Carrier, type DeliveryConfig } from "@/lib/delivery";
import type { CartLine, GraphicChoice } from "@/lib/flow";
import type { HubBodyStyle, HubGraphicCategory, HubGraphicEntry } from "@/lib/hub";
import { cdnThumb } from "@/lib/library-data";
import { dateProblemText } from "../lib/dates";
import { bodyGroup } from "../lib/defaults";
import { PINATA_HEIGHT_IN } from "../lib/text";
import { Button } from "../ui/controls";
import { Callout, Skeleton } from "../ui/feedback";
import { Check } from "../ui/icons";
import Sheet from "../ui/sheet";
import s from "./steps.module.css";

// The full library is its own chunk (and fetches graphics.json itself):
// loaded when the sheet opens — or on hover/focus of "See all" — never with
// the page.
export const loadLibrary = () => import("@/app/design/graphic-library");
const GraphicLibrary = dynamic(loadLibrary, {
  ssr: false,
  loading: () => (
    <div aria-busy="true" style={{ display: "grid", gap: 12 }}>
      <Skeleton height={48} />
      <Skeleton height={140} />
      <Skeleton height={140} />
    </div>
  ),
});

/* --- Body style ------------------------------------------------------------------ */

export function BodySheet({
  open,
  onClose,
  styles,
  current,
  wearable,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  styles: HubBodyStyle[];
  current: string;
  wearable: (styleId: string) => boolean;
  onPick: (s: HubBodyStyle) => void;
}) {
  // A tap picks and closes; arrow keys only move the selection (closing on
  // every arrow press would make the list unbrowsable by keyboard) — "Done"
  // or Esc closes.
  const viaPointer = useRef(false);
  const groups = [
    { id: "everyday", label: "Everyday", items: styles.filter((b) => bodyGroup(b.id) === "everyday") },
    {
      id: "occasions",
      label: "Occasions & seasons",
      items: styles.filter((b) => bodyGroup(b.id) === "occasions"),
    },
  ].filter((g) => g.items.length > 0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Choose your piñata"
      footer={
        <Button block onClick={onClose}>
          Done
        </Button>
      }
    >
      <div
        onPointerDown={() => {
          viaPointer.current = true;
        }}
        onKeyDown={() => {
          viaPointer.current = false;
        }}
      >
      <p className={s.small} style={{ margin: "0 0 12px" }}>
        Every piñata is {PINATA_HEIGHT_IN} inches tall.
      </p>
      {groups.map((g) => (
        <fieldset key={g.id} className={`${s.sheetGroup} ${s.legendReset}`}>
          <legend className={s.eyebrow}>{g.label}</legend>
          <div className={s.bodyGrid}>
            {g.items.map((b) => {
              const ok = wearable(b.id);
              return (
                <label
                  key={b.id}
                  className={s.bodyOption}
                  data-selected={b.id === current}
                  data-disabled={!ok || undefined}
                >
                  <input
                    type="radio"
                    name="pg-body"
                    className={s.srOnly}
                    checked={b.id === current}
                    disabled={!ok}
                    onChange={() => {
                      onPick(b);
                      if (viaPointer.current) onClose();
                    }}
                  />
                  <span className={s.bodyArt}>
                    <Image
                      src={b.cutoutUrl ?? `/pinatas/${b.id}.png`}
                      alt=""
                      width={400}
                      height={400}
                      sizes="(min-width: 768px) 120px, 30vw"
                    />
                  </span>
                  <span>{b.name}</span>
                  {!ok && <span className={s.small}>Not offered with this design</span>}
                  <span className={s.tileCheck} aria-hidden="true">
                    <Check size={12} />
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      </div>
    </Sheet>
  );
}

/* --- Zoom -------------------------------------------------------------------------- */

export function ZoomSheet({
  open,
  onClose,
  graphic,
  name,
}: {
  open: boolean;
  onClose: () => void;
  graphic: GraphicChoice | null;
  name: string;
}) {
  const art = !graphic
    ? null
    : graphic.type === "custom"
      ? graphic.preview
      : graphic.type === "hub"
        ? (graphic.thumb ?? graphic.art)
        : cdnThumb(graphic.art ?? graphic.thumb, 1400);
  return (
    <Sheet open={open} onClose={onClose} title="Your label, up close">
      {art && (
        <div className={`${s.zoomArt}${graphic?.type === "custom" ? " ph-no-capture" : ""}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={art} alt={name} width={1400} height={683} />
        </div>
      )}
      <p className={s.zoomCaption}>Printed label · 8 × 3.9 in, on the front of the box</p>
    </Sheet>
  );
}

/* --- Library --------------------------------------------------------------------- */

export function LibrarySheet({
  open,
  onClose,
  restrict,
  hubGraphics,
  hubCategories,
  styleId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  restrict: "birthday" | "none" | null;
  hubGraphics: HubGraphicEntry[];
  hubCategories: HubGraphicCategory[];
  styleId: string;
  onPick: (g: GraphicChoice) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="All designs" wide>
      <div className={s.library}>
        <GraphicLibrary
          restrict={restrict}
          hubGraphics={hubGraphics}
          hubCategories={hubCategories}
          styleId={styleId}
          onPick={onPick}
        />
      </div>
    </Sheet>
  );
}

/* --- Price breakdown ---------------------------------------------------------------- */

export type BreakdownRow = { label: string; value: string };

export function PriceSheet({
  open,
  onClose,
  rows,
  total,
  note,
}: {
  open: boolean;
  onClose: () => void;
  rows: BreakdownRow[];
  total: BreakdownRow;
  note?: string | null;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="What you're paying for">
      <dl style={{ margin: 0 }}>
        {rows.map((r) => (
          <div key={r.label} className={s.kv}>
            <dt>{r.label}</dt>
            <dd style={{ margin: 0 }}>{r.value}</dd>
          </div>
        ))}
        <div className={`${s.kv} ${s.total}`}>
          <dt>{total.label}</dt>
          <dd style={{ margin: 0 }}>{total.value}</dd>
        </div>
      </dl>
      <p className={s.tax}>Tax is added at payment.</p>
      {note && <p className={s.small}>{note}</p>}
    </Sheet>
  );
}

/* --- A cart line's date (carrier switches, stale dates) ------------------------------ */

export function LineDateSheet({
  open,
  onClose,
  line,
  title,
  carrier,
  cfg,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  line: CartLine | null;
  title: string;
  carrier: Carrier;
  cfg: DeliveryConfig;
  onPick: (ymd: string) => void;
}) {
  const [value, setValue] = useState(line?.deliveryDate ?? "");
  const problem = value ? dateProblemText(value, cfg, carrier) : "Pick a day on the calendar.";
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New delivery date"
      footer={
        <Button block onClick={() => !problem && onPick(value)} aria-disabled={!!problem || undefined}>
          Use this date
        </Button>
      }
    >
      <p className={s.small} style={{ marginTop: 0 }}>
        {title}
      </p>
      <div className={s.calendar}>
        <DateCalendar key={carrier} value={value} onChange={setValue} cfg={cfg} carrier={carrier} />
      </div>
      {carrier === "usps" && value && !problem && (
        <p className={s.assure} data-tone="window">
          Usually arrives {formatWindow(uspsWindow(value, cfg))}.
        </p>
      )}
      {problem && value && (
        <div style={{ marginTop: 12 }}>
          <Callout tone="error">{problem}</Callout>
        </div>
      )}
    </Sheet>
  );
}
