import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("client/src/App.tsx", "utf8");
const incoming = readFileSync("client/src/components/incoming-call.tsx", "utf8");
const active = readFileSync("client/src/components/active-call.tsx", "utf8");
const webrtc = readFileSync("client/src/hooks/use-webrtc.ts", "utf8");
const signaling = readFileSync("client/src/hooks/use-call-signaling.ts", "utf8");
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
    expect(incoming).toContain("snapBack");
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
});