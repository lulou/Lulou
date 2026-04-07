import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Sparkles, Zap, CheckCircle2, XCircle, Loader2, Gift } from "lucide-react";

type Phase = "verifying" | "success" | "error";

type SuccessData = {
  elevateType: "elevate" | "super_elevate";
  quantity: number;
  creditsAdded: number;
};

export default function ElevateSuccessPage() {
  const [, navigate] = useLocation();
  const [phase, setPhase] = useState<Phase>("verifying");
  const [successData, setSuccessData] = useState<SuccessData | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");

    if (!sessionId) {
      setErrorMsg("Missing payment session. Please try again.");
      setPhase("error");
      return;
    }

    let tries = 0;
    const maxTries = 6;
    const interval = 2000;

    const verify = async () => {
      tries++;
      try {
        const res = await apiRequest("POST", "/api/stripe/elevate-activate", { sessionId });
        const data = await res.json();
        if (res.ok && data.success) {
          setSuccessData({
            elevateType: data.elevateType ?? "elevate",
            quantity: data.quantity ?? 1,
            creditsAdded: data.creditsAdded ?? 1,
          });
          queryClient.invalidateQueries({ queryKey: ["/api/elevate/status"] });
          queryClient.invalidateQueries({ queryKey: ["/api/elevate/session-stats"] });
          setPhase("success");
          setTimeout(() => navigate("/likes"), 3500);
          return;
        }
        if (res.status === 402 && tries < maxTries) {
          setTimeout(verify, interval);
        } else {
          setErrorMsg(data.message ?? "Payment verification failed. Please contact support.");
          setPhase("error");
        }
      } catch {
        if (tries < maxTries) {
          setTimeout(verify, interval);
        } else {
          setErrorMsg("Network error. Please check your connection and try again.");
          setPhase("error");
        }
      }
    };

    verify();
  }, [navigate]);

  const isSuper = successData?.elevateType === "super_elevate";
  const qty = successData?.quantity ?? 1;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-sm w-full text-center space-y-6">
        {phase === "verifying" && (
          <>
            <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
              <Loader2 className="w-9 h-9 text-primary animate-spin" />
            </div>
            <div>
              <h1 className="font-serif text-2xl font-bold mb-2">Confirming payment…</h1>
              <p className="text-sm text-muted-foreground">Just a moment while we verify your purchase.</p>
            </div>
          </>
        )}

        {phase === "success" && successData && (
          <>
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center mx-auto"
              style={isSuper
                ? { background: "linear-gradient(135deg, hsl(350 45% 20%), hsl(350 45% 14%))", border: "1px solid hsl(350 45% 35%)" }
                : { background: "hsl(350 45% 52% / 0.12)", border: "1px solid hsl(350 45% 52% / 0.3)" }
              }
            >
              {isSuper
                ? <Zap className="w-9 h-9 text-primary" />
                : <Gift className="w-9 h-9 text-primary" />
              }
            </div>
            <div>
              <div className="flex items-center justify-center gap-2 mb-2">
                <CheckCircle2 className="w-5 h-5 text-green-500" />
                <h1 className="font-serif text-2xl font-bold">
                  {isSuper ? "Super Elevate" : qty > 1 ? `${qty} Elevates` : "Elevate"} purchased!
                </h1>
              </div>
              <div
                className="rounded-2xl p-4 mb-4 text-left mx-auto max-w-[260px]"
                style={{ background: "hsl(350 45% 52% / 0.07)", border: "1px solid hsl(350 45% 52% / 0.2)" }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <p className="text-sm font-semibold text-primary">Added to your account</p>
                </div>
                <p className="text-sm text-muted-foreground">
                  <span className="font-semibold text-foreground">{qty} boost{qty > 1 ? "s" : ""}</span>
                  {" · "}
                  {isSuper ? "60 min · 8× visibility" : "30 min · 3× visibility"} each
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Use them whenever you're ready from the Elevate screen.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">Redirecting you back…</p>
            </div>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="w-20 h-20 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center mx-auto">
              <XCircle className="w-9 h-9 text-destructive" />
            </div>
            <div>
              <h1 className="font-serif text-2xl font-bold mb-2">Something went wrong</h1>
              <p className="text-sm text-muted-foreground mb-6">{errorMsg}</p>
              <button
                className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:brightness-105 transition-all"
                onClick={() => navigate("/likes")}
                data-testid="button-elevate-error-back"
              >
                Back to app
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
