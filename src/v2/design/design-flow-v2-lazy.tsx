"use client";

import { lazy, Suspense } from "react";
import type { FlowData } from "../lib/types";

// /design serves BOTH journeys from one page module, and every client
// component a page imports lands in that page's chunk. Loaded lazily the v2
// journey is its own chunk (still server-rendered): builder.pinatagrams.com
// (v1) never downloads it.
//
// React.lazy, not next/dynamic: dynamic()'s server render adds a preload
// sibling the client tree doesn't have, which shifts every useId() below it
// (sheet titles, field labels) and trips a hydration mismatch.
const DesignFlowV2 = lazy(() => import("./design-flow-v2"));

export default function DesignFlowV2Lazy(props: FlowData) {
  return (
    <Suspense fallback={null}>
      <DesignFlowV2 {...props} />
    </Suspense>
  );
}
