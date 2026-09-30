"use client";

import { forwardRef, useEffect, useId } from "react";
import {
  composeMessage,
  FROM_MAX,
  MESSAGE_LIMIT,
  STARTERS,
  type CardParts,
} from "../lib/message";
import type { OccasionId } from "../lib/occasions";
import { Callout, StepHeader } from "../ui/feedback";
import { TextArea, TextField } from "../ui/field";
import u from "../ui/ui.module.css";
import s from "./steps.module.css";

/**
 * Step 2 · Card — "Write the card". The message box, the characters left
 * right under it, then an optional From line (printed as "— Name" under the
 * message). The live preview is the Stage itself (the words on the box's
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
  }
>(function StepCard({ parts, occasion, onParts, notice, onNotice, error }, h1Ref) {
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
          <p id={counterId} className={s.counter} data-low={left <= 20}>
            {left} character{left === 1 ? "" : "s"} left
          </p>
        </div>
        <TextField
          label="From"
          optional
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
