import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";
import { markCallSessionCancelled, markStartupCancelledSession, isCallSessionCancelled, isStartupCancelledOnly, clearStartupCancelledSession } from "@/lib/cancelled-calls";
import { armCallSession, markSessionAsVideo, isPushArmedSession } from "@/lib/live-call-sessions";
import { APP_LOAD_TIME } from "@/lib/app-load-time";
import { isStartupSweepComplete } from "@/lib/startup-sweep";

type CallSignalEvent =
  | { type: "call:ring"; matchId: string; callerId: string; callerName: string; callSessionId?: string; isVideo?: boolean }
  | { type: "call:answered"; matchId: string; userId: string; callSessionId?: string }
  | { type: "call:declined"; matchId: string; userId: string }
  | { type: "call:cancelled"; matchId: string; userId: string }
  | { type: "call:ended"; matchId: string; userId: string };

function getChannelName(matchId: string) {
  return `call-signal:${matchId}`;
}

const subscribedChannels = new Map<string, ReturnType<typeof supabase.channel>>();

let callEndedCallback: ((matchId: string, callSessionId?: string | null) => void) | null = null;
let callRingHandler: ((active: boolean) => void) | null = null;
const recentlyProcessed = new Set<string>();

export function setCallEndedHandler(handler: ((matchId: string, callSessionId?: string | null) => void) | null) {
  callEndedCallback = handler;
}

export function setCallRingHandler(handler: ((active: boolean) => void) | null) {
  callRingHandler = handler;
}

export function clearDedupeForMatch(matchId: string) {
  for (const key of recentlyProcessed) {
    if (key.startsWith(`${matchId}:`)) {
      recentlyProcessed.delete(key);
    }
  }
}

function processEndSignal(matchId: string, reason: string, callSessionId?: string | null) {
  // Include callSessionId in the dedup key so that two sequential calls on the
  // same match can both produce an end signal within the 10 s window.  Without
  // the session ID, the second call's ended/declined/cancelled signal would be
  // silently dropped as a duplicate, leaving the overlay stuck.
  const key = `${matchId}:${reason}:${callSessionId ?? ""}`;
  if (recentlyProcessed.has(key)) {
    console.log("[CALL_STATE] duplicate event ignored", { matchId, reason, key });
    return;
  }
  recentlyProcessed.add(key);
  setTimeout(() => recentlyProcessed.delete(key), 10000);
  console.log("[CALL_SESSION] CONNECTION_REMOVED", { matchId, callSessionId, reason: `signal_${reason}`, source: "realtime" });
  callEndedCallback?.(matchId, callSessionId);
}

export function useCallSignaling(matchIds: string[], userId: string) {
  const prevKeyRef = useRef("");

  useEffect(() => {
    const key = [...matchIds].sort().join(",") + "|" + userId;
    if (key === prevKeyRef.current) return;
    prevKeyRef.current = key;

    if (!userId || matchIds.length === 0) return;

    const currentIds = new Set(matchIds);

    for (const [id, ch] of subscribedChannels.entries()) {
      if (!currentIds.has(id)) {
        supabase.removeChannel(ch);
        subscribedChannels.delete(id);
      }
    }

    for (const matchId of matchIds) {
      if (subscribedChannels.has(matchId)) continue;

      const channel = supabase.channel(getChannelName(matchId), {
        config: { broadcast: { self: false } },
      });

      channel.on("broadcast", { event: "call-signal" }, ({ payload }) => {
        console.log("[CALL_SIGNAL] BROADCAST_RECEIVED", { matchId, payloadType: payload?.type, senderId: payload?.userId || payload?.callerId, isSelf: (payload?.userId || payload?.callerId) === userId });
        if (!payload) return;
        const senderId = payload.userId || payload.callerId;
        if (senderId === userId) {
          console.log("[CALL_SIGNAL] ignored own signalling message", { matchId, type: payload?.type });
          console.log("[CALL_SIGNAL] BROADCAST_SELF_FILTERED", { matchId, type: payload?.type });
          return;
        }
        const event = payload as CallSignalEvent;

        let isEndSignal = false;

        if (event.type === "call:ring") {
          const ring = event as any;
          const ringSessionId = ring.callSessionId ?? null;

          // ── Pre-load ring guard ─────────────────────────────────────────────
          // Block calls that started before this browser session regardless of
          // whether the startup sweep has run yet. The sweep is a useEffect and
          // may not have executed when the first rering arrives (Realtime connects
          // fast; /api/matches fetch is slower). Without this check the session
          // gets armed, ringtone starts, sweep runs and stops it, next rering
          // re-arms, sweep stops it again — an oscillating ring every ~10 s.
          //
          // Strategy A — cache already has the match (most common on revisit):
          //   Read callStartedAt from the TanStack Query cache. If it predates
          //   APP_LOAD_TIME, permanently cancel and bail.
          //
          // Strategy B — cache is empty (cold first load):
          //   Fall through to the isStartupCancelledOnly check; the sweep will
          //   mark it startup-cancelled after the first /api/matches response, and
          //   the NEXT rering will hit Strategy A or the isStartupCancelledOnly
          //   block below.
          const cachedMatches = queryClient.getQueryData<any[]>(["/api/matches"]);
          const cachedMatchEntry = cachedMatches?.find((m: any) => m.id === matchId);
          const cachedCallStartAt = cachedMatchEntry?.callStartedAt;

          // ── Already-ended call guard ─────────────────────────────────────────
          // The session ID encodes the call's start timestamp:
          //   call-{matchId}-{startTimestampMs}
          // Extract it so we can compare against APP_LOAD_TIME.
          //
          // DO NOT block solely on "cachedCallStartAt is null" — a fresh ring
          // arrives before the receiver's cache has been updated by the 10 s poll,
          // so callStartedAt is legitimately null in the cache for live just-started
          // calls. That check blocked every real ring: the receiver's session was
          // marked cancelled, all rererings were dropped, and the incoming call
          // overlay never appeared.
          //
          // Safe rule: if the ring's encoded timestamp predates APP_LOAD_TIME AND
          // the cache confirms no active call, the ring is for a call that ended
          // before this page session — block it.
          const ringTimestampMs = (() => {
            if (!ringSessionId) return null;
            const lastPart = ringSessionId.split('-').pop();
            const ts = lastPart ? parseInt(lastPart, 10) : NaN;
            return isNaN(ts) ? null : ts;
          })();
          if (cachedMatchEntry !== undefined && !cachedCallStartAt && ringTimestampMs !== null && ringTimestampMs < APP_LOAD_TIME) {
            // Push-notification exception: if the app was opened by tapping an
            // incoming-call notification, the session is already armed via the
            // startup sweep — never cancel it based on a pre-load timestamp.
            if (isPushArmedSession(ringSessionId)) {
              console.log("[CALL_RING] pre-load rering allowed — session already push-armed", { matchId, callSessionId: ringSessionId?.slice(0, 8) });
            } else {
              console.log("[CALL_SIGNAL] STALE_RING_BLOCKED pre-load session with null cache", {
                matchId, callSessionId: ringSessionId?.slice(0, 8), ringTimestampMs, APP_LOAD_TIME,
              });
              markCallSessionCancelled(matchId, ringSessionId);
              return;
            }
          }

          if (cachedCallStartAt) {
            const callStartMs = new Date(cachedCallStartAt).getTime();
            if (callStartMs > 0 && callStartMs < APP_LOAD_TIME) {
              // Same push-notification exception: allow rererings for sessions
              // that were explicitly armed by a push notification tap.
              if (isPushArmedSession(ringSessionId)) {
                console.log("[CALL_RING] pre-load rering allowed — session already push-armed", { matchId, callSessionId: ringSessionId?.slice(0, 8) });
              } else {
                console.log("[CALL_SIGNAL] PRE_LOAD_RING_BLOCKED stale call predates session", {
                  matchId, callStartMs, APP_LOAD_TIME, delta: APP_LOAD_TIME - callStartMs,
                });
                markCallSessionCancelled(matchId, ringSessionId);
                return;
              }
            }
          }

          // ── Startup-cancelled block ─────────────────────────────────────────
          // The startup sweep runs this path for calls whose callStartedAt was
          // confirmed < APP_LOAD_TIME by the /api/matches response.  Previously
          // we called clearStartupCancelledSession() here to allow live rererings
          // to lift the block — but that created an oscillation: sweep blocks →
          // rering lifts → sweep blocks again every 10 s poll.
          //
          // Correct behaviour: once the sweep marks a pre-load call startup-
          // cancelled, NO rering should re-enable it.  If the caller wants to
          // reach the refreshed user they must start a new call (new sessionId).
          if (isStartupCancelledOnly(matchId, ringSessionId)) {
            console.log("[CALL_SIGNAL] STARTUP_RERING_BLOCKED permanently cancelled pre-load rering", { matchId });
            markCallSessionCancelled(matchId, ringSessionId);
            return;
          }
          // ── Pre-sweep block ─────────────────────────────────────────────────
          // The startup staleness sweep needs one /api/matches response to
          // determine whether callStartedAt predates APP_LOAD_TIME (Strategy A
          // in the pre-load guard above).  On a cold refresh the cache is empty
          // so Strategy A is skipped; the sweep then runs ~1-3 s later.
          //
          // A rering can arrive in that gap (~200 ms after Realtime connects)
          // BEFORE the sweep has confirmed whether this call is stale.  Without
          // this guard the session would be armed, audio would start, and the
          // sweep would stop it a second later — exactly the "rings once on
          // refresh" bug.
          //
          // Fix: do NOT arm the session until the startup sweep is complete.
          // The rering interval is 2 s, so the next rering will arrive after
          // the sweep has run and genuine live calls will ring normally then.
          // Pre-load stale calls will have been startup-cancelled by the sweep
          // and will hit isStartupCancelledOnly → blocked permanently.
          if (!isStartupSweepComplete()) {
            // Post-load calls (timestamp >= APP_LOAD_TIME): we can't yet know if
            // this is a stale replay or a genuine fresh ring — just defer.  The
            // rering interval is 2 s, so the next rering will arrive after the
            // sweep has completed and will be evaluated normally.  Do NOT mark it
            // startup-cancelled: that would permanently block a genuine new call
            // that started in the ~0-3 s window between page load and sweep.
            if (ringTimestampMs !== null && ringTimestampMs >= APP_LOAD_TIME) {
              console.log("[CALL_SIGNAL] PRE_SWEEP_RING_DEFERRED — post-load call, deferring until sweep completes", { matchId, callSessionId: ringSessionId?.slice(0, 8), ringTimestampMs, APP_LOAD_TIME });
              return;
            }
            // Pre-load calls: mark startup-cancelled NOW (not just on the next rering).
            // If the server clears callStartedAt before the first /api/matches
            // response, the startup sweep will see no stale call and skip the
            // match entirely — leaving the session un-cancelled.  Recording it
            // here ensures that even in that race window, the session is
            // blocked once the sweep completes and `isStartupCancelledOnly`
            // is re-checked on the next rering.
            markStartupCancelledSession(matchId, ringSessionId);
            console.log("[CALL_SIGNAL] PRE_SWEEP_RING_BLOCKED — startup sweep not yet complete, session marked startup-cancelled", { matchId, callSessionId: ringSessionId?.slice(0, 8) });
            return;
          }

          // Skip stale ring signals for sessions that were cancelled by user action
          if (isCallSessionCancelled(matchId, ringSessionId)) {
            console.log("[CALL_SIGNAL] STALE_RING_BLOCKED", { matchId, callSessionId: ringSessionId, reason: "session_already_cancelled" });
          } else {
            // Arm the session: this is a live Realtime call:ring event, so the
            // session is confirmed active. Only armed sessions may trigger overlays
            // or audio — DB-polled data alone cannot arm a session.
            armCallSession(ringSessionId);
            if ((ring as any).isVideo && ringSessionId) markSessionAsVideo(ringSessionId);
            console.log("[RING_DEBUG] verified live call trigger — armed by Realtime call:ring", {
              matchId,
              sessionId: ringSessionId?.slice(0, 8) ?? "none",
            });
            console.log("[TIMING] RING_RECEIVED", { matchId, callSessionId: ringSessionId, callerId: ring.callerId, receiverId: userId, ts: new Date().toISOString() });
            console.log("[CALL_SIGNAL] RECEIVER_ASSIGNED", { matchId, callerId: ring.callerId, receiverId: userId });
            // Immediately update the list cache so incoming call UI shows without waiting for a refetch
            queryClient.setQueriesData<any[]>({ queryKey: ["/api/matches"] }, (old) => {
              if (!old || !Array.isArray(old)) return old;
              return old.map((m: any) => m.id === matchId ? {
                ...m,
                callStartedAt: m.callStartedAt || new Date().toISOString(),
                callInitiatorId: m.callInitiatorId || ring.callerId,
                callSessionId: m.callSessionId || ring.callSessionId,
                // callAnswered reset rule:
                //   SAME session rering  → preserve existing value so a stale
                //     ring arriving after the callee answered (e.g. Supabase
                //     channel reconnect) does NOT flip callAnswered back to false
                //     and cause a WebRTC renegotiation loop.
                //   NEW session ring     → always reset to false, clearing any
                //     zombie callAnswered:true left over from a previous call
                //     that was answered but whose callCompleted never arrived.
                //     Without this reset the receiver's cache stays stuck at
                //     callAnswered:true, forcedIncomingMatch filters the match
                //     out, answeredCall claims it, and ActiveCallOverlay renders
                //     instead of IncomingCallOverlay.
                callAnswered: (m.callSessionId && m.callSessionId === ring.callSessionId)
                  ? (m.callAnswered ?? false)
                  : false,
                callCompleted: m.callCompleted ?? false,
              } : m);
            });
            // Also patch the DETAIL cache ["/api/matches", matchId] — messaging.tsx
            // reads from this cache (not the list), so without this patch the detail
            // query never sees callStartedAt and isCallRinging stays false there.
            // The call:answered handler already does this; ring must mirror it.
            queryClient.setQueriesData<any>({ queryKey: ["/api/matches", matchId] }, (old: any) => {
              if (!old || Array.isArray(old)) return old;
              return {
                ...old,
                callStartedAt: old.callStartedAt || new Date().toISOString(),
                callInitiatorId: old.callInitiatorId || ring.callerId,
                callSessionId: old.callSessionId || ring.callSessionId,
                callAnswered: (old.callSessionId && old.callSessionId === ring.callSessionId)
                  ? (old.callAnswered ?? false)
                  : false,
                callCompleted: old.callCompleted ?? false,
              };
            });
            // Signal that a ring is now active so CallDetectors can pause
            // the 5-second refetchInterval — prevents the next poll from
            // overwriting this optimistic patch with stale REST data before
            // the DB write becomes visible to PostgREST.
            callRingHandler?.(true);
            // Also cancel any currently in-flight refetch for the same reason.
            if (queryClient.getQueryState(["/api/matches"])?.data !== undefined) {
              queryClient.cancelQueries({ queryKey: ["/api/matches"] });
              console.log("[CALL_FIX] iphone overlay flicker prevented — in-flight refetch cancelled + polling paused", { matchId, callSessionId: ringSessionId });
            } else {
              console.log("[CALL_FIX] iphone flicker cancel skipped — initial fetch not yet complete (polling paused anyway)", { matchId, callSessionId: ringSessionId });
            }
          }
        } else if (event.type === "call:answered") {
          const answeredSid = (event as any).callSessionId ?? null;
          console.log("[CALL_SIGNAL] CALL_ANSWERED", { matchId, answeredBy: senderId, callSessionId: answeredSid });
          // Arm the session on call:answered — belt-and-suspenders for the caller
          // (receiver was already armed on call:ring). Without this, a caller who
          // refreshed between ring and answer would not have the session armed and
          // ActiveCallOverlay would fail to mount.
          // Guard: if the startup sweep hasn't run yet, a stale call:answered
          // replayed from a previous session could arm a dead session before the
          // sweep can cancel it.  Block until sweep is complete.
          if (!isStartupSweepComplete()) {
            markStartupCancelledSession(matchId, answeredSid);
            console.log("[CALL_SIGNAL] PRE_SWEEP_ANSWERED_BLOCKED", { matchId, callSessionId: answeredSid?.slice(0, 8) });
            return;
          }
          armCallSession(answeredSid);
          // If the startup sweep marked this session as startup-cancelled-only
          // (caller-side), lift the block now so answeredCall can mount the overlay.
          if (isStartupCancelledOnly(matchId, answeredSid)) {
            clearStartupCancelledSession(matchId, answeredSid);
          }
          // Immediately flip callAnswered so the caller transitions from ringing to in-call
          const answeredPatch = { callAnswered: true };
          queryClient.setQueriesData<any[]>({ queryKey: ["/api/matches"] }, (old) => {
            if (!old || !Array.isArray(old)) return old;
            return old.map((m: any) => m.id === matchId ? { ...m, ...answeredPatch } : m);
          });
          queryClient.setQueriesData<any>({ queryKey: ["/api/matches", matchId] }, (old: any) => {
            if (!old || Array.isArray(old)) return old;
            return { ...old, ...answeredPatch };
          });
        } else if (event.type === "call:declined") {
          const sid = (event as any).callSessionId ?? null;
          console.log("[CALL_SIGNAL] CALL_DECLINED", { matchId, declinedBy: senderId, callSessionId: sid });
          markCallSessionCancelled(matchId, sid);
          callRingHandler?.(false);
          processEndSignal(matchId, "declined", sid);
          isEndSignal = true;
        } else if (event.type === "call:cancelled") {
          const sid = (event as any).callSessionId ?? null;
          console.log("[CALL_SIGNAL] CALL_CANCELLED", { matchId, cancelledBy: senderId, callSessionId: sid });
          markCallSessionCancelled(matchId, sid);
          callRingHandler?.(false);
          processEndSignal(matchId, "cancelled", sid);
          isEndSignal = true;
        } else if (event.type === "call:ended") {
          const sid = (event as any).callSessionId ?? null;
          console.log("[CALL_SIGNAL] CALL_ENDED", { matchId, endedBy: senderId, callSessionId: sid });
          markCallSessionCancelled(matchId, sid);
          callRingHandler?.(false);
          processEndSignal(matchId, "ended", sid);
          isEndSignal = true;
        }

        if (isEndSignal) {
          // Refresh match detail so call status, conversation stage, and
          // message counts immediately reflect authoritative server state.
          // exact:true on the detail key avoids invalidating the messages
          // sub-query ([matchId, "messages"]), so chat history is untouched.
          queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId], exact: true });
          queryClient.invalidateQueries({ queryKey: ["/api/matches"], exact: true });
          console.log("[CALL_SESSION] END_SIGNAL_REFRESH", {
            matchId,
            signal: event.type,
            note: "detail + list re-fetched; messages sub-query preserved via exact:true",
          });
        } else if (event.type !== "call:ring" && event.type !== "call:answered") {
          // call:ring  — handled exclusively by the optimistic cache patch above.
          // call:answered — also handled by setQueriesData above; firing
          //   invalidateQueries immediately after the patch races with the DB
          //   write (broadcast arrives before the row is readable by PostgREST)
          //   causing callAnswered to briefly snap back to false and flicker the
          //   caller from "answered" back to "ringing" until the next poll.
          //   The 10 s poll confirms server state without the race condition.
          queryClient.invalidateQueries({ queryKey: ["/api/matches"], exact: true });
          queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
        }
      });

      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log("[CALL_STATE] subscription created", { matchId, channelName: getChannelName(matchId) });
          console.log("[CALL_SIGNAL] CHANNEL_SUBSCRIBED", { matchId, channelName: getChannelName(matchId) });
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          console.error("[CALL_SIGNAL] CHANNEL_SUBSCRIPTION_FAILED", { matchId, status });
        } else {
          console.log("[CALL_SIGNAL] CHANNEL_STATUS", { matchId, status });
        }
      });
      subscribedChannels.set(matchId, channel);
    }

    return () => {
      for (const [id, ch] of subscribedChannels.entries()) {
        console.log("[CALL_STATE] subscription removed", { matchId: id, reason: "effect_cleanup" });
        supabase.removeChannel(ch);
      }
      subscribedChannels.clear();
      prevKeyRef.current = "";
    };
  }, [matchIds.join(","), userId]);
}

export function broadcastCallSignal(matchId: string, event: CallSignalEvent) {
  const existing = subscribedChannels.get(matchId);
  if (existing) {
    existing.send({
      type: "broadcast",
      event: "call-signal",
      payload: event,
    }).then((result) => {
      if (result !== "ok") {
        console.warn(`[CALL_SIGNAL] Client broadcast ${event.type} result=${result} matchId=${matchId}`);
      } else {
        console.log(`[CALL_SIGNAL] Client broadcast ${event.type} ok matchId=${matchId}`);
      }
    }).catch((err: any) => {
      console.error(`[CALL_SIGNAL] Client broadcast ${event.type} failed matchId=${matchId}:`, err?.message);
    });
    return;
  }

  const channelName = getChannelName(matchId);
  const tempChannel = supabase.channel(channelName, {
    config: { broadcast: { self: false } },
  });

  const timeout = setTimeout(() => {
    console.warn(`[CALL_SIGNAL] Temp channel subscribe timeout for ${event.type} matchId=${matchId}`);
    supabase.removeChannel(tempChannel);
  }, 5000);

  tempChannel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      clearTimeout(timeout);
      tempChannel.send({
        type: "broadcast",
        event: "call-signal",
        payload: event,
      }).then((result) => {
        console.log(`[CALL_SIGNAL] Temp channel broadcast ${event.type} result=${result} matchId=${matchId}`);
        setTimeout(() => supabase.removeChannel(tempChannel), 2000);
      }).catch((err: any) => {
        console.error(`[CALL_SIGNAL] Temp channel broadcast ${event.type} failed matchId=${matchId}:`, err?.message);
        supabase.removeChannel(tempChannel);
      });
    }
  });
}
