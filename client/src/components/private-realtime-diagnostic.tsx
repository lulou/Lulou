import React from "react";
import type { getRealtimeCompatibilityEvidence } from "../lib/realtime-compatibility";

type Evidence = ReturnType<typeof getRealtimeCompatibilityEvidence>;

/** Render-only: this component never creates, subscribes to, or removes a channel. */
export function PrivateRealtimeDiagnosticCard({
  evidence,
  websocketConnected,
}: {
  evidence: Evidence;
  websocketConnected: boolean;
}) {
  const joined = evidence.privateSessionJoined &&
    evidence.topicMatchesCurrentUser &&
    websocketConnected;

  return (
    <section className="rounded-2xl border border-border bg-card p-4 text-sm" data-testid="private-realtime-diagnostic">
      <h2 className="font-semibold">Private Realtime — this running device</h2>
      <p
        role="status"
        aria-live="polite"
        className={`my-3 rounded-lg px-3 py-3 text-base font-bold ${joined ? "bg-green-100 text-green-900" : "bg-amber-100 text-amber-900"}`}
      >
        PRIVATE REALTIME: {joined ? "JOINED" : "NOT JOINED"}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 break-all">
        <dt>Executing frontend build</dt><dd className="font-mono">{evidence.executingBundleCommit}</dd>
        <dt>Authenticated user</dt><dd className="font-mono">{evidence.authenticatedUserId}</dd>
        <dt>Realtime auth</dt><dd>{evidence.realtimeAuthApplied ? "Access token applied before join" : "Not applied to this channel"}</dd>
        <dt>Private topic</dt><dd className="font-mono">{evidence.privateSessionTopic}</dd>
        <dt>Topic matches this user</dt><dd>{evidence.topicMatchesCurrentUser ? "Yes" : "No"}</dd>
        <dt>Channel private</dt><dd>{evidence.privateChannel ? "true" : "false"}</dd>
        <dt>Subscription status</dt><dd>{evidence.privateSessionStatus}</dd>
        <dt>Last status change</dt><dd>{evidence.lastPrivateStatusChangeAt ? new Date(evidence.lastPrivateStatusChangeAt).toLocaleString() : "—"}</dd>
        <dt>Channel state</dt><dd>{evidence.channelState}</dd>
        <dt>WebSocket connected</dt><dd>{websocketConnected ? "Yes" : "No"}</dd>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        This describes this running page, not the service worker. It does not prove private message or call delivery.
      </p>
    </section>
  );
}