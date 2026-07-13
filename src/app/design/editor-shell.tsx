"use client";

import dynamic from "next/dynamic";
import type { LogoZone } from "@/lib/hub";
import type { DesignDocument } from "@/lib/design-document";
import type { DesignAssets } from "@/lib/flow";

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
    assets: DesignAssets,
  ) => void;
  onAssets?: (assets: DesignAssets, docJson: string) => void;
  initialDesign?: DesignDocument | null;
  initialAssets?: Partial<DesignAssets> | null;
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
