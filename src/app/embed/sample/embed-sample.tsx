"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { designKey, type DesignDocument } from "@/lib/design-document";
import {
  designSaveState,
  designSavesVersion,
  saveDesignArt,
  subscribeDesignSaves,
} from "@/lib/design-upload";
import {
  embedChoiceMessage,
  embedGraphicFor,
  embedMessage,
  readInit,
} from "@/lib/embed";
import type { DesignAssets, GraphicChoice } from "@/lib/flow";
import type {
  BuilderPricing,
  HubBodyStyle,
  HubGraphicCategory,
  HubGraphicEntry,
} from "@/lib/hub";
import ActionBar from "@/v2/design/action-bar";
import EditorView from "@/v2/design/editor-view";
import f from "@/v2/design/flow.module.css";
import { BodySheet, LibrarySheet, loadLibrary, ZoomSheet } from "@/v2/design/sheets";
import Stage, { messageCardFor } from "@/v2/design/stage";
import StepDesign, { sameGraphic } from "@/v2/design/step-design";
import { bodyGroup } from "@/v2/lib/defaults";
import {
  libraryViewFor,
  occasionDef,
  occasionForPick,
  type OccasionId,
} from "@/v2/lib/occasions";
import { designName } from "@/v2/lib/order";
import type { BoxInterior, OccasionStrip } from "@/v2/lib/types";
import BoxThumb, { previewArt } from "@/v2/ui/box-thumb";
import { Button } from "@/v2/ui/controls";
import { Callout } from "@/v2/ui/feedback";
import e from "../design/embed.module.css";

/**
 * Step one of the journey, framed inside Paper (lib/embed): the Stage with
 * its body chip and style arrows, "Pick your design" with its occasion
 * chips, grid, search and library, and "Make your own" opening the editor —
 * each the journey's own component, wired here the way the journey wires
 * them. Only the edges differ:
 *
 *  - nothing is priced, stored or tracked: no cart, no draft kept in the
 *    browser, no analytics (lib/analytics is off on /embed/);
 *  - the one button says "Use this piñata", and instead of moving on to the
 *    card it tells the page that framed it what was picked: the body, the
 *    front (a store design, a hub graphic, or a design made here — staged
 *    exactly as for an order), and the card the message prints on.
 *
 * Opened on its own (no frame) it still works, so it can be looked at — the
 * pick just isn't sent anywhere.
 */

type SheetState =
  | { kind: "body" }
  | { kind: "zoom" }
  | { kind: "library"; occasion: OccasionId | null; search?: boolean }
  | null;

type Sent = { styleName: string; name: string; preview: string | null };

export default function EmbedSample({
  parents,
  styles,
  box,
  pricing,
  hubGraphics,
  hubCategories,
  strips,
  hubStrip,
  libraryCount,
  library,
  allowCustom,
  startStyleId,
  startGraphic,
  startOccasion,
}: {
  /** The origins allowed to frame this page and to talk to it. */
  parents: string[];
  /** Every body style, in stock or not: a sample can be of anything. */
  styles: HubBodyStyle[];
  box: BoxInterior | null;
  pricing: BuilderPricing;
  hubGraphics: HubGraphicEntry[];
  hubCategories: HubGraphicCategory[];
  strips: OccasionStrip[];
  hubStrip: GraphicChoice[];
  libraryCount: number;
  library: "all" | "birthday" | "none";
  allowCustom: boolean;
  startStyleId: string;
  startGraphic: GraphicChoice;
  startOccasion: OccasionId | null;
}) {
  const [styleId, setStyleId] = useState(startStyleId);
  const [graphic, setGraphic] = useState<GraphicChoice>(startGraphic);
  const [occasion, setOccasion] = useState<OccasionId | null>(startOccasion);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [editor, setEditor] = useState<{ retry: boolean; text: string | null } | null>(null);
  // "Use this piñata" was pressed while a design made here was still saving.
  const [wanted, setWanted] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [framed, setFramed] = useState(true);
  const parentOrigin = useRef<string | null>(null);
  const libraryScroll = useRef(0);
  // Re-render when a print upload changes state (saving / failed / saved).
  useSyncExternalStore(subscribeDesignSaves, designSavesVersion, () => 0);

  const style = useMemo(
    () => styles.find((s) => s.id === styleId) ?? styles[0],
    [styles, styleId],
  );

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
      return;
    }
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window.parent) return;
      // The framing page's answer to "ready" says which origin it is.
      if (readInit(ev.origin, ev.data, parents)) parentOrigin.current = ev.origin;
    };
    window.addEventListener("message", onMessage);
    for (const origin of parents) window.parent.postMessage(embedMessage("ready"), origin);
    return () => window.removeEventListener("message", onMessage);
  }, [parents]);

  /* --- a design made here: its print file is staged in the background --------- */

  const customJob =
    graphic.type === "custom" ? designSaveState(designKey(graphic.design)) : null;
  const landed = customJob?.status === "saved" ? customJob.assets : null;
  useEffect(() => {
    if (!landed) return;
    setGraphic((g) =>
      g.type === "custom" && !(g.art && g.artSha256) ? { ...g, ...landed } : g,
    );
  }, [landed]);
  const reported = embedGraphicFor(graphic);
  const saving = graphic.type === "custom" && !reported && customJob?.status !== "failed";
  const failed = graphic.type === "custom" && !reported && customJob?.status === "failed";

  const send = useCallback(() => {
    const picked = embedGraphicFor(graphic);
    if (!picked || !style) return;
    const preview = graphic.type === "custom" ? graphic.preview || null : previewArt(graphic, 720);
    post(
      embedChoiceMessage({
        style: { id: style.id, name: style.name },
        graphic: picked,
        messageCard: messageCardFor(graphic),
        preview,
      }),
    );
    setWanted(false);
    setSent({ styleName: style.name, name: designName(graphic), preview });
  }, [graphic, post, style]);

  // Pressed while saving: it goes the moment the print file is staged.
  useEffect(() => {
    if (wanted && reported) send();
  }, [wanted, reported, send]);

  const use = () => {
    if (reported) send();
    else setWanted(true);
  };

  /* --- choices (as the journey makes them) -------------------------------------- */

  const wearable = (id: string) => {
    if (graphic.type !== "hub") return true;
    const rec = hubGraphics.find((h) => h.design === graphic.design);
    return !rec || rec.bodyStyles === "all" || rec.bodyStyles.includes(id);
  };

  // The next/previous style in the body sheet's order (everyday first, then
  // occasions), skipping any this design isn't offered on; wraps around.
  const swipeStyle = (dir: 1 | -1) => {
    const ordered = [
      ...styles.filter((b) => bodyGroup(b.id) === "everyday"),
      ...styles.filter((b) => bodyGroup(b.id) === "occasions"),
    ].filter((b) => b.id === styleId || wearable(b.id));
    if (ordered.length < 2) return;
    const at = ordered.findIndex((b) => b.id === styleId);
    const next = ordered[(at + dir + ordered.length) % ordered.length];
    if (next && next.id !== styleId) setStyleId(next.id);
  };

  const pick = (g: GraphicChoice) => {
    setGraphic(g);
    setWanted(false);
  };

  const closeLibrary = () => {
    setSheet(null);
    // the library restores ITS scroll on the page behind; put ours back
    requestAnimationFrame(() => window.scrollTo(0, libraryScroll.current));
  };

  const onEditorSave = (design: DesignDocument, preview: string, assets: DesignAssets) => {
    pick({
      type: "custom",
      // stamp the CURRENT body (it can change while the editor is open)
      design: { ...design, bodyStyleId: styleId },
      preview,
      art: assets.art,
      designUrl: assets.designUrl,
      artSha256: assets.artSha256,
    });
    setEditor(null);
  };

  // The background print upload finished while the editor was still open.
  const onEditorAssets = (assets: DesignAssets, docJson: string) => {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(docJson);
    } catch {
      return;
    }
    setGraphic((g) =>
      g.type === "custom" &&
      JSON.stringify({ ...doc, bodyStyleId: g.design.bodyStyleId }) === JSON.stringify(g.design)
        ? { ...g, ...assets }
        : g,
    );
  };

  if (!style) return null;

  // No header here, so nothing for the pinned Stage to sit under.
  const frame = { "--pg-header-h": "0px" } as CSSProperties;

  if (sent) {
    return (
      <main className={e.page} style={frame}>
        <div className={e.panel}>
          {sent.preview && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img className={e.preview} src={sent.preview} alt="The front you picked" />
          )}
          {framed ? (
            <Callout tone="success" role="status">
              Sent to Paper: {sent.styleName}, {sent.name}. To pick something else — or to send it
              again — press &ldquo;Change this piñata&rdquo;.
            </Callout>
          ) : (
            <Callout tone="info" role="status">
              Picked: {sent.styleName}, {sent.name}. Nothing was sent anywhere, because this page
              isn&apos;t open inside Paper.
            </Callout>
          )}
          <div className={e.actions}>
            <Button variant="secondary" onClick={() => setSent(null)}>
              Change this piñata
            </Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={f.flow} style={frame}>
      {editor ? (
        <EditorView
          style={style}
          graphic={graphic}
          retry={editor.retry}
          startText={editor.text}
          onClose={() => setEditor(null)}
          onSave={onEditorSave}
          onAssets={onEditorAssets}
        />
      ) : (
        <div className={f.layout}>
          <div className={f.stageCol}>
            <div className={f.stagePin} data-step="design">
              <Stage
                step="design"
                style={style}
                graphic={graphic}
                message=""
                filling={null}
                box={box}
                onBody={() => setSheet({ kind: "body" })}
                onSwipe={swipeStyle}
                onZoom={() => setSheet({ kind: "zoom" })}
              />
            </div>
          </div>

          <div className={f.panel}>
            <div className={f.panelBody}>
              {!framed && (
                <div style={{ marginBottom: 12 }}>
                  <Callout tone="info">
                    This is the page staff open from Paper to start a sample. Opened on its own it
                    works the same, but the pick isn&apos;t sent anywhere.
                  </Callout>
                </div>
              )}
              <StepDesign
                graphic={graphic}
                style={style}
                occasion={occasion}
                strips={strips}
                hubStrip={hubStrip}
                hubGraphics={hubGraphics}
                hubCategories={hubCategories}
                // a sample is not sold: no upcharge badges
                tiered={false}
                pricing={pricing}
                libraryCount={libraryCount}
                allowCustom={allowCustom}
                classic={library !== "none"}
                makeOwnFirst
                onOccasion={setOccasion}
                onPick={pick}
                onSeeAll={(occ) => {
                  libraryScroll.current = window.scrollY;
                  setSheet({ kind: "library", occasion: occ });
                }}
                onSearch={() => {
                  libraryScroll.current = window.scrollY;
                  setSheet({ kind: "library", occasion: null, search: true });
                }}
                onLibraryIntent={() => void loadLibrary()}
                onMakeOwn={() => setEditor({ retry: false, text: null })}
              />
            </div>
            <ActionBar
              thumb={
                <BoxThumb
                  boxImageUrl={style.boxImageUrl}
                  logoZone={style.logoZone}
                  graphic={graphic}
                  size={40}
                />
              }
              main={style.name}
              sub={designName(graphic)}
              cta={{
                label: "Use this piñata",
                short: "Use this",
                onClick: use,
                busy: wanted && saving,
                notReady: failed,
              }}
              notice={
                failed && graphic.type === "custom" ? (
                  <Callout tone="error" role="alert">
                    Your design didn&apos;t finish saving. Check the connection and{" "}
                    <button
                      type="button"
                      onClick={() => void saveDesignArt(graphic.design)}
                      style={{ font: "inherit", textDecoration: "underline" }}
                    >
                      try again
                    </button>{" "}
                    — nothing you made is lost.
                  </Callout>
                ) : wanted && saving ? (
                  <Callout tone="info" role="status">
                    Saving your design at print size… it is sent the moment it is ready.
                  </Callout>
                ) : null
              }
            />
          </div>
        </div>
      )}

      <BodySheet
        open={sheet?.kind === "body"}
        onClose={() => setSheet(null)}
        styles={styles}
        current={style.id}
        wearable={wearable}
        onPick={(b) => setStyleId(b.id)}
      />
      <ZoomSheet
        open={sheet?.kind === "zoom"}
        onClose={() => setSheet(null)}
        graphic={graphic}
        name={designName(graphic)}
      />
      <LibrarySheet
        open={sheet?.kind === "library"}
        onClose={closeLibrary}
        restrict={library === "all" ? null : library}
        hubGraphics={hubGraphics}
        hubCategories={hubCategories}
        styleId={style.id}
        onPick={(g) => {
          if (!sameGraphic(g, graphic)) {
            pick(g);
            // The chip follows the design, as in the journey.
            if (g.type === "shopify") {
              const occ = occasionForPick(
                g.design,
                g.title,
                strips.map((s) => s.id),
              );
              if (occ && occ !== occasion) setOccasion(occ);
            }
          }
          closeLibrary();
        }}
        title={
          sheet?.kind === "library" && sheet.search
            ? "Search designs"
            : sheet?.kind === "library" && sheet.occasion
              ? `${occasionDef(sheet.occasion).label} designs`
              : "All designs"
        }
        initialView={sheet?.kind === "library" ? libraryViewFor(sheet.occasion) : undefined}
        autoFocusSearch={sheet?.kind === "library" && !!sheet.search}
        onMakeOwn={
          allowCustom
            ? (text) => {
                setSheet(null);
                setEditor({
                  retry: false,
                  text: text?.trim() ? text.trim().replace(/\s+/g, " ").slice(0, 60) : null,
                });
              }
            : undefined
        }
      />
    </main>
  );
}
