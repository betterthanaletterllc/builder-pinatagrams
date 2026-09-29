import type { DesignAssets } from "./flow";
import {
  artboardPx,
  designKey,
  type DesignDocument,
} from "./design-document";
import { toPrintBlob } from "./print-png";
import { track } from "./analytics";

/**
 * Custom-design print uploads, OUTSIDE any component. "Use this design"
 * advances the flow at once and the editor unmounts, so the upload can't
 * live in the editor: here it survives the unmount, anyone can watch its
 * status (the confirm screen, the add-to-cart button), and Retry works long
 * after the editor is gone.
 *
 * One job per design (keyed by designKey — the doc minus bodyStyleId):
 *   render (the editor's live-stage canvas, or a headless re-render from the
 *   document when there is none) → print file at artboard size with real DPI
 *   → sha256 over EXACTLY those bytes → upload the file + the design.json
 *   sidecar to Blob.
 * The encoded file and its hash are kept until the upload lands, so a retry
 * re-sends the identical bytes and the hash Paper verifies stays true.
 *
 * Nothing here navigates. Add-to-cart waits for "saved" (a full navigation
 * mid-upload is what used to strand art-less lines that checkout refuses).
 */

export type DesignSaveState =
  | { status: "saving" }
  | { status: "saved"; assets: DesignAssets }
  | { status: "failed"; reason: string };

type PrintFile = {
  blob: Blob;
  sha256: string;
  format: "image/png" | "image/jpeg";
  ext: "png" | "jpg";
};

type Job = {
  // Dropped once saved — photo-heavy documents are megabytes.
  doc: DesignDocument | null;
  canvas: HTMLCanvasElement | null;
  file: PrintFile | null;
  state: DesignSaveState;
  running: boolean;
  resolve: (a: DesignAssets) => void;
  // Resolves on the FIRST success, however many retries that takes; never
  // rejects (failure is a state, not an exception).
  saved: Promise<DesignAssets>;
};

// A stalled request must surface as "Couldn't save — Retry", never spin
// forever. Generous: a ~2 MB photo design takes ~20s even at 1 Mbps up.
const UPLOAD_TIMEOUT_MS = 60_000;
// One quiet automatic retry absorbs a network blip before the shopper sees
// a failure.
const AUTO_ATTEMPTS = 2;

const jobs = new Map<string, Job>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version++;
  listeners.forEach((l) => l());
}

/** useSyncExternalStore plumbing: subscribe + a cheap snapshot. */
export function subscribeDesignSaves(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function designSavesVersion(): number {
  return version;
}

/** The upload state for a design (by designKey), or null if none started. */
export function designSaveState(key: string): DesignSaveState | null {
  return jobs.get(key)?.state ?? null;
}

class StageError extends Error {
  constructor(
    readonly stage: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

async function at<T>(stage: string, p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw new StageError(stage, e);
  }
}

function reasonOf(e: unknown): string {
  const stage = e instanceof StageError ? e.stage : "upload";
  const msg = e instanceof Error ? e.message : String(e);
  return `${stage}: ${msg}`.slice(0, 120);
}

function uploadId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function attempt(job: Job): Promise<DesignAssets> {
  const doc = job.doc!;
  if (!job.file) {
    const canvas: HTMLCanvasElement = job.canvas
      ? job.canvas
      : await at(
          "render",
          import("./design-render").then((m) => m.renderDesignCanvas(doc)),
        );
    const { width, height } = artboardPx(doc.artboard);
    const hasPhoto = doc.slots.some((s) => s?.kind === "photo");
    const format = hasPhoto ? "image/jpeg" : "image/png";
    // Exactly artboard-sized (2400×1170) with real 300-DPI metadata, so the
    // file measures 8"×3.9" in print tools instead of 72-DPI-huge.
    const blob = await at(
      "encode",
      toPrintBlob(canvas, width, height, doc.artboard.dpi, format),
    );
    // Hash the exact bytes being uploaded (post-DPI-stamp) — Paper re-hashes
    // what it downloads from the blob and refuses a mismatch.
    const digest = await at(
      "hash",
      blob.arrayBuffer().then((b) => crypto.subtle.digest("SHA-256", b)),
    );
    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    job.file = { blob, sha256, format, ext: hasPhoto ? "jpg" : "png" };
    job.canvas = null; // the encoded file is what uploads from here on
  }

  const file = job.file;
  const { upload } = await at("upload", import("@vercel/blob/client"));
  // Fresh path per attempt: the store refuses to overwrite (no random
  // suffix), and a half-finished earlier attempt may own the old one.
  const id = uploadId();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const [put, sidecar] = await Promise.all([
      upload(`builder-art/${id}/front.${file.ext}`, file.blob, {
        access: "public",
        handleUploadUrl: "/api/art/upload",
        contentType: file.format,
        abortSignal: ctrl.signal,
      }),
      upload(
        `builder-art/${id}/design.json`,
        new Blob([JSON.stringify(doc)], { type: "application/json" }),
        {
          access: "public",
          handleUploadUrl: "/api/art/upload",
          contentType: "application/json",
          abortSignal: ctrl.signal,
        },
      ),
    ]);
    return { art: put.url, designUrl: sidecar.url, artSha256: file.sha256 };
  } catch (e) {
    throw new StageError(ctrl.signal.aborted ? "timeout" : "upload", e);
  } finally {
    clearTimeout(timer);
  }
}

async function run(job: Job): Promise<void> {
  if (job.running || job.state.status === "saved") return;
  job.running = true;
  job.state = { status: "saving" };
  emit();
  const t0 = Date.now();
  let reason = "unknown";
  for (let n = 0; n < AUTO_ATTEMPTS; n++) {
    if (n > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const assets = await attempt(job);
      job.state = { status: "saved", assets };
      job.running = false;
      job.doc = null;
      job.canvas = null;
      job.file = null;
      track("art_upload_succeeded", { ms: Date.now() - t0, attempts: n + 1 });
      emit();
      job.resolve(assets);
      return;
    } catch (e) {
      reason = reasonOf(e);
    }
  }
  job.running = false;
  job.state = { status: "failed", reason };
  track("art_upload_failed", { reason });
  emit();
}

/**
 * Start (or join) the print upload for a design. `canvas` is the editor's
 * live-stage export at print resolution; without one the design is
 * re-rendered headlessly from the document. A failed job restarts; a saved
 * one resolves immediately. The promise resolves on the first success and
 * never rejects — watch designSaveState for failures.
 */
export function saveDesignArt(
  doc: DesignDocument,
  opts?: { canvas?: HTMLCanvasElement | null },
): Promise<DesignAssets> {
  const key = designKey(doc);
  const existing = jobs.get(key);
  if (existing) {
    if (existing.state.status === "failed" && !existing.running) {
      if (opts?.canvas && !existing.file) existing.canvas = opts.canvas;
      void run(existing);
    }
    return existing.saved;
  }
  let resolve!: (a: DesignAssets) => void;
  const saved = new Promise<DesignAssets>((r) => (resolve = r));
  const job: Job = {
    doc,
    canvas: opts?.canvas ?? null,
    file: null,
    state: { status: "saving" },
    running: false,
    resolve,
    saved,
  };
  jobs.set(key, job);
  void run(job);
  return saved;
}
