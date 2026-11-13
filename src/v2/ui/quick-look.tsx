"use client";

import { Button } from "./controls";
import Sheet from "./sheet";
import q from "./quick-look.module.css";

/**
 * Press-and-hold on a design → this: the label art big enough to read
 * (script lettering is a smudge at tile size on a phone), with the one
 * action that matters. Opened from the step 1 grid and from the library.
 */
export default function QuickLook({
  art,
  name,
  selected = false,
  onUse,
  onClose,
}: {
  /** The art at a reading size (≈1400px wide), or null when closed. */
  art: string | null;
  name: string;
  /** Already the design on the box: the action just closes. */
  selected?: boolean;
  onUse: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={!!art}
      onClose={onClose}
      title="Up close"
      tall
      footer={
        <div className={q.actions}>
          <Button block onClick={selected ? onClose : onUse}>
            {selected ? "This one's on your box" : "Use this design"}
          </Button>
          <Button block variant="secondary" onClick={onClose}>
            Keep looking
          </Button>
        </div>
      }
    >
      {art && (
        <figure className={q.figure}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={art} alt={name} width={1400} height={683} className={q.art} />
          <figcaption className={q.caption}>Printed label · 8 × 3.9 in, on the front of the box</figcaption>
        </figure>
      )}
    </Sheet>
  );
}
