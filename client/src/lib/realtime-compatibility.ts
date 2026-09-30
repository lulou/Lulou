import type { RealtimeChannel } from "@supabase/supabase-js";

/** Evidence describes the executing page, not its cached or waiting service worker. */
export const REALTIME_COMPATIBILITY = "private-v1";

let sessionChannel: RealtimeChannel | null = null;
let lastPrivateJoinAt: number | null = null;

export function setPrivateSessionChannel(channel: RealtimeChannel | null): void {
  sessionChannel = channel;
}

export function notePrivateSessionJoined(channel: RealtimeChannel): void {
  if (sessionChannel === channel) lastPrivateJoinAt = Date.now();
}

export function getRealtimeCompatibilityEvidence() {
  const privateSessionJoined = !!sessionChannel &&
    sessionChannel.params.config.private === true &&
    sessionChannel.state === "joined";
  return {
    executingBundleCommit: __COMMIT_HASH__,
    capability: REALTIME_COMPATIBILITY,
    privateSessionJoined,
    lastPrivateJoinAt,
  };
}

/** Only attest compatibility from an actual authenticated, joined private channel. */
export function getRealtimeCapabilityHeaders(): Record<string, string> {
  const evidence = getRealtimeCompatibilityEvidence();
  return evidence.privateSessionJoined
    ? {
        "X-Lulou-Realtime-Capability": evidence.capability,
        "X-Lulou-Bundle-Commit": evidence.executingBundleCommit,
      }
    : {};
}