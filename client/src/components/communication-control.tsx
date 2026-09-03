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

const ICON_STYLES: Record<CommunicationControlState, CSSProperties> = {
  locked: {
    color: "hsl(32 12% 42%)",
    opacity: 0.82,
  },
  available: {
    color: "hsl(350 45% 34%)",
  },
  used_paid: {
    color: "hsl(350 42% 36%)",
    opacity: 0.88,
  },
  recording: {
    color: "hsl(350 58% 45%)",
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
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-busy={busy}
      aria-disabled={state === "locked"}
      className="flex min-h-11 w-[58px] shrink-0 flex-col items-center justify-center gap-1 border-0 bg-transparent p-0 transition-transform active:scale-90"
      style={ICON_STYLES[state]}
      data-testid={testId}
    >
      <span className="flex h-5 w-5 items-center justify-center [&>svg]:h-5 [&>svg]:w-5">
        {icon}
      </span>
      <span
        className="max-w-full truncate text-center text-[10px] font-medium leading-3"
      >
        {label}
      </span>
    </button>
  );
}
