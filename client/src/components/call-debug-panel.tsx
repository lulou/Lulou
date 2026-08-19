import { useState, useEffect } from "react";
import { Copy, X } from "lucide-react";
import { callDebug, type CallDebugLog } from "@/lib/call-debug";

function Row({
  label,
  value,
  ok,
  bad,
}: {
  label: string;
  value: string;
  ok?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="flex justify-between items-baseline gap-2 min-h-[16px]">
      <span className="text-white/38 shrink-0">{label}</span>
      <span
        className={`text-right font-mono break-all leading-snug ${
          ok ? "text-green-400" : bad ? "text-red-400" : "text-white/80"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function Sep() {
  return <div className="border-t my-1" style={{ borderColor: "hsl(0 0% 100% / 0.08)" }} />;
}

function outcomeDot(outcome: CallDebugLog["outcome"]) {
  if (outcome === "connected") return "text-green-400";
  if (outcome === "failed") return "text-red-400";
  if (outcome === "ended" || outcome === "cancelled") return "text-white/40";
  return "text-amber-400";
}

function outcomeBadge(outcome: CallDebugLog["outcome"]) {
  if (outcome === "connected") return "bg-green-950 text-green-300 border-green-800";
  if (outcome === "failed") return "bg-red-950 text-red-300 border-red-800";
  if (outcome === "ended" || outcome === "cancelled") return "bg-white/5 text-white/40 border-white/10";
  return "bg-amber-950 text-amber-300 border-amber-800";
}

export function CallDebugPanel() {
  const [log, setLog] = useState<CallDebugLog>(() => ({ ...callDebug.get() }));
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const unsub = callDebug.subscribe(() => setLog({ ...callDebug.get() }));
    return unsub;
  }, []);

  if (!import.meta.env.DEV) return null;

  const copyAll = () => {
    const lines: string[] = [
      "=== LULOU CALL DEBUG ===",
      `Role:    ${log.isCaller ? "CALLER" : "CALLEE"}`,
      `Match:   ${log.callId}`,
      `Session: ${log.sessionId}`,
      `User:    ${log.myUserId}`,
      `Started: ${log.startedAt}`,
      "",
      "--- SETUP ---",
      `Media:   ${log.mediaStatus} (tier ${log.mediaTier}) ${log.mediaError ? "ERR=" + log.mediaError : ""}`,
      `Channel: ${log.channelStatus}${log.channelError ? " ERR=" + log.channelError : ""}`,
      "",
      "--- SIGNALING ---",
      log.isCaller
        ? [
            `Ready received: ${log.readyReceived}`,
            `Offer created:  ${log.offerCreated}`,
            `Offer sent:     ${log.offerSent}`,
            `Rollbacks:      ${log.rollbackCount}`,
            `Answer received:${log.answerReceived}`,
          ].join("\n")
        : [
            `Ready sent:   ${log.readySent}`,
            `Offer received:${log.offerReceived}`,
            `Answer sent:  ${log.answerSent}`,
          ].join("\n"),
      "",
      "--- ICE ---",
      `Sent: ${log.iceSent}  Received: ${log.iceReceived}`,
      `Types: host=${log.iceTypes.host} srflx=${log.iceTypes.srflx} relay=${log.iceTypes.relay}`,
      `TURN: ${log.iceHasTurn ? "YES" : "NO"}`,
      "",
      "--- STATE TIMELINES ---",
      `Signaling: ${log.signalingStates.join(" → ")}`,
      `ICE:       ${log.iceStates.join(" → ")}`,
      `PC:        ${log.pcStates.join(" → ")}`,
      "",
      "--- OUTCOME ---",
      `${log.outcome.toUpperCase()}${log.failureReason ? "\nReason: " + log.failureReason : ""}`,
      "",
      "--- EVENTS ---",
      ...log.events.map(e => `${e.t}  ${e.msg}`),
      "",
      "--- RAW WEBRTC LOGS ---",
      ...((typeof window !== "undefined" ? (window as any).webrtcLogs : null) ?? []),
    ];

    const text = lines.join("\n");

    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  };

  const fallbackCopy = (text: string) => {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.top = "-9999px";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    } catch {}
  };

  if (!expanded) {
    return (
      <button
        className="fixed top-12 left-2 z-[200] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-mono"
        style={{
          background: "hsl(0 0% 0% / 0.78)",
          border: "1px solid hsl(0 0% 100% / 0.14)",
          backdropFilter: "blur(8px)",
        }}
        onClick={() => setExpanded(true)}
        data-testid="call-debug-badge"
        aria-label="Open call debug panel"
      >
        <span className={`text-[13px] leading-none ${outcomeDot(log.outcome)}`}>●</span>
        <span className="text-white/60">DBG</span>
        {log.failureReason && <span className="text-red-400 font-bold">!</span>}
      </button>
    );
  }

  return (
    <div
      className="fixed top-10 left-1.5 right-1.5 z-[200] rounded-xl overflow-hidden"
      style={{ border: "1px solid hsl(0 0% 100% / 0.14)" }}
      data-testid="call-debug-panel"
    >
      {/* Sticky header */}
      <div
        className="flex items-center justify-between px-3 py-2 gap-2"
        style={{ background: "hsl(0 0% 6% / 0.99)", borderBottom: "1px solid hsl(0 0% 100% / 0.1)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[14px] leading-none shrink-0 ${outcomeDot(log.outcome)}`}>●</span>
          <span className="text-white font-bold tracking-widest text-[9px]">CALL DEBUG</span>
          <span
            className={`px-1.5 py-px rounded border text-[9px] font-bold shrink-0 ${outcomeBadge(log.outcome)}`}
          >
            {log.outcome.toUpperCase()}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={copyAll}
            className="flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] text-white/55 hover:text-white/90 transition-colors"
            style={{ borderColor: "hsl(0 0% 100% / 0.15)" }}
            data-testid="call-debug-copy"
          >
            <Copy className="w-3 h-3" />
            Copy all
          </button>
          <button
            onClick={() => setExpanded(false)}
            className="text-white/35 hover:text-white/70 transition-colors"
            aria-label="Close debug panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Scrollable body */}
      <div
        className="overflow-y-auto px-3 py-2 space-y-0.5 text-[11px] font-mono"
        style={{ background: "hsl(0 0% 4% / 0.97)", maxHeight: "72vh" }}
      >
        <Row label="Role"    value={log.isCaller ? "CALLER" : "CALLEE"} />
        <Row label="Match"   value={log.callId    ? log.callId.slice(0, 16)    : "—"} />
        <Row label="Session" value={log.sessionId ? log.sessionId.slice(0, 16) : "—"} />
        <Row label="User"    value={log.myUserId  ? log.myUserId.slice(0, 16)  : "—"} />

        <Sep />

        <Row
          label="Media"
          value={
            log.mediaStatus === "pending" ? "pending…"
            : log.mediaStatus === "ok"    ? `ok (tier ${log.mediaTier})`
            : `ERROR: ${log.mediaError}`
          }
          ok={log.mediaStatus === "ok"}
          bad={log.mediaStatus === "error"}
        />
        <Row
          label="Channel"
          value={log.channelStatus + (log.channelError ? "  " + log.channelError : "")}
          ok={log.channelStatus === "subscribed"}
          bad={log.channelStatus === "error" || log.channelStatus === "timeout"}
        />

        <Sep />

        {log.isCaller ? (
          <>
            <Row label="Ready rcvd"  value={log.readyReceived  ? "YES" : "waiting"} ok={log.readyReceived}  bad={!log.readyReceived  && log.outcome === "failed"} />
            <Row label="Offer sent"  value={log.offerSent      ? "YES" : "NO"}      ok={log.offerSent}      bad={!log.offerSent      && log.outcome === "failed"} />
            <Row label="Rollbacks"   value={String(log.rollbackCount)}                                       bad={log.rollbackCount > 0} />
            <Row label="Answer rcvd" value={log.answerReceived ? "YES" : "waiting"} ok={log.answerReceived} bad={!log.answerReceived && log.outcome === "failed"} />
          </>
        ) : (
          <>
            <Row label="Ready sent"  value={String(log.readySent)}                  ok={log.readySent > 0} />
            <Row label="Offer rcvd"  value={log.offerReceived  ? "YES" : "waiting"} ok={log.offerReceived}  bad={!log.offerReceived  && log.outcome === "failed"} />
            <Row label="Answer sent" value={log.answerSent     ? "YES" : "NO"}      ok={log.answerSent}     bad={!log.answerSent     && log.outcome === "failed"} />
          </>
        )}

        <Sep />

        <Row label="ICE sent"  value={String(log.iceSent)} />
        <Row label="ICE rcvd"  value={String(log.iceReceived)} />
        <Row
          label="Types"
          value={`H:${log.iceTypes.host} S:${log.iceTypes.srflx} R:${log.iceTypes.relay}`}
        />
        <Row
          label="TURN"
          value={log.iceHasTurn ? "YES ✓" : "NO — may fail on NAT"}
          ok={log.iceHasTurn}
          bad={!log.iceHasTurn && log.outcome === "failed"}
        />

        <Sep />

        <Row label="Signaling" value={log.signalingStates.slice(-5).join("→") || "—"} />
        <Row label="ICE"       value={log.iceStates.slice(-5).join("→")       || "—"} />
        <Row label="PC"        value={log.pcStates.slice(-5).join("→")        || "—"} />

        {!!log.failureReason && (
          <>
            <Sep />
            <div className="text-red-400 text-[10px] leading-snug break-all">
              {log.failureReason}
            </div>
          </>
        )}

        <Sep />

        <div className="text-white/28 text-[9px] mb-0.5">
          Events ({log.events.length}) — tap Copy all for complete log
        </div>
        <div className="space-y-px">
          {log.events.slice(-30).map((e, i) => (
            <div key={i} className="flex gap-1.5 text-[10px] leading-snug">
              <span className="text-white/22 shrink-0">{e.t}</span>
              <span className="text-white/65 break-all">{e.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
