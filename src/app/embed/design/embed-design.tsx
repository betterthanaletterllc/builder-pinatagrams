"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  designKey,
  isCurrentDesign,
  type DesignDocument,
} from "@/lib/design-document";
import {
  designSaveState,
  designSavesVersion,
  saveDesignArt,
  subscribeDesignSaves,
} from "@/lib/design-upload";
import { embedDesignMessage, embedMessage, readInit } from "@/lib/embed";
import type { DesignAssets, GraphicChoice } from "@/lib/flow";
import type { HubBodyStyle } from "@/lib/hub";
import EditorView from "@/v2/design/editor-view";
import { Button } from "@/v2/ui/controls";
import { Callout, Skeleton } from "@/v2/ui/feedback";
import e from "./embed.module.css";

/**
 * The editor, framed inside Paper (lib/embed). It is the journey's own
 * "Make your own" view (EditorView → the shared editor), so whatever the
 * editor does for shoppers it does here. Only the edges differ:
 *
 *  - it asks the page that framed it what to open (a design made before, or
 *    a blank label) instead of reading a cart;
 *  - "Use this design" stages the print file exactly as for an order, then
 *    tells that page where it is instead of moving on to the gift message;
 *  - ✕ asks that page to close the designer.
 *
 * Opened on its own (no frame) it still works, so it can be looked at — the
 * design just isn't sent anywhere.
 */

/** How long to wait for the framing page to say what to open before
 *  starting a blank label anyway. It answers at once for a new label; for a
 *  design made before it first has to fetch it (a few MB with photos), so
 *  the wait is generous — a blank label over someone's design is the worse
 *  mistake. */
const INIT_WAIT_MS = 10_000;

type Saved = {
  design: DesignDocument;
  preview: string;
  art: string;
  artSha256: string;
  designUrl: string | null;
};

type Phase =
  | { at: "waiting" }
  | { at: "editing"; graphic: GraphicChoice | null; retry: boolean }
  | { at: "saving"; design: DesignDocument; preview: string }
  | ({ at: "sent" } & Saved);

function customGraphic(
  design: DesignDocument,
  preview = "",
  assets?: Pick<Saved, "art" | "artSha256" | "designUrl">,
): GraphicChoice {
  return {
    type: "custom",
    design,
    preview,
    art: assets?.art ?? null,
    designUrl: assets?.designUrl ?? null,
    artSha256: assets?.artSha256 ?? null,
  };
}

export default function EmbedDesign({
  style,
  parents,
}: {
  style: HubBodyStyle;
  /** The origins allowed to frame this page and to talk to it. */
  parents: string[];
}) {
  const [phase, setPhase] = useState<Phase>({ at: "waiting" });
  const [framed, setFramed] = useState(true);
  // The framing page's origin, once it has spoken.
  const parentOrigin = useRef<string | null>(null);
  // The design whose print file is uploading (the editor reports the
  // finished upload with the document's JSON, so they can be matched).
  const saving = useRef<{ design: DesignDocument; preview: string; docJson: string } | null>(
    null,
  );
  // Re-render when a print upload changes state (saving / failed / saved).
  useSyncExternalStore(subscribeDesignSaves, designSavesVersion, () => 0);

  const post = useCallback(
    (message: unknown) => {
      if (window.parent === window) return;
      // A message addressed to an origin the parent isn't is simply not
      // delivered, so before the parent has spoken it goes to each of them.
      const targets = parentOrigin.current ? [parentOrigin.current] : parents;
      for (const origin of targets) window.parent.postMessage(message, origin);
    },
    [parents],
  );

  useEffect(() => {
    if (window.parent === window) {
      setFramed(false);
      setPhase((p) => (p.at === "waiting" ? { at: "editing", graphic: null, retry: false } : p));
      return;
    }
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window.parent) return;
      const init = readInit(ev.origin, ev.data, parents);
      if (!init) return;
      parentOrigin.current = ev.origin;
      const design = isCurrentDesign(init.design) ? init.design : null;
      // Only the first answer opens the editor: a later one must never
      // replace a label someone is working on.
      setPhase((p) =>
        p.at === "waiting"
          ? { at: "editing", graphic: design ? customGraphic(design) : null, retry: false }
          : p,
      );
    };
    window.addEventListener("message", onMessage);
    for (const origin of parents) window.parent.postMessage(embedMessage("ready"), origin);
    const timer = window.setTimeout(
      () =>
        setPhase((p) => (p.at === "waiting" ? { at: "editing", graphic: null, retry: false } : p)),
      INIT_WAIT_MS,
    );
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
  }, [parents]);

  const finish = useCallback(
    (design: DesignDocument, preview: string, assets: DesignAssets) => {
      if (!assets.art || !assets.artSha256) return;
      post(
        embedDesignMessage({
          artUrl: assets.art,
          sha256: assets.artSha256,
          designUrl: assets.designUrl,
          preview,
        }),
      );
      setPhase({
        at: "sent",
        design,
        preview,
        art: assets.art,
        artSha256: assets.artSha256,
        designUrl: assets.designUrl,
      });
    },
    [post],
  );

  // "Use this design": the editor hands over the document at once and stages
  // the print file in the background — unless nothing changed since the file
  // was last staged, in which case it hands that one straight back.
  const onSave = useCallback(
    (design: DesignDocument, preview: string, assets: DesignAssets) => {
      if (assets.art && assets.artSha256) {
        saving.current = null;
        finish(design, preview, assets);
        return;
      }
      saving.current = { design, preview, docJson: JSON.stringify(design) };
      setPhase({ at: "saving", design, preview });
    },
    [finish],
  );

  // The print file is staged (also after a retry).
  const onAssets = useCallback(
    (assets: DesignAssets, docJson: string) => {
      const s = saving.current;
      if (!s || s.docJson !== docJson) return; // an older design's upload
      saving.current = null;
      finish(s.design, s.preview, assets);
    },
    [finish],
  );

  const onClose = useCallback(() => post(embedMessage("close")), [post]);

  if (phase.at === "waiting") {
    return (
      <main className={e.page}>
        <div className={e.panel} aria-busy="true">
          <Skeleton height={44} />
          <Skeleton height={260} />
        </div>
      </main>
    );
  }

  if (phase.at === "editing") {
    return (
      <main className={e.page}>
        {!framed && (
          <div className={e.panel}>
            <Callout tone="info">
              This is the label designer staff open from Paper when they make a sample. Opened on
              its own it works the same, but the finished design isn&apos;t sent anywhere.
            </Callout>
          </div>
        )}
        <EditorView
          style={style}
          graphic={phase.graphic}
          retry={phase.retry}
          onClose={onClose}
          onSave={onSave}
          onAssets={onAssets}
        />
      </main>
    );
  }

  if (phase.at === "saving") {
    const failed = designSaveState(designKey(phase.design))?.status === "failed";
    return (
      <main className={e.page}>
        <div className={e.panel}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={e.preview} src={phase.preview} alt="Your label" />
          {failed ? (
            <>
              <Callout tone="error" role="alert">
                The design didn&apos;t finish saving. Check the connection and try again — nothing
                you made is lost.
              </Callout>
              <div className={e.actions}>
                <Button onClick={() => void saveDesignArt(phase.design)}>Try again</Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setPhase({
                      at: "editing",
                      graphic: customGraphic(phase.design, phase.preview),
                      retry: true,
                    })
                  }
                >
                  Back to the design
                </Button>
              </div>
            </>
          ) : (
            <p className={e.status} role="status">
              <span className="mini-spinner" aria-hidden /> Saving your design at print size…
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className={e.page}>
      <div className={e.panel}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={e.preview} src={phase.preview} alt="Your label" />
        {framed ? (
          <Callout tone="success" role="status">
            Sent to Paper, which keeps its own copy of the print file. To work on it some more —
            or to send it again — press &ldquo;Change this design&rdquo;.
          </Callout>
        ) : (
          <Callout tone="info" role="status">
            The print file is made. Nothing was sent anywhere, because this page isn&apos;t open
            inside Paper.
          </Callout>
        )}
        <div className={e.actions}>
          <Button
            variant="secondary"
            onClick={() =>
              setPhase({
                at: "editing",
                graphic: customGraphic(phase.design, phase.preview, phase),
                retry: false,
              })
            }
          >
            Change this design
          </Button>
        </div>
      </div>
    </main>
  );
}
