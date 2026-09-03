import type { CSSProperties, ReactNode } from "react";

export type CommunicationControlState = "locked" | "available" | "used_paid" | "recording";

type CommunicationControlProps = {
  icon: ReactNode;
  label: string;
  state: CommunicationControlState;
  onClick: () => void;
  testId: string;
  ariaLabel: string;
  busy?: boolean;
};

const SURFACE_STYLES: Record<CommunicationControlState, CSSProperties> = {
  locked: {
    color: "hsl(32 12% 42%)",
    backgroundColor: "hsl(32 15% 88%)",
    borderColor: "hsl(32 12% 78%)",
  },
  available: {
    color: "hsl(38 38% 94%)",
    backgroundColor: "hsl(350 45% 34%)",
    borderColor: "hsl(350 45% 29%)",
    boxShadow: "0 5px 14px hsl(350 45% 24% / 0.18)",
  },
  used_paid: {
    color: "hsl(350 42% 36%)",
    backgroundColor: "hsl(350 32% 96%)",
    borderColor: "hsl(350 35% 65%)",
  },
  recording: {
    color: "hsl(38 38% 94%)",
    backgroundColor: "hsl(350 58% 45%)",
    borderColor: "hsl(350 58% 38%)",
    boxShadow: "0 5px 14px hsl(350 58% 35% / 0.22)",
  },
};

export function CommunicationControl({
  icon,
  label,
  state,
  onClick,
  testId,
  ariaLabel,
  busy = false,
}: CommunicationControlProps) {
  return (
    <div className="flex w-[58px] shrink-0 flex-col items-center gap-1">
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        aria-busy={busy}
        aria-disabled={state === "locked"}
        className="flex h-[50px] w-[50px] shrink-0 items-center justify-center rounded-2xl border transition-transform active:scale-90"
        style={SURFACE_STYLES[state]}
        data-testid={testId}
      >
        <span className="flex h-5 w-5 items-center justify-center [&>svg]:h-5 [&>svg]:w-5">
          {icon}
        </span>
      </button>
      <span
        className="max-w-full truncate text-center text-[10px] font-medium leading-3"
        style={{ color: state === "available" || state === "recording" ? "hsl(350 38% 34%)" : "hsl(32 10% 43%)" }}
      >
        {label}
      </span>
    </div>
  );
}