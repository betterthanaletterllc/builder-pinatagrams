"use client";

import { forwardRef, useEffect, useId } from "react";
import { composeMessage, MESSAGE_LIMIT, STARTERS, type CardParts } from "../lib/message";
import type { OccasionId } from "../lib/occasions";
import { Callout, StepHeader } from "../ui/feedback";
import { TextArea } from "../ui/field";
import { Pencil } from "../ui/icons";
import u from "../ui/ui.module.css";
import s from "./steps.module.css";

/**
 * Step 2 · Card — "Write the card". One message box; the live preview is
 * the Stage itself (the words on the box's inside flap), so there's no
 * second preview here. A single line reminds them to say who it's from —
 * there are no separate To / From fields. The message is required (the flow
 * won't move on without one) and held to checkout's 300-character cap: a
 * change that would overflow is refused (with a note) instead of being cut
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
  }
>(function StepCard({ parts, occasion, onParts, notice, onNotice, error }, h1Ref) {
  const counterId = useId();
  const hintId = useId();
  const composed = composeMessage(parts);
  const left = MESSAGE_LIMIT - composed.length;
  const starters = STARTERS[occasion ?? "default"] ?? STARTERS.default;

  // A draft from before the To / From fields went away: fold them into the
  // message itself, word for word, so nothing hidden prints on the flap.
  const legacy = !!(parts.to || parts.from);
  useEffect(() => {
    if (legacy) onParts({ to: "", body: composeMessage(parts), from: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacy]);

  const change = (value: string) => {
    const next = { ...parts, body: value };
    // Deleting is always allowed; growing past the limit is refused whole —
    // a paste that doesn't fit never lands half-cut.
    if (composeMessage(next).length > MESSAGE_LIMIT && value.length > parts.body.length) {
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
        <TextArea
          id="pg-message"
          label="Message"
          value={parts.body}
          rows={5}
          error={error}
          // (spread after the field's own ids, so the error id goes in too)
          aria-describedby={[error ? "pg-message-error" : null, hintId, counterId]
            .filter(Boolean)
            .join(" ")}
          placeholder="Say something they'll keep."
          onChange={(e) => change(e.target.value)}
        />
        <div className={s.cardMeta}>
          <p id={hintId} className={s.signHint}>
            <Pencil size={15} /> Don&apos;t forget to say who this is from.
          </p>
          <p id={counterId} className={s.counter} data-low={left <= 20}>
            {left} character{left === 1 ? "" : "s"} left
          </p>
        </div>
      </div>

      {notice && (
        <div className={s.block}>
          <Callout tone="warning" role="status">
            {notice}
          </Callout>
        </div>
      )}

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
    </div>
  );
});

export default StepCard;
