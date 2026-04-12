import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CheckCircle2, XCircle, Loader2, Crown, ArrowRight, Gift, MessageSquare, Phone, Video } from "lucide-react";

type Phase = "verifying" | "active" | "error";

const ITEM_LABELS: Record<string, { label: string; description: string; icon: React.ReactNode }> = {
  "messages-5":  { label: "+5 Messages",      description: "5 extra messages have been added to your account.",           icon: <MessageSquare className="w-6 h-6 text-primary" /> },
  "extra-call":  { label: "Extra Call",        description: "An extra voice call has been added to your account.",         icon: <Phone className="w-6 h-6 text-primary" /> },
  "video-call":  { label: "Video Call",        description: "A video call credit has been added to your account.",         icon: <Video className="w-6 h-6 text-primary" /> },
  "undo-close":  { label: "Undo Last Close",   description: "You can now reopen the last profile you closed.",             icon: <Crown className="w-6 h-6 text-primary" /> },
  "membership":  { label: "Lulou Membership",  description: "Your membership is active. Benefits have been added.",        icon: <Crown className="w-6 h-6 text-primary" /> },
};

const MEMBERSHIP_PERKS = [
  "2 conversation extensions",
  "1 extra call",
  "1 video call",
  "1 undo last close",
];

export default function ExtrasSuccessPage() {
  const [, navigate] = useLocation();
  const [phase, setPhase] = useState<Phase>("verifying");
  const [itemId, setItemId] = useState<string>("");
  const [itemName, setItemName] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    const item = params.get("item") ?? "";
    setItemId(item);

    if (!sessionId) {
      setErrorMsg("Missing payment session. Please try again.");
      setPhase("error");
      return;
    }

    let tries = 0;
    const maxTries = 8;
    const interval = 2000;

    const verify = async () => {
      tries++;
      try {
        const res = await apiRequest("POST", "/api/stripe/extras-activate", { sessionId });
        const data = await res.json();

        if (res.ok && data.success) {
          setItemName(data.name ?? item);
          queryClient.invalidateQueries({ queryKey: ["/api/benefits"] });
          setPhase("active");
          return;
        }

        if (res.status === 402 && tries < maxTries) {
          setTimeout(verify, interval);
        } else {
          setErrorMsg(data.message ?? "Payment verification failed. If you were charged, contact support.");
          setPhase("error");
        }
      } catch {
        if (tries < maxTries) {
          setTimeout(verify, interval * 1.5);
        } else {
          setErrorMsg("Network error. Please check your connection and try again.");
          setPhase("error");
        }
      }
    };

    verify();
  }, []);

  const info = ITEM_LABELS[itemId];
  const isMembership = itemId === "membership";

  return (
    <div className="min-h-screen bg-background">
      <div className="flex items-center gap-2 px-5 pt-5 pb-2 max-w-md mx-auto">
        <Crown className="w-5 h-5 text-primary" />
        <span className="font-serif font-semibold text-base">Lulou Extras</span>
      </div>

      <div className="max-w-md mx-auto px-5 py-4 space-y-5">

        {phase === "verifying" && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
            <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Loader2 className="w-9 h-9 text-primary animate-spin" />
            </div>
            <div className="text-center">
              <h1 className="font-serif text-2xl font-bold mb-2">Confirming payment…</h1>
              <p className="text-sm text-muted-foreground">Verifying your purchase and adding it to your account.</p>
            </div>
          </div>
        )}

        {phase === "active" && (
          <>
            <div className="flex items-center gap-3 pt-2">
              <div className="w-12 h-12 rounded-full flex items-center justify-center shrink-0 bg-primary/10 border border-primary/25">
                <CheckCircle2 className="w-6 h-6 text-green-400" />
              </div>
              <div>
                <h1 className="font-serif text-xl font-bold">
                  {isMembership ? "Membership activated!" : "Added to your account!"}
                </h1>
                <p className="text-sm text-muted-foreground">{itemName || info?.label}</p>
              </div>
            </div>

            <div
              className="rounded-2xl p-5 space-y-3"
              style={{ background: "hsl(350 45% 52% / 0.05)", border: "1px solid hsl(350 45% 52% / 0.2)" }}
              data-testid="extras-success-card"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  {info?.icon ?? <Gift className="w-5 h-5 text-primary" />}
                </div>
                <div>
                  <p className="font-semibold text-sm">{itemName || info?.label}</p>
                  <p className="text-xs text-muted-foreground">{info?.description}</p>
                </div>
              </div>

              {isMembership && (
                <ul className="space-y-1.5 pt-1 pl-1">
                  {MEMBERSHIP_PERKS.map(perk => (
                    <li key={perk} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="w-1 h-1 rounded-full bg-primary shrink-0" />
                      {perk}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div
              className="flex items-start gap-3 p-4 rounded-2xl"
              style={{ background: "hsl(155 25% 50% / 0.07)", border: "1px solid hsl(155 25% 50% / 0.2)" }}
            >
              <Gift className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">
                {isMembership
                  ? "Your benefits are now active and can be used across all your conversations."
                  : "This extra is saved to your account and can be used in any conversation from the chat screen."}
              </p>
            </div>

            <button
              className="w-full py-4 rounded-2xl font-bold text-base flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
              style={{ background: "hsl(350 45% 52%)", color: "white", boxShadow: "0 4px 16px hsl(350 45% 40% / 0.35)" }}
              onClick={() => navigate("/matches")}
              data-testid="button-extras-continue"
            >
              Go to Matches
              <ArrowRight className="w-5 h-5" />
            </button>

            <p className="text-center text-xs text-muted-foreground pb-6">
              You can view all your available extras from your profile at any time.
            </p>
          </>
        )}

        {phase === "error" && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
            <div className="w-20 h-20 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center">
              <XCircle className="w-9 h-9 text-destructive" />
            </div>
            <div className="text-center">
              <h1 className="font-serif text-2xl font-bold mb-2">Something went wrong</h1>
              <p className="text-sm text-muted-foreground mb-6">{errorMsg}</p>
            </div>
            <button
              className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm"
              onClick={() => navigate("/profile")}
              data-testid="button-extras-error-back"
            >
              Back to profile
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
