/**
 * CallDiagnosticsButton
 *
 * Floating pill button that compiles and copies the full WebRTC call
 * diagnostic report to clipboard after a call.
 *
 * Visibility rules:
 *   - Always shown in Vite DEV mode (import.meta.env.DEV === true)
 *   - Shown in production when localStorage key "lulou_diag" === "1"
 *     (set it from Safari Web Inspector or Xcode console: localStorage.setItem('lulou_diag','1'))
 *   - Never shown to normal users in production
 *
 * How to enable on iPhone for testing:
 *   1. Connect iPhone to Mac via USB.
 *   2. Open Safari → Develop → [your iPhone] → Lulou tab.
 *   3. In the JS console: localStorage.setItem('lulou_diag','1')  then reload.
 *   4. Make or receive a call. Button appears at the bottom of every screen.
 *   5. After the call tap "Copy Call Diagnostics".
 *   6. Paste into Notes / Mail / Slack to share.
 */

import { useState, useCallback, useEffect } from "react";
import { callDebug } from "@/lib/call-debug";

// ── Visibility gate ──────────────────────────────────────────────────────────
function isDiagEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try { return localStorage.getItem("lulou_diag") === "1"; } catch { return false; }
}

// ── Report builder ───────────────────────────────────────────────────────────
function buildReport(): string {
  const now = new Date().toISOString();
  const log = callDebug.get();
  const rawLogs: string[] = (typeof window !== "undefined" && Array.isArray((window as any).webrtcLogs))
    ? (window as any).webrtcLogs
    : [];

  // ── Structured summary ───────────────────────────────────────────────────
  const summary = [
    `=== LULOU CALL DIAGNOSTICS ===`,
    `Exported: ${now}`,
    ``,
    `── Call ──────────────────────────────────────────`,
    `callId:      ${log.callId || "(none)"}`,
    `sessionId:   ${log.sessionId || "(none)"}`,
    `myUserId:    ${log.myUserId ? log.myUserId.slice(0, 12) + "…" : "(none)"}`,
    `role:        ${log.isCaller ? "CALLER" : "CALLEE"}`,
    `callType:    ${log.isVideo ? "video" : "audio"}`,
    `startedAt:   ${log.startedAt || "(none)"}`,
    `outcome:     ${log.outcome}`,
    `connectedAt: ${log.connectedAt || "—"}`,
    ``,
    `── Media ─────────────────────────────────────────`,
    `mediaStatus: ${log.mediaStatus}`,
    `mediaTier:   ${log.mediaTier || "—"}   (1=full AEC, 2=AEC+NS, 3=AEC-only)`,
    `mediaError:  ${log.mediaError || "none"}`,
    ``,
    `── Signalling channel ────────────────────────────`,
    `channelStatus: ${log.channelStatus}`,
    `channelError:  ${log.channelError || "none"}`,
    ``,
    `── Offer/Answer ──────────────────────────────────`,
    `readySent:      ${log.readySent}`,
    `readyReceived:  ${log.readyReceived}`,
    `offerCreated:   ${log.offerCreated}`,
    `offerSent:      ${log.offerSent}`,
    `offerReceived:  ${log.offerReceived}`,
    `rollbackCount:  ${log.rollbackCount}`,
    `answerSent:     ${log.answerSent}`,
    `answerReceived: ${log.answerReceived}`,
    ``,
    `── ICE ───────────────────────────────────────────`,
    `iceSent:     ${log.iceSent}`,
    `iceReceived: ${log.iceReceived}`,
    `  host:  ${log.iceTypes.host}`,
    `  srflx: ${log.iceTypes.srflx}`,
    `  relay: ${log.iceTypes.relay}   ← must be > 0 if TURN is working`,
    `hasTURN:     ${log.iceHasTurn ? "YES ✓" : "NO ✗ — symmetric NAT will fail"}`,
    ``,
    `── State transitions ─────────────────────────────`,
    `signalingStates: ${log.signalingStates.join(" → ") || "(none)"}`,
    `iceStates:       ${log.iceStates.join(" → ") || "(none)"}`,
    `pcStates:        ${log.pcStates.join(" → ") || "(none)"}`,
    ``,
    `failureReason: ${log.failureReason || "none"}`,
    ``,
    `── Timeline ──────────────────────────────────────`,
    ...log.events.map(e => `  ${e.t}  ${e.msg}`),
    ``,
  ].join("\n");

  // ── Filtered raw console logs ────────────────────────────────────────────
  const FILTERS = [
    "CALL_AUDIO", "STREAM_AUDIT", "SCREECH_FIX", "FEEDBACK_FIX",
    "FINAL_AUDIO_FIX", "SELF_AUDIO_FIX", "CALL_AUDIO_ONLY",
    "CALL_FIX", "CALL_AUDIO_AUDIT", "NATIVE_AUDIO",
    "CALL_RINGTONE", "RING_DEBUG", "CALL_AUDIO_GUARD",
    "FINAL_CALL_FIX", "PHONE_AUDIO",
    "WebRTC", "CALL_CONNECT", "CALL_ANSWER", "CALL_TIMING",
    "CALL_SIGNAL", "SIGNAL_AUDIT", "CALLEE_FIX",
    "CALL_DEBUG", "CALL_CONTROLS", "CALL_UI",
  ];
  const filteredLogs = rawLogs.filter(line =>
    FILTERS.some(tag => line.includes(`[${tag}]`))
  );

  const rawSection = [
    `── Raw console logs (${filteredLogs.length} matching lines) ─────────`,
    ...filteredLogs,
    ``,
    `=== END OF REPORT ===`,
  ].join("\n");

  return summary + rawSection;
}

// ── iOS-safe clipboard copy ─────────────────────────────────────────────────
async function copyToClipboard(text: string): Promise<boolean> {
  // Modern path — works in iOS Safari 13.4+ when called from a user gesture.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to legacy path */ }
  }
  // Legacy path — works in older Safari and iOS web views.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// ── Component ────────────────────────────────────────────────────────────────
export function CallDiagnosticsButton() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [logCount, setLogCount] = useState(0);

  // Check visibility gate once on mount (and re-check if localStorage changes).
  useEffect(() => {
    setEnabled(isDiagEnabled());
    // Subscribe to callDebug updates so the log count badge stays live.
    const unsub = callDebug.subscribe(() => {
      const d = callDebug.get();
      setLogCount(d.events.length);
    });
    return unsub;
  }, []);

  const handleCopy = useCallback(async () => {
    const report = buildReport();
    const ok = await copyToClipboard(report);
    setStatus(ok ? "copied" : "failed");
    setTimeout(() => setStatus("idle"), 2500);
  }, []);

  if (!enabled) return null;

  const rawCount = typeof window !== "undefined" && Array.isArray((window as any).webrtcLogs)
    ? (window as any).webrtcLogs.length
    : 0;

  const label =
    status === "copied" ? "✓ Copied to clipboard" :
    status === "failed" ? "✗ Copy failed — try again" :
    `Copy Call Diagnostics  (${rawCount} logs · ${logCount} events)`;

  const bg =
    status === "copied" ? "#166534" :
    status === "failed" ? "#991b1b" :
    "#1e293b";

  return (
    <div
      style={{
        position: "fixed",
        bottom: 96,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        pointerEvents: "auto",
      }}
    >
      <button
        onClick={handleCopy}
        data-testid="button-copy-call-diagnostics"
        style={{
          background: bg,
          color: "#f8fafc",
          border: "1.5px solid rgba(255,255,255,0.18)",
          borderRadius: 24,
          padding: "9px 20px",
          fontSize: 13,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontWeight: 600,
          letterSpacing: 0.2,
          cursor: "pointer",
          whiteSpace: "nowrap",
          boxShadow: "0 4px 24px rgba(0,0,0,0.55)",
          transition: "background 0.2s ease",
          WebkitTapHighlightColor: "transparent",
          userSelect: "none",
        }}
      >
        {label}
      </button>
    </div>
  );
}
