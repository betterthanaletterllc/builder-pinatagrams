"use client";

import dynamic from "next/dynamic";
import type { LogoZone } from "@/lib/hub";
import type { DesignDocument } from "@/lib/design-document";

// react-konva touches window at import time — client-only, no SSR.
const Editor = dynamic(() => import("./editor"), {
  ssr: false,
  loading: () => <p className="note">Loading the editor…</p>,
});

export default function EditorShell({
  bodyStyleId,
  boxImageUrl,
  logoZone,
  onSave,
  onAssets,
  initialDesign,
  initialAssets,
}: {
  bodyStyleId: string;
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
  onSave?: (
    design: DesignDocument,
    preview: string,
    assets: { art: string | null; designUrl: string | null },
  ) => void;
  onAssets?: (
    assets: { art: string | null; designUrl: string | null },
    docJson: string,
  ) => void;
  initialDesign?: DesignDocument | null;
  initialAssets?: { art: string | null; designUrl: string | null } | null;
}) {
  return (
    <Editor
      bodyStyleId={bodyStyleId}
      boxImageUrl={boxImageUrl}
      logoZone={logoZone}
      onSave={onSave}
      onAssets={onAssets}
      initialDesign={initialDesign}
      initialAssets={initialAssets}
    />
  );
}
