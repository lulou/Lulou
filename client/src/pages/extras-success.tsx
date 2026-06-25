import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { getAuthHeaders, queryClient, API_BASE } from "@/lib/queryClient";
import { CheckCircle2, XCircle, Loader2, Crown, ArrowRight, Gift, MessageSquare, Phone, Video, Sparkles } from "lucide-react";
import { useLanguageContext } from "@/contexts/language-context";

type Phase = "verifying" | "active" | "error";

export default function ExtrasSuccessPage() {
  const { t } = useLanguageContext();

  const ITEM_LABELS: Record<string, { label: string; description: string; icon: React.ReactNode }> = {
    "messages-5":           { label: t("item_messages5_label"),         description: t("item_messages5_desc"),         icon: <MessageSquare className="w-6 h-6 text-primary" /> },
    "extra-call":           { label: t("item_extra_call_label"),        description: t("item_extra_call_desc"),        icon: <Phone className="w-6 h-6 text-primary" /> },
    "video-call":           { label: t("item_video_call_label"),        description: t("item_video_call_desc"),        icon: <Video className="w-6 h-6 text-primary" /> },
    "undo-close":           { label: t("item_undo_close_label"),        description: t("item_undo_close_desc"),        icon: <Crown className="w-6 h-6 text-primary" /> },
    "membership":           { label: t("item_membership_lbl"),          description: t("item_membership_dsc"),         icon: <Crown className="w-6 h-6 text-primary" /> },
    "starter-pack":         { label: t("item_starter_pack_label"),      description: t("item_starter_pack_desc"),      icon: <Phone className="w-6 h-6 text-primary" /> },
    "video-starter":        { label: "Video Call Starter",              description: "1 video call credit added",      icon: <Video className="w-6 h-6 text-primary" /> },
    "connection-pack":      { label: t("item_connection_pack_label"),   description: t("item_connection_pack_desc"),   icon: <Phone className="w-6 h-6 text-primary" /> },
    "premium-pack":         { label: t("item_premium_pack_label"),      description: t("item_premium_pack_desc"),      icon: <Phone className="w-6 h-6 text-primary" /> },
    "chemistry-pack":       { label: t("item_chemistry_pack_label"),    description: t("item_chemistry_pack_desc"),    icon: <Video className="w-6 h-6 text-primary" /> },
    "deep-connection-pack": { label: t("item_deep_connection_label"),   description: t("item_deep_connection_desc"),   icon: <Video className="w-6 h-6 text-primary" /> },
    "voice-notes-unlock":   { label: "Voice Notes Unlock",              description: "Send & receive voice messages in all chats", icon: <MessageSquare className="w-6 h-6 text-primary" /> },
    "sparks-1":             { label: "1 Halo",                          description: "1 Halo added — spin the wheel to send it",   icon: <Sparkles className="w-6 h-6 text-primary" /> },
    "sparks-3":             { label: "3 Halos",                         description: "3 Halos added — spin the wheel to send them", icon: <Sparkles className="w-6 h-6 text-primary" /> },
    "sparks-5":             { label: "5 Halos",                         description: "5 Halos added — spin the wheel to send them", icon: <Sparkles className="w-6 h-6 text-primary" /> },
  };

  const MEMBERSHIP_PERKS = [
    t("perk_2_extensions"),
    t("perk_3_phone_credits"),
    t("perk_1_video_credit"),
    t("perk_1_undo_close"),
  ];
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
      setErrorMsg(t("missing_session"));
      setPhase("error");
      return;
    }

    let tries = 0;
    const maxTries = 8;
    const interval = 2000;

    const verify = async () => {
      tries++;
      try {
        // Use raw fetch + getAuthHeaders so we can inspect res.status before
        // deciding to retry.  apiRequest calls throwIfResNotOk which throws for
        // ALL non-2xx responses (including 402), making status checks after it
        // unreachable dead code.
        const authHeaders = await getAuthHeaders();
        const res = await fetch(`${API_BASE}/api/stripe/extras-activate`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
          credentials: "include",
        });

        if (res.status === 402) {
          // Payment still processing on Stripe's side — keep polling
          if (tries < maxTries) {
            setTimeout(verify, interval);
          } else {
            setErrorMsg(t("payment_verify_failed"));
            setPhase("error");
          }
          return;
        }

        let data: any = {};
        try { data = await res.json(); } catch {}

        if (res.ok && data.success) {
          setItemName(data.name ?? item);
          queryClient.invalidateQueries({ queryKey: ["/api/benefits"] });
          queryClient.invalidateQueries({ queryKey: ["/api/spin-status"] });
          setPhase("active");
          return;
        }

        // 403 = user mismatch — no point retrying, show the exact server message
        if (res.status === 403) {
          setErrorMsg(data.message ?? "Please return to Lulou and sign in with the same account used to start the purchase.");
          setPhase("error");
          return;
        }

        // Any other non-ok (401, 500, etc.) — retry transiently, then fail
        if (tries < maxTries) {
          setTimeout(verify, interval * 1.5);
        } else {
          setErrorMsg(data.message ?? t("payment_verify_failed"));
          setPhase("error");
        }
      } catch {
        if (tries < maxTries) {
          setTimeout(verify, interval * 1.5);
        } else {
          setErrorMsg(t("network_error_retry"));
          setPhase("error");
        }
      }
    };

    verify();
  }, []);

  const info = ITEM_LABELS[itemId];
  const isMembership = itemId === "membership";
  const isSparks = itemId.startsWith("sparks-");

  return (
    <div className="min-h-screen bg-background">
      <div className="flex items-center gap-2 px-5 pt-5 pb-2 max-w-md mx-auto">
        <Crown className="w-5 h-5 text-primary" />
        <span className="font-serif font-semibold text-base">{t("lulou_extras")}</span>
      </div>

      <div className="max-w-md mx-auto px-5 py-4 space-y-5">

        {phase === "verifying" && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
            <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Loader2 className="w-9 h-9 text-primary animate-spin" />
            </div>
            <div className="text-center">
              <h1 className="font-serif text-2xl font-bold mb-2">{t("confirming_payment")}</h1>
              <p className="text-sm text-muted-foreground">{t("verifying_extras_purchase")}</p>
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
                  {isMembership ? t("membership_activated") : t("added_to_account")}
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
                <ul className="space-y-1.5 pt-1 ps-1">
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
                {isMembership ? t("membership_benefits_active") : t("extra_saved_to_account")}
              </p>
            </div>

            <button
              className="w-full py-4 rounded-2xl font-bold text-base flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
              style={{ background: "hsl(350 45% 52%)", color: "white", boxShadow: "0 4px 16px hsl(350 45% 40% / 0.35)" }}
              onClick={() => navigate(isSparks ? "/intent" : "/matches")}
              data-testid="button-extras-continue"
            >
              {isSparks ? "Spin the Wheel" : t("go_to_matches")}
              <ArrowRight className="w-5 h-5" />
            </button>

            <p className="text-center text-xs text-muted-foreground pb-6">
              {t("view_extras_profile_note")}
            </p>
          </>
        )}

        {phase === "error" && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
            <div className="w-20 h-20 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center">
              <XCircle className="w-9 h-9 text-destructive" />
            </div>
            <div className="text-center">
              <h1 className="font-serif text-2xl font-bold mb-2">{t("something_went_wrong")}</h1>
              <p className="text-sm text-muted-foreground mb-6">{errorMsg}</p>
            </div>
            <button
              className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm"
              onClick={() => navigate("/profile")}
              data-testid="button-extras-error-back"
            >
              {t("back")}
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
