"use client";

import dynamic from "next/dynamic";
import type { FlowData } from "../lib/types";

// /design serves BOTH journeys from one page module, and every client
// component a page imports lands in that page's chunk. Loaded through
// dynamic() the v2 journey is its own chunk (still server-rendered):
// builder.pinatagrams.com (v1) never downloads it.
const DesignFlowV2 = dynamic(() => import("./design-flow-v2"));

export default function DesignFlowV2Lazy(props: FlowData) {
  return <DesignFlowV2 {...props} />;
}
