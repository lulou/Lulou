import { Mic } from "lucide-react";

import { LULOU_SELECTED_ACCENT } from "@/lib/lulou-action-style";

type PostCallMilestoneProps = {
  onContinue: () => void;
  testId: string;
  buttonTestId: string;
};

export function PostCallMilestone({
  onContinue,
  testId,
  buttonTestId,
}: PostCallMilestoneProps) {
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/20 px-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
    >
      <div
        className="w-full max-w-sm rounded-3xl border px-7 py-8 text-center"
        style={{
          background: "hsl(var(--background))",
          borderColor: "rgba(119, 56, 70, 0.22)",
          boxShadow: "0 18px 50px rgba(53, 21, 32, 0.16)",
        }}
      >
        <div
          className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full"
          style={{
            background: "rgba(119, 56, 70, 0.09)",
            boxShadow: "0 0 24px rgba(119, 56, 70, 0.10)",
          }}
          aria-hidden="true"
        >
          <Mic className="h-7 w-7" style={{ color: LULOU_SELECTED_ACCENT }} />
        </div>

        <h2
          id={`${testId}-title`}
          className="font-serif text-2xl font-semibold tracking-tight text-foreground"
        >
          First call complete
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          You’ve reached the next stage of your connection. Voice notes are now unlocked.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
          Keep getting to know each other between calls.
        </p>

        <button
          type="button"
          className="mt-7 w-full rounded-2xl px-5 py-3 text-sm font-semibold text-[#fff7e9] transition-transform active:scale-[0.98]"
          style={{ background: LULOU_SELECTED_ACCENT }}
          onClick={onContinue}
          data-testid={buttonTestId}
        >
          Continue
        </button>
      </div>
    </div>
  );
}