import type { RealtimeChannel } from "@supabase/supabase-js";

/** Evidence describes the executing page, not its cached or waiting service worker. */
export const REALTIME_COMPATIBILITY = "private-v1";

let sessionChannel: RealtimeChannel | null = null;
let lastPrivateJoinAt: number | null = null;
let lastPrivateStatus = "NOT_STARTED";
let lastPrivateStatusChangeAt: number | null = null;
let realtimeAuthApplied = false;

/** Called only by the existing session subscription, after setAuth succeeds. */
export function setPrivateSessionChannel(channel: RealtimeChannel | null, authApplied = false): void {
  if (sessionChannel === channel) return;
  sessionChannel = channel;
  realtimeAuthApplied = !!channel && authApplied;
  lastPrivateJoinAt = null;
  lastPrivateStatus = channel ? "PENDING" : "CLOSED";
  lastPrivateStatusChangeAt = Date.now();
}

/** Observe the original subscription callback; never subscribe a second time. */
export function notePrivateSessionStatus(channel: RealtimeChannel, status: string): void {
  if (sessionChannel !== channel) return;
  lastPrivateStatus = status;
  lastPrivateStatusChangeAt = Date.now();
  if (status === "SUBSCRIBED") lastPrivateJoinAt = Date.now();
}

function abbreviate(value: string | undefined): string {
  if (!value) return "—";
  return value.length > 12
    ? `${value.slice(0, 8)}…${value.slice(-4)}`
    : `${value.slice(0, 3)}…`;
}

export function getRealtimeCompatibilityEvidence(currentUserId?: string) {
  const topic = sessionChannel?.topic?.replace(/^realtime:/, "") ?? "";
  const topicUserId = topic.startsWith("private-session:")
    ? topic.slice("private-session:".length)
    : "";
  const privateSessionJoined = !!sessionChannel &&
    realtimeAuthApplied &&
    !!topicUserId &&
    sessionChannel.params.config.private === true &&
    sessionChannel.state === "joined" &&
    lastPrivateStatus === "SUBSCRIBED";
  return {
    executingBundleCommit: __COMMIT_HASH__,
    capability: REALTIME_COMPATIBILITY,
    authenticatedUserId: abbreviate(currentUserId),
    privateSessionTopic: topicUserId ? `private-session:${abbreviate(topicUserId)}` : "—",
    topicMatchesCurrentUser: !!currentUserId && topicUserId === currentUserId,
    realtimeAuthApplied,
    privateChannel: sessionChannel?.params.config.private === true,
    channelState: sessionChannel?.state ?? "closed",
    privateSessionStatus: lastPrivateStatus,
    lastPrivateStatusChangeAt,
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