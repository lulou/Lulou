import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, API_BASE, getAuthHeaders } from "@/lib/queryClient";
import type { UserSettings } from "@shared/schema";
import { useLanguageContext } from "@/contexts/language-context";

/** A concise first-account tour. Completion is server-backed, not localStorage. */
export function LulouOnboardingTour() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { t, language } = useLanguageContext();
  const [step, setStep] = useState(0);
  const { data: settings } = useQuery<UserSettings>({
    queryKey: ["/api/settings", user?.id],
    enabled: !!user,
    staleTime: 30_000,
  });
  // Defense-in-depth: App.tsx gates the whole app on DNA, but this component
  // must also refuse to appear if mounted from a recovery/deep-link path.
  // Never infer completion from tutorial state.
  const { data: dnaStatus, isPending: dnaPending } = useQuery<{ completed: boolean }>({
    queryKey: ["dna-status-check", "onboarding-tour"],
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/api/dna/status`, { headers: await getAuthHeaders() });
      if (!response.ok) return { completed: false };
      return response.json();
    },
    enabled: !!user,
    staleTime: 30_000,
    retry: false,
  });
  const complete = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("PATCH", "/api/settings", { onboardingTutorialCompleted: true });
      if (!response.ok) throw new Error("Couldn't save tutorial progress");
      return response.json() as Promise<UserSettings>;
    },
    onSuccess: saved => queryClient.setQueryData(["/api/settings", user?.id], saved),
  });

  // Keep the account-setting state ready for every locale, but defer this new
  // tour until its copy is translated rather than presenting English-only UI.
  if (!settings || dnaPending || !dnaStatus?.completed || settings.onboardingTutorialCompleted || language !== "English") return null;
  const STEPS = [
    [t("tutorial_discover_title"), t("tutorial_discover_body"), "✦"],
    [t("tutorial_intentions_title"), t("tutorial_intentions_body"), "◌"],
    [t("tutorial_connections_title"), t("tutorial_connections_body"), "♡"],
    [t("tutorial_take_time_title"), t("tutorial_take_time_body"), "☾"],
  ] as const;
  const [title, body, icon] = STEPS[step];
  const finish = () => complete.mutate();

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-5 pb-[max(24px,env(safe-area-inset-bottom))] backdrop-blur-[2px]" data-testid="lulou-onboarding-tour">
      <section className="w-full max-w-sm rounded-[28px] border border-primary/20 bg-background p-6 shadow-2xl">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-2xl text-primary" aria-hidden="true">{icon}</div>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary/70">{t("welcome_to_lulou")}</p>
        <h2 className="mt-2 font-serif text-2xl font-semibold">{title}</h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
        <div className="mt-6 flex items-center justify-between gap-3">
          <button type="button" onClick={finish} className="px-2 py-2 text-sm font-medium text-muted-foreground">{t("tutorial_skip_label")}</button>
          <div className="flex gap-1.5" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
            {STEPS.map((_, index) => <span key={index} className={`h-1.5 rounded-full ${index === step ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/25"}`} />)}
          </div>
          <button type="button" onClick={() => step === STEPS.length - 1 ? finish() : setStep(current => current + 1)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">
            {step === STEPS.length - 1 ? t("tutorial_got_it_label") : t("tutorial_next_label")}
          </button>
        </div>
      </section>
    </div>
  );
}