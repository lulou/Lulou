import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Phone, Video, Mic, Check, Sparkles } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

export type PurchaseFeature = "phone" | "video" | "mic";

interface PackOption {
  id: string;
  name: string;
  detail: string;
  price: string;
  best?: boolean;
}

const PHONE_PACKS: PackOption[] = [
  { id: "starter-pack",    name: "Starter",    detail: "1 phone call",          price: "$4.99" },
  { id: "connection-pack", name: "Connection", detail: "3 phone calls",          price: "$12.99" },
  { id: "premium-pack",    name: "Premium",    detail: "5 phone calls",          price: "$19.99", best: true },
];

const VIDEO_PACKS: PackOption[] = [
  { id: "video-starter",        name: "Video Starter",    detail: "1 video call credit",    price: "$6.99" },
  { id: "chemistry-pack",       name: "Chemistry",        detail: "3 phone + 1 video call", price: "$16.99" },
  { id: "deep-connection-pack", name: "Deep Connection",  detail: "5 phone + 3 video calls", price: "$27.99", best: true },
];

const MIC_PACK: PackOption = {
  id: "voice-notes-unlock",
  name: "Voice Notes Unlock",
  detail: "Send & receive voice messages in all chats — one-time unlock.",
  price: "$4.99",
};

const FEATURE_META: Record<PurchaseFeature, {
  Icon: React.ElementType;
  color: string;
  title: string;
  subtitle: string;
  packs: PackOption[];
}> = {
  phone: {
    Icon: Phone,
    color: "rgb(34,197,94)",
    title: "Phone Call Credits",
    subtitle: "Call any match immediately — 15 minutes per credit. No message limit required.",
    packs: PHONE_PACKS,
  },
  video: {
    Icon: Video,
    color: "rgb(99,102,241)",
    title: "Video Call Credits",
    subtitle: "Start a 10-minute video call with any match immediately.",
    packs: VIDEO_PACKS,
  },
  mic: {
    Icon: Mic,
    color: "rgb(34,197,94)",
    title: "Voice Notes",
    subtitle: "Send warm, personal voice messages in any chat.",
    packs: [MIC_PACK],
  },
};

interface PurchasePromptProps {
  feature: PurchaseFeature | null;
  onClose: () => void;
  returnPath?: string;
}

export function PurchasePrompt({ feature, onClose, returnPath }: PurchasePromptProps) {
  const [loading, setLoading] = useState<string | null>(null);

  const startCheckout = async (itemId: string) => {
    setLoading(itemId);
    try {
      const cancelPath = returnPath || window.location.pathname;
      const res = await apiRequest("POST", "/api/stripe/extras-checkout", { itemId, returnPath: cancelPath });
      const data = await res.json();
      if (data?.url) { sessionStorage.setItem("lulou_stripe_checkout", "1"); window.location.href = data.url; }
    } catch {
      // silently fall back — user stays on page
    } finally {
      setLoading(null);
    }
  };

  const meta = feature ? FEATURE_META[feature] : null;

  return (
    <Sheet open={!!feature} onOpenChange={open => { if (!open) onClose(); }}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl px-5 pb-8 pt-5 max-w-lg mx-auto"
        data-testid="purchase-prompt-sheet"
      >
        {meta && (
          <>
            <SheetHeader className="mb-4">
              <div className="flex items-center gap-3 mb-1">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                  style={{ background: `${meta.color}18`, border: `1.5px solid ${meta.color}40` }}
                >
                  <meta.Icon
                    className="w-5 h-5"
                    style={{ color: meta.color, filter: `drop-shadow(0 0 4px ${meta.color}90)` }}
                  />
                </div>
                <div>
                  <SheetTitle className="text-base leading-tight">{meta.title}</SheetTitle>
                  <SheetDescription className="text-xs mt-0.5 leading-snug">
                    {meta.subtitle}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="space-y-2.5 mb-5">
              {meta.packs.map(pack => (
                <div
                  key={pack.id}
                  className="relative flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3"
                  style={pack.best ? { borderColor: `${meta.color}50`, background: `${meta.color}06` } : undefined}
                  data-testid={`pack-option-${pack.id}`}
                >
                  {pack.best && (
                    <span
                      className="absolute -top-2 start-4 text-[10px] font-bold px-2 py-0.5 rounded-full"
                      style={{ background: meta.color, color: "#fff" }}
                    >
                      Best Value
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-tight">{pack.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{pack.detail}</p>
                  </div>
                  <Button
                    size="sm"
                    className="shrink-0 min-w-[80px]"
                    style={pack.best ? { background: meta.color, color: "#fff", border: "none" } : undefined}
                    variant={pack.best ? "default" : "outline"}
                    disabled={loading === pack.id}
                    onClick={() => startCheckout(pack.id)}
                    data-testid={`button-buy-${pack.id}`}
                  >
                    {loading === pack.id ? (
                      <span className="flex items-center gap-1.5">
                        <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                        …
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <Sparkles className="w-3 h-3" />
                        {pack.price}
                      </span>
                    )}
                  </Button>
                </div>
              ))}
            </div>

            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={onClose}
              data-testid="button-not-now"
            >
              Not now
            </Button>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
