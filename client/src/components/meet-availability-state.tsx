import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, Check, Clock, PhoneForwarded } from "lucide-react";
import type { MeetAvailabilityResolution } from "@shared/meet-availability";

type Props = {
  resolution: MeetAvailabilityResolution;
  otherName: string;
  labelForSlot: (slot: string) => string;
  onAccept: () => void;
  onChooseAnother: () => void;
  onUpdate: () => void;
  onExchangeNumber: () => void;
  accepting: boolean;
  idSuffix?: string;
  t: (key: any) => string;
};

function SlotList({
  slots,
  labelForSlot,
  variant = "outline",
}: {
  slots: string[];
  labelForSlot: (slot: string) => string;
  variant?: "outline" | "secondary";
}) {
  return (
    <div className="flex flex-wrap gap-1.5 justify-center">
      {slots.map((slot) => (
        <Badge key={slot} variant={variant} className="text-xs">
          {labelForSlot(slot)}
        </Badge>
      ))}
    </div>
  );
}

export function MeetAvailabilityStatePanel({
  resolution,
  otherName,
  labelForSlot,
  onAccept,
  onChooseAnother,
  onUpdate,
  onExchangeNumber,
  accepting,
  idSuffix = "",
  t,
}: Props) {
  const id = (base: string) => idSuffix ? `${base}-${idSuffix}` : base;

  if (resolution.state === "other_only") {
    return (
      <div className="space-y-3" data-testid={id("meet-availability-other-only")}>
        <div className="space-y-1">
          <Calendar className="w-5 h-5 text-primary mx-auto" />
          <p className="font-medium text-sm">
            {t("their_availability_lbl").replace("{name}", otherName)}
          </p>
        </div>
        <SlotList slots={resolution.otherAvailability} labelForSlot={labelForSlot} />
        <div className="grid grid-cols-1 gap-2">
          <Button
            size="sm"
            className="communication-wine-fill w-full"
            onClick={onAccept}
            disabled={accepting}
            data-testid={id("button-accept-meet-availability")}
          >
            <Check className="w-4 h-4 me-2" />
            {accepting ? t("meet_accepting") : t("accept")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={onChooseAnother}
            disabled={accepting}
            data-testid={id("button-choose-another-meet-availability")}
          >
            <Clock className="w-4 h-4 me-2" />
            {t("choose_another_time")}
          </Button>
        </div>
      </div>
    );
  }

  if (resolution.state === "both_match") {
    return (
      <div className="space-y-3" data-testid={id("meet-availability-both-match")}>
        <div className="space-y-1">
          <Check className="w-5 h-5 text-primary mx-auto" />
          <p className="font-medium text-sm">{t("meet_time_agreed")}</p>
        </div>
        <SlotList slots={resolution.matchingAvailability} labelForSlot={labelForSlot} />
        <div className="flex flex-col gap-2 items-center">
          <Button size="sm" className="communication-wine-fill" onClick={onExchangeNumber} data-testid={id("button-exchange-number")}>
            <PhoneForwarded className="w-4 h-4 me-2" /> {t("exchange_number_btn")}
          </Button>
          <Button size="sm" variant="outline" onClick={onUpdate} data-testid={id("button-update-availability")}>
            <Calendar className="w-4 h-4 me-2" /> {t("update_availability_btn")}
          </Button>
        </div>
      </div>
    );
  }

  if (resolution.state === "both_mismatch") {
    return (
      <div className="space-y-3" data-testid={id("meet-availability-both-mismatch")}>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("your_availability_lbl")}</p>
          <SlotList slots={resolution.selfAvailability} labelForSlot={labelForSlot} variant="secondary" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("their_availability_lbl").replace("{name}", otherName)}</p>
          <SlotList slots={resolution.otherAvailability} labelForSlot={labelForSlot} />
        </div>
        <p className="text-xs text-muted-foreground">{t("no_matching_times")}</p>
        <Button size="sm" variant="outline" onClick={onUpdate} data-testid={id("button-update-availability")}>
          <Calendar className="w-4 h-4 me-2" /> {t("update_availability_btn")}
        </Button>
      </div>
    );
  }

  if (resolution.state === "self_only") {
    return (
      <div className="space-y-3" data-testid={id("meet-availability-self-only")}>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("your_availability_lbl")}</p>
          <SlotList slots={resolution.selfAvailability} labelForSlot={labelForSlot} variant="secondary" />
        </div>
        <p className="text-xs text-muted-foreground">{t("waiting_for_their_avail").replace("{name}", otherName)}</p>
        <Button size="sm" variant="outline" onClick={onUpdate} data-testid={id("button-update-availability")}>
          <Calendar className="w-4 h-4 me-2" /> {t("update_availability_btn")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid={id("meet-availability-none-submitted")}>
      <Check className="w-5 h-5 text-primary mx-auto" />
      <p className="font-medium text-sm">{t("all_calls_completed")}</p>
      <p className="text-xs text-muted-foreground">{t("meet_share_prompt")}</p>
      <Button size="sm" className="communication-wine-fill" onClick={onChooseAnother} data-testid={id("button-ready-to-meet")}>
        <Calendar className="w-4 h-4 me-2" /> {t("share_availability_btn")}
      </Button>
    </div>
  );
}