"use client";

import { forwardRef, useId } from "react";
import {
  composeMessage,
  FROM_MAX,
  MESSAGE_LIMIT,
  STARTERS,
  TO_MAX,
  type CardParts,
} from "../lib/message";
import type { OccasionId } from "../lib/occasions";
import { Callout, StepHeader } from "../ui/feedback";
import { TextArea, TextField } from "../ui/field";
import u from "../ui/ui.module.css";
import s from "./steps.module.css";

/**
 * Step 2 · Card — "Write the card". To / Message / From are printed as ONE
 * message (composeMessage) inside the lid, held to checkout's 300-character
 * cap: the counter counts the COMBINED text and a change that would overflow
 * is refused (with a note) instead of being cut silently at checkout. The
 * preview shows the words at a size you can actually read.
 */
const StepCard = forwardRef<
  HTMLHeadingElement,
  {
    parts: CardParts;
    occasion: OccasionId | null;
    onParts: (p: CardParts, opts?: { starter?: boolean }) => void;
    notice: string | null;
    onNotice: (msg: string | null) => void;
  }
>(function StepCard({ parts, occasion, onParts, notice, onNotice }, h1Ref) {
  const counterId = useId();
  const composed = composeMessage(parts);
  const left = MESSAGE_LIMIT - composed.length;
  const starters = STARTERS[occasion ?? "default"] ?? STARTERS.default;

  const change = (field: keyof CardParts, value: string) => {
    const next = { ...parts, [field]: value };
    // Deleting is always allowed; growing past the limit is refused whole —
    // a paste that doesn't fit never lands half-cut.
    if (
      composeMessage(next).length > MESSAGE_LIMIT &&
      value.length > parts[field].length
    ) {
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
        sub="Printed inside the lid — the first thing they read."
      />

      <figure className={s.cardPreview}>
        <p className={s.eyebrow}>Printed inside the lid</p>
        {/* the gift message: masked in session replay */}
        <div className={s.note} aria-live="off" data-ph-mask>
          {composed ? (
            composed
          ) : (
            <span className={s.notePlaceholder}>Your words appear here, just as they’ll print.</span>
          )}
        </div>
        <figcaption className={u.srOnly}>Preview of the printed card</figcaption>
      </figure>

      <div className={s.fields}>
        <TextField
          label="To"
          optional
          value={parts.to}
          maxLength={TO_MAX}
          autoComplete="off"
          enterKeyHint="next"
          onChange={(e) => change("to", e.target.value.replace(/\n/g, " "))}
        />
        <TextArea
          label="Message"
          value={parts.body}
          rows={5}
          aria-describedby={counterId}
          placeholder="Say something they'll keep."
          onChange={(e) => change("body", e.target.value)}
        />
        <p id={counterId} className={s.counter} data-low={left <= 20}>
          {left} character{left === 1 ? "" : "s"} left
        </p>
        <TextField
          label="From"
          optional
          value={parts.from}
          maxLength={FROM_MAX}
          autoComplete="given-name"
          enterKeyHint="done"
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
