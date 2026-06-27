import { useState, useEffect } from "react";
import { subscribeDebug, type PurchaseDebugInfo } from "@/lib/purchase-service";

// ── PurchaseDebugPanel ────────────────────────────────────────────────────────
// Only renders in development builds (import.meta.env.DEV).
// Subscribes to the universal purchase service debug state and shows a
// fixed overlay at the bottom of the screen after any purchase attempt.
// Mount once in App.tsx — works for all purchase surfaces automatically.

export function PurchaseDebugPanel() {
  const [info, setInfo] = useState<PurchaseDebugInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    return subscribeDebug(next => {
      if (next) setDismissed(false);
      setInfo(next);
    });
  }, []);

  if (!import.meta.env.DEV) return null;
  if (!info || dismissed) return null;

  return (
    <div
      style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 99999,
        background: "rgba(0,0,0,0.94)", borderTop: "2px solid rgba(255,200,0,0.55)",
        padding: "10px 14px 18px", fontFamily: "monospace", fontSize: 11,
        color: "#ffd700", lineHeight: 1.75, wordBreak: "break-all",
        maxHeight: "48vh", overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontWeight: 900, fontSize: 12, color: "#fff", letterSpacing: "0.12em" }}>
          🛠 PURCHASE DEBUG — dev only
        </span>
        <button
          onClick={() => setDismissed(true)}
          style={{ background: "none", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer", fontSize: 14, padding: "0 4px" }}
        >
          ✕
        </button>
      </div>

      <Row label="product selected" value={info.product} />
      <Row label="API_BASE" value={info.apiBase} />
      <Row label="checkout endpoint" value={info.endpoint} />
      <Row label="auth token present" value={info.hasToken} />
      <Row label="HTTP status" value={info.status} />

      <div>
        <strong style={{ color: "#fff" }}>response body:</strong>{" "}
        <span style={{ color: "#ffd700" }}>{info.body || "(waiting)"}</span>
      </div>

      {info.sessionId && <Row label="checkout session ID" value={info.sessionId} />}

      {info.redirectUrl ? (
        <div>
          <strong style={{ color: "#4ade80" }}>redirect URL:</strong>{" "}
          <span style={{ color: "#4ade80" }}>{info.redirectUrl.slice(0, 120)}</span>
        </div>
      ) : (
        <Row label="redirect URL" value="(none yet)" />
      )}

      {info.status !== null && !info.error && !info.redirectUrl && (
        <Row label="payment confirmed" value={false} />
      )}
      {info.redirectUrl && !info.error && (
        <Row label="payment confirmed" value="redirecting to Stripe →" />
      )}

      {info.error ? (
        <div>
          <strong style={{ color: "#f87171" }}>error:</strong>{" "}
          <span style={{ color: "#f87171" }}>{info.error}</span>
        </div>
      ) : (
        <Row label="entitlement granted" value={info.redirectUrl ? "after Stripe payment ✓" : "pending"} />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number | boolean | null }) {
  const color =
    typeof value === "boolean"
      ? value ? "#4ade80" : "#f87171"
      : "#ffd700";
  return (
    <div>
      <strong style={{ color: "#fff" }}>{label}:</strong>{" "}
      <span style={{ color }}>{value === null ? "pending…" : String(value)}</span>
    </div>
  );
}
