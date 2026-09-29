import { track } from "@/lib/analytics";

/**
 * Every v2 event carries flow_version "v2" (the step_viewed/step_completed
 * contract; harmless and useful on the rest), fanned out through the shared
 * track() — its signature and destinations are unchanged.
 */
export function trackV2(event: string, props?: Record<string, unknown>): void {
  track(event, { flow_version: "v2", ...(props ?? {}) });
}
