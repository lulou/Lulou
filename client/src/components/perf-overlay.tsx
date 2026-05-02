/**
 * PerfOverlay — dev-only mobile performance HUD.
 *
 * Fixed badge in the bottom-right corner, above the nav bar.
 * Polls every 2 seconds and displays:
 *   - DOM node count        (warn if > 1500 — scroll jank threshold on iPhone)
 *   - WebSocket channels    (warn if > 10  — each = open TCP conn to Supabase)
 *   - TanStack Query cache  (warn if > 25  — each entry = live subscriber)
 *   - JS heap used (MB)     (warn if > 150 — high-water mark on A-series)
 *   - Network RTT (ms)      (informational)
 *
 * Tap the badge to expand / collapse the detail panel.
 *
 * This component is NOT imported in production — the conditional
 * `import.meta.env.DEV` in App.tsx is eliminated by Vite's tree-shaker.
 */
import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";

interface Metrics {
  dom: number;
  channels: number;
  queries: number;
  memMb: number | null;
  rtt: number | null;
}

function snap(): Metrics {
  const mem = (performance as any).memory;
  const nav = navigator as any;
  return {
    dom: document.querySelectorAll("*").length,
    channels: supabase.getChannels().length,
    queries: queryClient.getQueryCache().getAll().length,
    memMb: mem ? Math.round(mem.usedJSHeapSize / 1_048_576) : null,
    rtt: nav.connection?.rtt ?? null,
  };
}

export function PerfOverlay() {
  const [open, setOpen] = useState(false);
  const [m, setM] = useState<Metrics>(() => snap());

  useEffect(() => {
    const id = setInterval(() => setM(snap()), 2000);
    return () => clearInterval(id);
  }, []);

  const warnDom  = m.dom > 1500;
  const warnChan = m.channels > 10;
  const warnQry  = m.queries > 25;
  const warnMem  = m.memMb !== null && m.memMb > 150;
  const anyWarn  = warnDom || warnChan || warnQry || warnMem;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "76px",
        right: "6px",
        zIndex: 9999,
        fontFamily: "ui-monospace,SFMono-Regular,monospace",
        fontSize: "11px",
        lineHeight: 1.55,
        userSelect: "none",
        pointerEvents: "auto",
      }}
    >
      {open && (
        <div
          style={{
            background: "rgba(10,10,10,0.92)",
            borderRadius: "8px",
            padding: "8px 11px",
            marginBottom: "4px",
            minWidth: "195px",
            boxShadow: "0 3px 14px rgba(0,0,0,0.6)",
            border: "1px solid #222",
          }}
        >
          <MetricRow label="DOM nodes"  val={m.dom}      warn={warnDom}  />
          <MetricRow label="WS channels" val={m.channels} warn={warnChan} red />
          <MetricRow label="TQ cached"  val={m.queries}  warn={warnQry}  />
          {m.memMb !== null && (
            <MetricRow label="Heap MB" val={m.memMb} warn={warnMem} />
          )}
          {m.rtt !== null && (
            <MetricRow label="RTT ms" val={m.rtt} warn={false} />
          )}
          <div
            style={{
              marginTop: 6,
              borderTop: "1px solid #2a2a2a",
              paddingTop: 4,
              color: "#555",
              fontSize: "10px",
            }}
          >
            DOM&gt;1500 · WS&gt;10 · TQ&gt;25 · Heap&gt;150
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: anyWarn ? "rgba(255,120,0,0.18)" : "rgba(0,0,0,0.78)",
          color: anyWarn ? "#f90" : "#5f5",
          border: `1px solid ${anyWarn ? "#f90" : "#2a2a2a"}`,
          borderRadius: "5px",
          padding: "2px 8px",
          cursor: "pointer",
          display: "block",
          marginLeft: "auto",
          fontFamily: "ui-monospace,SFMono-Regular,monospace",
          fontSize: "11px",
        }}
        data-testid="button-perf-overlay"
      >
        {anyWarn ? "⚠ PERF" : "PERF"} {m.channels}ch
      </button>
    </div>
  );
}

function MetricRow({
  label,
  val,
  warn,
  red = false,
}: {
  label: string;
  val: number;
  warn: boolean;
  red?: boolean;
}) {
  const warnColor = red ? "#f55" : "#f90";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 14,
        color: warn ? warnColor : "#5f5",
      }}
    >
      <span style={{ color: "#666" }}>{label}</span>
      <span style={{ fontWeight: warn ? "bold" : "normal" }}>{val}</span>
    </div>
  );
}
