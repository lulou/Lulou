/**
 * Lulou Guidance System — reusable floating tip component.
 *
 * Each tip appears once per device. After the user dismisses or performs
 * the action, it never shows again (localStorage-backed).
 *
 * Usage:
 *   const { shown, dismiss } = useLulouTip("mic_hold");
 *   <LulouTip tipKey="mic_hold" icon={<Mic />} onDismiss={dismiss}>
 *     Hold the mic to record a voice note
 *   </LulouTip>
 *
 * Tips are registered centrally below. Add new keys here and use them
 * wherever you need contextual onboarding guidance.
 */

import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";

// ── Tip key registry ────────────────────────────────────────────────────────
export type LulouTipKey =
  | "photos_swipe"
  | "mic_hold"
  | "release_to_send"
  | "swipe_like"
  | "speaker_tip"
  | "intention_wheel"
  | "plan_date"
  | "notifications";

const STORAGE_PREFIX = "lulou_tip_done_";

function getTipDone(key: LulouTipKey): boolean {
  try { return localStorage.getItem(STORAGE_PREFIX + key) === "1"; } catch { return false; }
}
function setTipDone(key: LulouTipKey): void {
  try { localStorage.setItem(STORAGE_PREFIX + key, "1"); } catch {}
}

// ── Hook ─────────────────────────────────────────────────────────────────────
export function useLulouTip(key: LulouTipKey): { shown: boolean; dismiss: () => void } {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!getTipDone(key)) {
      // Small delay so the tip doesn't flash during page hydration
      const t = setTimeout(() => setShown(true), 600);
      return () => clearTimeout(t);
    }
  }, [key]);

  const dismiss = () => {
    setTipDone(key);
    setShown(false);
  };

  return { shown, dismiss };
}

// ── Component ─────────────────────────────────────────────────────────────────
interface LulouTipProps {
  tipKey: LulouTipKey;
  icon?: ReactNode;
  children: ReactNode;
  onDismiss: () => void;
  autoHideMs?: number;
  position?: "top" | "bottom";
  className?: string;
}

export function LulouTip({
  icon,
  children,
  onDismiss,
  autoHideMs = 6000,
  position = "bottom",
  className = "",
}: LulouTipProps) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const show = setTimeout(() => setVisible(true), 40);
    const hide = setTimeout(() => handleDismiss(), autoHideMs);
    return () => { clearTimeout(show); clearTimeout(hide); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoHideMs]);

  const handleDismiss = () => {
    if (exiting) return;
    setExiting(true);
    setTimeout(() => onDismiss(), 380);
  };

  const translateY = position === "bottom" ? "translateY(8px)" : "translateY(-8px)";

  return (
    <div
      aria-live="polite"
      role="status"
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px 10px 12px",
        background: "hsl(var(--background))",
        border: "1px solid hsl(350 45% 52% / 0.18)",
        borderRadius: 16,
        boxShadow: "0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06)",
        opacity: visible && !exiting ? 1 : 0,
        transform: visible && !exiting ? "translateY(0)" : translateY,
        transition: exiting
          ? "opacity 0.35s ease, transform 0.35s cubic-bezier(0.32,0.72,0,1)"
          : "opacity 0.32s ease, transform 0.32s cubic-bezier(0.16,1,0.3,1)",
        pointerEvents: "auto",
        userSelect: "none",
        maxWidth: 300,
      }}
    >
      {icon && (
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "hsl(350 45% 52% / 0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: "hsl(350 45% 52%)",
          }}
        >
          {icon}
        </div>
      )}
      <span
        style={{
          flex: 1,
          fontSize: 13,
          lineHeight: 1.4,
          color: "hsl(var(--foreground))",
          fontWeight: 500,
        }}
      >
        {children}
      </span>
      <button
        aria-label="Dismiss tip"
        onClick={handleDismiss}
        style={{
          flexShrink: 0,
          width: 20,
          height: 20,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "hsl(var(--muted))",
          border: "none",
          cursor: "pointer",
          color: "hsl(var(--muted-foreground))",
        }}
      >
        <X style={{ width: 11, height: 11 }} />
      </button>
    </div>
  );
}
