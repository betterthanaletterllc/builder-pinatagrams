"use client";

import { forwardRef, useEffect, useId, useState } from "react";
import {
  composeMessage,
  FROM_MAX,
  MESSAGE_LIMIT,
  STARTERS,
  type CardParts,
} from "../lib/message";
import { activeOccasions, occasionDef, type OccasionId } from "../lib/occasions";
import { Button } from "../ui/controls";
import { Callout, StepHeader } from "../ui/feedback";
import { TextArea, TextField } from "../ui/field";
import { Sparkle } from "../ui/icons";
import Sheet from "../ui/sheet";
import u from "../ui/ui.module.css";
import s from "./steps.module.css";

/**
 * Step 2 · Card — "Write the card". The message box, the characters left
 * right under it, then an optional From line (printed as "From: Name" under
 * the message). The live preview is the Stage itself (the words on the box's
 * inside flap). The message is required (the flow won't move on without
 * one) and the whole card is held to checkout's 300-character cap: a change
 * that would overflow is refused (with a note) instead of being cut
 * silently at checkout.
 */
const StepCard = forwardRef<
  HTMLHeadingElement,
  {
    parts: CardParts;
    occasion: OccasionId | null;
    onParts: (p: CardParts, opts?: { starter?: boolean }) => void;
    notice: string | null;
    onNotice: (msg: string | null) => void;
    /** Shown on the box when they try to move on with it empty. */
    error?: string | null;
    /** "Need a start?" as a button under the message box that opens the
     *  starters in an overlay (every occasion, theirs first) — instead of
     *  the chips under the form. */
    startersOverlay?: boolean;
  }
>(function StepCard(
  { parts, occasion, onParts, notice, onNotice, error, startersOverlay = false },
  h1Ref,
) {
  const [startersOpen, setStartersOpen] = useState(false);
  const counterId = useId();
  const composed = composeMessage(parts);
  const left = MESSAGE_LIMIT - composed.length;
  const starters = STARTERS[occasion ?? "default"] ?? STARTERS.default;

  // A draft from when there was a To field: fold it into the message, word
  // for word, so nothing hidden prints on the flap.
  const legacyTo = !!parts.to;
  useEffect(() => {
    if (legacyTo) {
      onParts({
        to: "",
        body: composeMessage({ to: parts.to, body: parts.body, from: "" }),
        from: parts.from,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyTo]);

  const change = (field: "body" | "from", value: string) => {
    const next = { ...parts, [field]: value };
    // Deleting is always allowed; growing past the limit is refused whole —
    // a paste that doesn't fit never lands half-cut.
    if (composeMessage(next).length > MESSAGE_LIMIT && value.length > parts[field].length) {
      onNotice(`That won't fit — the card holds ${MESSAGE_LIMIT} characters in all.`);
      return;
    }
    onNotice(null);
    onParts(next);
  };

  const applyStarter = (line: string) => {
    const body = parts.body.trim() ? `${parts.body.replace(/\s+$/, "")}\n${line}` : line;
    const next = { ...parts, body };
    if (composeMessage(next).length > MESSAGE_LIMIT) {
      onNotice("That starter won't fit with what you've written — trim a little first.");
      return;
    }
    onNotice(null);
    onParts(next, { starter: true });
  };

  return (
    <div>
      <StepHeader
        ref={h1Ref}
        index={1}
        title="Write the card"
        sub="Message appears on the inside flap of the box."
      />

      <div className={s.fields}>
        <div>
          <TextArea
            id="pg-message"
            label="Message"
            value={parts.body}
            rows={5}
            error={error}
            // (spread after the field's own ids, so the error id goes in too)
            aria-describedby={[error ? "pg-message-error" : null, counterId]
              .filter(Boolean)
              .join(" ")}
            placeholder="Say something they'll keep."
            onChange={(e) => change("body", e.target.value)}
          />
          <div className={startersOverlay ? s.underBox : undefined}>
            {startersOverlay && (
              <Button
                variant="secondary"
                size="sm"
                aria-haspopup="dialog"
                onClick={() => setStartersOpen(true)}
              >
                <Sparkle size={16} /> Need a start?
              </Button>
            )}
            <p id={counterId} className={s.counter} data-low={left <= 20}>
              {left} character{left === 1 ? "" : "s"} left
            </p>
          </div>
        </div>
        <TextField
          label="From"
          value={parts.from}
          maxLength={FROM_MAX}
          autoComplete="given-name"
          enterKeyHint="done"
          placeholder="Your name"
          onChange={(e) => change("from", e.target.value.replace(/\n/g, " "))}
        />
      </div>

      {notice && (
        <div className={s.block}>
          <Callout tone="warning" role="status">
            {notice}
          </Callout>
        </div>
      )}

      {startersOverlay ? (
        <Sheet
          open={startersOpen}
          onClose={() => setStartersOpen(false)}
          title="Need a start?"
          threeQuarter
        >
          <p className={s.small} style={{ marginTop: 0 }}>
            Tap one to add it to your card. You can edit it after.
          </p>
          {starterGroups(occasion).map((g) => (
            <div key={g.id} className={s.block} role="group" aria-label={g.label}>
              <p className={s.eyebrow}>{g.label}</p>
              <div className={s.starters}>
                {g.lines.map((line) => (
                  <button
                    key={line}
                    type="button"
                    className={`${u.chip} ${s.starter}`}
                    onClick={() => {
                      applyStarter(line);
                      setStartersOpen(false);
                    }}
                  >
                    {line}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </Sheet>
      ) : (
      <div className={s.block} role="group" aria-labelledby={`${counterId}-starters`}>
        <p id={`${counterId}-starters`} className={s.eyebrow}>
          Need a start?
        </p>
        <div className={s.starters}>
          {starters.map((line) => (
            <button
              key={line}
              type="button"
              className={`${u.chip} ${s.starter}`}
              onClick={() => applyStarter(line)}
            >
              {line}
            </button>
          ))}
        </div>
      </div>
      )}
    </div>
  );
});

/** The overlay's starters: the piñata's occasion first, then the other
 *  occasions in season today (each line once). */
function starterGroups(occasion: OccasionId | null): { id: string; label: string; lines: string[] }[] {
  const inSeason = new Set(activeOccasions(new Date()).map((d) => d.id));
  const ids = (Object.keys(STARTERS) as (OccasionId | "default")[]).filter(
    (k): k is OccasionId => k !== "default" && inSeason.has(k),
  );
  const order = occasion ? [occasion, ...ids.filter((id) => id !== occasion)] : ids;
  const seen = new Set<string>();
  const groups: { id: string; label: string; lines: string[] }[] = order.map((id) => ({
    id,
    label: occasionDef(id).label,
    lines: (STARTERS[id] ?? []).filter((l) => !seen.has(l) && !!seen.add(l)),
  }));
  const general = STARTERS.default.filter((l) => !seen.has(l));
  if (general.length) groups.push({ id: "default", label: "Anytime", lines: general });
  return groups.filter((g) => g.lines.length > 0);
}

export default StepCard;
