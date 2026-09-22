import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type JourneyCompletionResponse = {
  complete: boolean;
  acknowledged: boolean;
};

export type JourneyCompletionExperienceProps = {
  matchId: string;
  matchingSlots: string[];
  labelForSlot: (slot: string) => string;
  idSuffix?: string;
  t: (key: any) => string;
};

/**
 * The quiet final milestone shown after both people have exchanged numbers.
 * The server remains the source of truth for whether the milestone is earned
 * and whether the acknowledgement has already been recorded.
 */
export function JourneyCompletionExperience({
  matchId,
  matchingSlots,
  labelForSlot,
  idSuffix = "",
  t,
}: JourneyCompletionExperienceProps) {
  const id = (base: string) => (idSuffix ? `${base}-${idSuffix}` : base);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [acknowledgedLocally, setAcknowledgedLocally] = useState(false);

  const { data, isLoading } = useQuery<JourneyCompletionResponse>({
    queryKey: ["/api/matches", matchId, "journey-completion"],
    enabled: Boolean(matchId),
  });

  const acknowledge = useMutation({
    mutationFn: async () => {
      await apiRequest(
        "POST",
        `/api/matches/${matchId}/journey-completion/acknowledge`,
        {},
      );
    },
    onSuccess: () => {
      setAcknowledgedLocally(true);
      setSheetOpen(false);
    },
  });

  const acknowledged = Boolean(data?.acknowledged || acknowledgedLocally);

  useEffect(() => {
    if (data?.complete && !acknowledged) {
      setSheetOpen(true);
    }
  }, [acknowledged, data?.complete]);

  if (isLoading || !data?.complete) {
    return null;
  }

  return (
    <>
      {acknowledged && (
        <Card
          className="journey-completion-card border-primary/20 bg-primary/[0.045] p-5 text-center shadow-sm sm:p-6"
          data-testid={id("journey-completion-card")}
        >
          <div className="mx-auto max-w-md space-y-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary/75">
                {t("journey_completion_title")}
              </p>
              <p className="text-sm leading-relaxed text-foreground/75">
                {t("journey_completion_description")}
              </p>
            </div>

            <div
              className="grid grid-cols-4 gap-1.5 border-y border-primary/10 py-4"
              data-testid={id("journey-completion-progress")}
            >
              {["Match", "Chat", "1st Call", "Meet"].map((step) => (
                <div key={step} className="space-y-1.5">
                  <div className="mx-auto flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <span aria-hidden="true" className="text-[10px] leading-none">✓</span>
                  </div>
                  <p className="text-[10px] font-medium text-primary">{step}</p>
                </div>
              ))}
            </div>

            {matchingSlots.length > 0 && (
              <div
                className="flex flex-wrap justify-center gap-2 border-t border-primary/10 pt-4"
                data-testid={id("journey-completion-matching-slots")}
              >
                {matchingSlots.map((slot) => (
                  <span
                    key={slot}
                    className="rounded-full border border-primary/15 bg-background/60 px-3 py-1.5 text-xs text-foreground/75"
                    data-testid={id(`journey-completion-slot-${slot}`)}
                  >
                    {labelForSlot(slot)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      <Sheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (open || acknowledged) setSheetOpen(open);
        }}
      >
        <SheetContent
          side="bottom"
          className="border-primary/15 bg-[#fbf7f0] px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-8 text-foreground sm:mx-auto sm:mb-5 sm:max-w-lg sm:rounded-3xl sm:border"
          data-testid={id("journey-completion-sheet")}
        >
          <SheetHeader className="mx-auto max-w-sm gap-3 text-center">
            <SheetTitle
              className="font-serif text-3xl font-normal tracking-[-0.02em] text-[#641f31]"
              data-testid={id("journey-completion-congratulations")}
            >
              {t("journey_completion_congratulations")}
            </SheetTitle>
            <SheetDescription
              className="text-base leading-relaxed text-foreground/75"
              data-testid={id("journey-completion-message")}
            >
              <span className="block font-medium text-foreground">
                {t("journey_completion_complete")}
              </span>
              <span className="mt-3 block">
                {t("journey_completion_connected")}
              </span>
              <span className="mt-3 block italic text-[#641f31]/80">
                {t("journey_completion_real")}
              </span>
            </SheetDescription>
          </SheetHeader>

          <div className="mx-auto mt-7 max-w-sm">
            <Button
              className="communication-wine-fill w-full"
              onClick={() => acknowledge.mutate()}
              disabled={acknowledge.isPending}
              data-testid={id("journey-completion-continue")}
            >
              {acknowledge.isPending
                ? "..."
                : t("journey_completion_continue")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export default JourneyCompletionExperience;