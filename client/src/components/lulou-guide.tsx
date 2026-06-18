import { useState, useEffect, useCallback, useRef } from "react";
import { isGuideSeen, markGuideSeen } from "@/lib/guide-store";

const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

export interface LulouGuideProps {
  guideKey: string;
  userId: string | undefined;
  icon?: string;
  title: string;
  body: string;
  delay?: number;
  autoDismissMs?: number;
  zIndex?: number;
}

export function LulouGuide({
  guideKey,
  userId,
  icon,
  title,
  body,
  delay = 900,
  autoDismissMs = 4600,
  zIndex = 45,
}: LulouGuideProps) {
  const [phase, setPhase] = useState<"idle" | "enter" | "visible" | "exit" | "gone">("idle");
  const markedRef = useRef(false);

  const dismiss = useCallback(() => {
    setPhase("exit");
    const dur = prefersReducedMotion ? 50 : 360;
    setTimeout(() => setPhase("gone"), dur);
  }, []);

  useEffect(() => {
    if (!userId) return;
    if (isGuideSeen(userId, guideKey)) return;

    const showTimer = setTimeout(() => {
      setPhase("enter");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setPhase("visible")),
      );
    }, delay);

    return () => clearTimeout(showTimer);
  }, [userId, guideKey, delay]);

  useEffect(() => {
    if (phase !== "visible") return;
    if (!markedRef.current) {
      markGuideSeen(userId, guideKey);
      markedRef.current = true;
    }
    const t = setTimeout(dismiss, autoDismissMs);
    return () => clearTimeout(t);
  }, [phase, userId, guideKey, autoDismissMs, dismiss]);

  if (phase === "idle" || phase === "gone") return null;

  const isVisible = phase === "visible";
  const dur = prefersReducedMotion ? "80ms" : "420ms";
  const curve = "cubic-bezier(0.34, 1.08, 0.64, 1)";

  return (
    <div
      className="fixed left-1/2 pointer-events-none"
      style={{
        bottom: "calc(84px + env(safe-area-inset-bottom, 0px))",
        transform: "translateX(-50%)",
        width: "min(304px, calc(100vw - 48px))",
        zIndex,
      }}
      data-testid={`guide-card-${guideKey}`}
    >
      <div
        role="status"
        aria-live="polite"
        onClick={dismiss}
        className="pointer-events-auto cursor-pointer select-none"
        style={{
          opacity: isVisible ? 1 : 0,
          transform: isVisible
            ? "translateY(0) scale(1)"
            : "translateY(16px) scale(0.94)",
          transition: `opacity ${dur} ease, transform ${dur} ${curve}`,
        }}
      >
        <div
          className="rounded-[20px] px-5 pt-4 pb-3.5 text-center backdrop-blur-xl"
          style={{
            background: "hsl(var(--background) / 0.93)",
            border: "1px solid hsl(var(--border) / 0.45)",
            boxShadow:
              "0 4px 28px rgba(0,0,0,0.09), 0 1px 4px rgba(0,0,0,0.05)",
          }}
        >
          {icon && (
            <p className="text-xl mb-1 leading-none" aria-hidden="true">
              {icon}
            </p>
          )}

          <p
            className="font-serif text-[15px] font-bold tracking-tight text-foreground leading-snug"
          >
            {title}
          </p>

          <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">
            {body}
          </p>

          <button
            onClick={e => {
              e.stopPropagation();
              dismiss();
            }}
            className="mt-2.5 text-[12px] font-medium tracking-wide text-primary/60 hover:text-primary transition-colors"
            data-testid={`guide-dismiss-${guideKey}`}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

export interface LulouGuidePreviewProps {
  icon?: string;
  title: string;
  body: string;
}

export function LulouGuidePreview({ icon, title, body }: LulouGuidePreviewProps) {
  return (
    <div
      className="rounded-[18px] px-5 pt-4 pb-3.5 text-center"
      style={{
        background: "hsl(var(--background))",
        border: "1px solid hsl(var(--border) / 0.5)",
        boxShadow: "0 2px 16px rgba(0,0,0,0.06)",
      }}
    >
      {icon && (
        <p className="text-xl mb-1 leading-none" aria-hidden="true">
          {icon}
        </p>
      )}
      <p className="font-serif text-[15px] font-bold tracking-tight text-foreground leading-snug">
        {title}
      </p>
      <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">
        {body}
      </p>
    </div>
  );
}
