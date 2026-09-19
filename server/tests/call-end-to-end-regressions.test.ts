import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("client/src/App.tsx", "utf8");
const incoming = readFileSync("client/src/components/incoming-call.tsx", "utf8");
const active = readFileSync("client/src/components/active-call.tsx", "utf8");
const webrtc = readFileSync("client/src/hooks/use-webrtc.ts", "utf8");
const signaling = readFileSync("client/src/hooks/use-call-signaling.ts", "utf8");
const ringtone = readFileSync("client/src/hooks/use-call-ringtone.ts", "utf8");
const callAudio = readFileSync("client/src/lib/call-audio.ts", "utf8");
const appLayout = readFileSync("client/src/components/app-layout.tsx", "utf8");
const intent = readFileSync("client/src/pages/intent.tsx", "utf8");
const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
const routes = readFileSync("server/routes.ts", "utf8");
const storage = readFileSync("server/storage.ts", "utf8");
const migration = readFileSync("supabase/migrations/add_call_connected_at.sql", "utf8");

describe("end-to-end call regressions", () => {
  it("persists one session ID at call creation and requires it at answer", () => {
    expect(storage).toContain("const callSessionId = requestedSessionId || `call-${matchId}-${callStartedAt.getTime()}`");
    expect(storage).toContain("call_session_id: callSessionId");
    expect(storage).toContain('.eq("call_session_id", expectedSessionId)');
    expect(routes).toContain('return res.status(400).json({ message: "callSessionId is required" })');
  });

  it("mounts the fullscreen overlays globally and disables competing inline controls", () => {
    expect(app).toContain("<IncomingCallOverlay");
    expect(app).toContain("<ActiveCallOverlay");
    expect(matches).toContain("false && isCallRinging && !iAmCaller");
    expect(matches).toContain("false && isCallActive ? (");
  });

  it("keeps horizontal slide-to-answer at an 80 percent threshold with snap-back", () => {
    expect(incoming).toContain("maxDx * 0.8");
    expect(incoming).toContain('addEventListener("pointermove"');
    expect(incoming).toContain('addEventListener("touchmove"');
    expect(incoming).toContain('addEventListener("pointerup"');
    expect(incoming).toContain('addEventListener("touchend"');
    expect(incoming).toContain("snapBack");
    expect(incoming).toContain("releasePointer");
    const moveHandler = incoming.slice(
      incoming.indexOf("const move ="),
      incoming.indexOf("const end ="),
    );
    expect(moveHandler).not.toContain("doAnswer()");
  });

  it("routes incoming UI only from guarded live-session state", () => {
    expect(app).toContain("if (matchForIncoming)");
    expect(app).toContain("Never scan raw match rows here");
    expect(app).not.toContain("const forcedIncomingMatch =");
    expect(app).not.toContain("forced-incoming:");
    expect(app).toContain("if (activeCall.callAnswered === true) return null");
  });

  it("keeps the authoritative ringtone alive across overlay and tab transitions", () => {
    expect(ringtone).toContain('window.setInterval(() => startIncomingRingtone(sessionId), 500)');
    expect(ringtone).not.toContain('stopIncomingRingtone("effect_cleanup")');
    expect(callAudio).toContain("_ringtoneSessionId === sessionId");
    expect(appLayout).not.toContain("nav_tab_click");
    expect(intent).not.toContain("intent_page_mount");
    expect(app).toContain('stopAllNonVoiceCallAudio("no_authoritative_call")');
  });

  it("measures availability end to end and bounds stalled writes", () => {
    expect(matches).toContain("availability_click_at");
    expect(matches).toContain("availability_click_to_saved_ms");
    expect(matches).toContain("availability_click_to_ui_ms");
    expect(matches).toContain('controller.abort("availability_write_timeout")');
    expect(signaling).toContain("availability_realtime_received_at");
    expect(signaling).toContain("availability_ui_update_ms");
    expect(routes).toContain("availability_broadcast_ms");
    expect(routes).toContain("Prompt bookkeeping is not on the critical realtime path");
  });

  it("uses RTCPeerConnection.connectionState rather than ICE as connected authority", () => {
    const pcHandler = webrtc.slice(
      webrtc.indexOf("pc.onconnectionstatechange"),
      webrtc.indexOf("pc.oniceconnectionstatechange"),
    );
    const iceHandler = webrtc.slice(
      webrtc.indexOf("pc.oniceconnectionstatechange"),
      webrtc.indexOf('setConnectionState("connecting")', webrtc.indexOf("pc.oniceconnectionstatechange")),
    );
    expect(pcHandler).toContain('if (s === "connected")');
    expect(pcHandler).toContain('setConnectionState("connected")');
    expect(iceHandler).not.toContain('setConnectionState("connected")');
    expect(webrtc).toContain("call:${matchId}:${callSessionId}");
    expect(webrtc).toContain("msg.callSessionId !== callSessionId");
  });

  it("persists one authoritative connected time and derives the countdown from it", () => {
    expect(migration).toContain("call_connected_at TIMESTAMPTZ");
    expect(routes).toContain('/api/matches/:matchId/call/connected');
    expect(storage).toContain('.is("call_connected_at", null)');
    expect(active).toContain("Date.now() - connectedAtMs");
    expect(active).toContain("authoritativeConnectedAtMs");
    expect(active).toContain('/call/connected`');
    expect(signaling).toContain('event.type === "call:connected"');
  });

  it("retries connected-time persistence before failing a physical call", () => {
    expect(active).toContain("for (let attempt = 1; attempt <= 4");
    expect(active).toContain("transient persistence failure; retry scheduled");
    expect(active).toContain("500 * 2 ** (attempt - 1)");
    expect(active).not.toContain("connectedSyncInFlightRef.current = false;\n        finishCallRef.current?.(\"connection_failed\");");
  });

  it("offers a user-gesture fallback when remote audio autoplay is blocked", () => {
    expect(active).toContain("audioNeedsGesture");
    expect(active).toContain("button-enable-call-audio");
    expect(active).toContain("remote audio resumed by user gesture");
  });

  it("defers ICE restart until signaling returns to stable", () => {
    expect(webrtc).toContain("pendingIceRestartRef");
    expect(webrtc).toContain('s === "stable"');
    expect(webrtc).toContain("deferred retry now stable");
  });

  it("binds cancel and complete to the exact session and requires server-confirmed connection", () => {
    expect(storage).toContain('async cancelCall(matchId: string, userId: string, callSessionId: string)');
    expect(storage).toContain('options?.connected === true');
    expect(storage).toContain('callState === "ended"');
    expect(storage).toContain("authoritativeConnectedMs");
    expect(storage).toContain('.eq("call_session_id", callSessionId)');
  });

  it("fetches authenticated ICE configuration from the cross-origin API backend", () => {
    expect(webrtc).toContain('fetch(`${API_BASE}${path}`');
    expect(webrtc).toContain("headers: await getAuthHeaders()");
    expect(webrtc).toContain("requireApiBase(path)");
  });

  it("persists paid mode, media type, and payer instead of trusting completion input", () => {
    expect(storage).toContain("call_is_paid: !!isPaidCredit");
    expect(storage).toContain('call_media_type: isVideo ? "video" : "phone"');
    expect(storage).toContain("call_payer_id: isPaidCredit ? userId : null");
    expect(routes).toContain("persistedCallType");
    expect(routes).toContain("persistedPayerId");
    expect(routes).toContain("!priorIsPaid && persistedCallType === \"phone\" && priorCallStage === 0");
    expect(routes).toContain("reserveCallCredit(");
    expect(routes).toContain("consumeReservedCallCredit(callSessionId)");
    expect(routes).toContain("refundReservedCallCredit(callSessionId)");
    expect(storage).toContain("gt(callCredits.phoneCredits, 0)");
  });

  it("auto-ends at zero, exposes the red End Call control, and handles remote hangup", () => {
    expect(active).toContain('finishCallRef.current?.("timer_expired")');
    expect(active).toContain('data-testid="button-end-call"');
    expect(active).toContain("background: \"linear-gradient(145deg, hsl(0 70% 44%), hsl(0 65% 34%))\"");
    expect(active).toContain('finishCallRef.current?.("remote_hangup")');
  });

  it("uses the server TURN variables and does not suggest obsolete VITE_TURN names", () => {
    expect(routes).toContain("TURN_URLS || process.env.TURN_URL");
    expect(webrtc).toContain("configure TURN_URLS (or TURN_URL), TURN_USERNAME, and TURN_CREDENTIAL");
    expect(webrtc).not.toContain("add VITE_TURN_URL");
  });

  it("makes stale cleanup conditional on the exact inspected session and start time", () => {
    expect(routes).toContain('.eq("call_session_id", m.call_session_id)');
    expect(routes).toContain('.eq("call_started_at", m.call_started_at)');
    expect(routes).toContain(".eq(\"call_session_id\", row.call_session_id)");
    expect(routes).toContain(".eq(\"call_started_at\", row.call_started_at)");
    expect(routes).toContain('import { CALL_STALE_RINGING_MS } from "@shared/call-lifecycle"');
    expect(storage).toContain('import { CALL_STALE_RINGING_MS } from "@shared/call-lifecycle"');
    expect(app).toContain('import { CALL_STALE_RINGING_MS } from "@shared/call-lifecycle"');
    expect(routes).toContain("CALL_STALE_NEGOTIATING_MS");
    expect(routes).toContain("CALL_STALE_CONNECTED_MS");
  });

  it("does not re-ring a replaced call session", () => {
    expect(routes).toContain("call_session_id === match.callSessionId");
    expect(routes).toContain("select(\"call_answered,call_completed,call_initiator_id,call_started_at,call_session_id\")");
  });

  it("writes at most one call-history event per call session", () => {
    expect(routes).toContain("callSessionId: requestedSessionId");
    expect(routes).toContain('.update(`call-history:${requestedSessionId}`)');
    expect(routes).toContain('{ onConflict: "id", ignoreDuplicates: true }');
    expect(routes).toContain("deterministic call event already exists");
    expect(routes).not.toContain('.gte("created_at", new Date(new Date(preCancelStartedAt)');
  });

  it("derives TURN availability from effective filtered relay URLs", () => {
    expect(routes).toContain("const hasTurn = turnUrls.length > 0 && !!turnUsername && !!turnCredential");
    expect(routes).not.toContain("const hasTurn = !!(turnUrlsRaw && turnUsername && turnCredential)");
  });

  it("uses the authoritative counted completion result for voice-note unlock", () => {
    const completion = routes.slice(
      routes.indexOf('app.post("/api/matches/:matchId/call/complete"'),
      routes.indexOf('// face-call/accept'),
    );
    expect(completion).toContain("if (result.counted && !priorIsPaid && persistedCallType === \"phone\" && priorCallStage === 0)");
    expect(completion).not.toContain("connectedDurationMs >= 30_000");
  });
});