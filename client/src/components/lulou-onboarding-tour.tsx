import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  AudioLines,
  CalendarDays,
  Check,
  ChevronRight,
  Dna,
  Heart,
  MessageCircle,
  Moon,
  Sparkles,
  Users,
  Video,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import type { UserSettings } from "@shared/schema";
import { useLanguageContext } from "@/contexts/language-context";

type PreviewProps = { className?: string };

const PREVIEW_IMAGES = {
  first: "/images/profile-1.png",
  second: "/images/profile-2.png",
  third: "/images/profile-3.png",
};

function PreviewChrome({ children, className = "" }: PreviewProps & { children: React.ReactNode }) {
  return (
    <div
      className={`relative overflow-hidden rounded-[22px] border border-white/70 bg-[#fbfaf9] shadow-[0_16px_35px_rgba(63,43,47,0.13),0_2px_7px_rgba(63,43,47,0.08)] ${className}`}
      aria-hidden="true"
    >
      <div className="absolute inset-x-0 top-0 z-10 flex h-7 items-center justify-center border-b border-black/[0.04] bg-white/65 backdrop-blur-md">
        <span className="h-1.5 w-14 rounded-full bg-black/10" />
      </div>
      {children}
    </div>
  );
}

function MiniWheelPreview() {
  return (
    <PreviewChrome className="h-[218px] bg-[radial-gradient(circle_at_50%_45%,rgba(211,126,142,0.2),transparent_54%),linear-gradient(145deg,#fff9f7,#f5e9e8)]">
      <div className="flex items-center justify-between px-4 pb-1 pt-10">
        <div>
          <p className="text-[8px] font-bold uppercase tracking-[0.18em] text-[#9e6470]">Intention Wheel</p>
          <p className="mt-0.5 text-[10px] font-medium text-[#6e5d60]">Tonight&apos;s connection</p>
        </div>
        <span className="rounded-full border border-[#dca8b1]/45 bg-white/70 px-2 py-1 text-[8px] font-semibold text-[#9e6470]">1 intro today</span>
      </div>

      <div className="relative mx-auto mt-1 h-[132px] w-[218px]">
        <div className="absolute left-1/2 top-1/2 h-[146px] w-[146px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#d59aa6]/25" />
        <div className="absolute left-1/2 top-1/2 h-[104px] w-[104px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-[#c97d8d]/35" />
        <div className="absolute left-1/2 top-1/2 h-[68px] w-[68px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#c97d8d]/25 bg-white/60 p-1 shadow-[0_5px_16px_rgba(135,70,82,0.18)]">
          <img src={PREVIEW_IMAGES.first} alt="" className="h-full w-full rounded-full object-cover" />
        </div>
        <div className="absolute left-[22px] top-[50px] h-8 w-8 rounded-full border-2 border-white shadow-md">
          <img src={PREVIEW_IMAGES.second} alt="" className="h-full w-full rounded-full object-cover" />
        </div>
        <div className="absolute right-[25px] top-[27px] h-7 w-7 rounded-full border-2 border-white shadow-md">
          <img src={PREVIEW_IMAGES.third} alt="" className="h-full w-full rounded-full object-cover" />
        </div>
        <div className="absolute bottom-[11px] left-[65px] h-5 w-5 rounded-full border-2 border-white bg-[#d995a2] shadow-md" />
        <div className="absolute bottom-[2px] right-[64px] h-4 w-4 rounded-full border-2 border-white bg-[#e9c3c8] shadow-md" />
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-full bg-white/80 px-3 py-1 text-[9px] font-semibold text-[#714e56] shadow-sm">
          One considered connection
        </div>
      </div>
    </PreviewChrome>
  );
}

function MiniDiscoverPreview() {
  return (
    <PreviewChrome className="h-[218px] bg-[#f8f6f4]">
      <div className="flex items-center justify-between px-4 pb-1.5 pt-9">
        <div className="flex items-center gap-1.5">
          <span className="font-serif text-[15px] font-bold text-[#302629]">Discover</span>
          <Sparkles className="h-3 w-3 text-[#b45e70]" />
        </div>
        <span className="h-7 w-7 rounded-full border border-black/10 bg-white/70" />
      </div>
      <div className="mx-3 overflow-hidden rounded-[17px] border border-black/[0.06] bg-white shadow-[0_8px_20px_rgba(45,30,33,0.1)]">
        <div className="relative h-[70px] overflow-hidden">
          <img src={PREVIEW_IMAGES.second} alt="" className="h-full w-full object-cover object-[center_28%]" />
          <span className="absolute bottom-2 left-2 rounded-full bg-black/45 px-2 py-1 text-[8px] font-semibold text-white backdrop-blur-sm">Photo 1 of 3</span>
        </div>
        <div className="flex items-start justify-between px-3 py-1.5">
          <div>
            <p className="font-serif text-[15px] font-bold leading-none text-[#302629]">Amara, 31</p>
            <p className="mt-1 text-[9px] text-[#817376]">Sydney · 8 km away</p>
          </div>
          <span className="rounded-full bg-[#f8e8eb] px-2 py-1 text-[8px] font-medium text-[#9c5265]">Thoughtful</span>
        </div>
        <div className="flex gap-2 px-3 pb-2">
          <div className="flex h-7 flex-1 items-center justify-center gap-1 rounded-full border border-[#d8c8ca] bg-white text-[9px] font-semibold text-[#6e5d60]">
            <Moon className="h-3 w-3" /> Close <span aria-hidden="true">🌙</span>
          </div>
          <div className="flex h-7 flex-1 items-center justify-center gap-1 rounded-full bg-[#a94e65] text-[9px] font-semibold text-white shadow-sm">
            <Heart className="h-3 w-3 fill-current" /> Open <span aria-hidden="true">❤️</span>
          </div>
        </div>
      </div>
    </PreviewChrome>
  );
}

function MiniLikesConnectionsPreview() {
  return (
    <PreviewChrome className="h-[218px] bg-[linear-gradient(145deg,#fffafa,#f5eff0)]">
      <div className="px-4 pb-2 pt-10">
        <p className="font-serif text-[15px] font-bold text-[#302629]">Your connections</p>
        <p className="mt-0.5 text-[9px] text-[#817376]">A little interest can become something real.</p>
      </div>
      <div className="flex items-center justify-center gap-1 px-3 pt-1">
        <div className="w-[84px] rounded-[14px] border border-[#dfcdd0] bg-white p-2 shadow-sm">
          <div className="flex items-center gap-1.5">
            <img src={PREVIEW_IMAGES.second} alt="" className="h-7 w-7 rounded-full object-cover" />
            <div>
              <p className="text-[8px] font-bold text-[#49393c]">Likes</p>
              <p className="text-[7px] text-[#9a888b]">Someone opened</p>
            </div>
          </div>
          <div className="mt-2 h-1.5 w-12 rounded-full bg-[#efd7dc]" />
          <div className="mt-1 h-1.5 w-16 rounded-full bg-[#f4e8e9]" />
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-[#c47b89]" />
        <div className="flex w-[84px] flex-col items-center rounded-[14px] border border-[#e7c2c9] bg-[#fff7f8] p-2 shadow-sm">
          <div className="flex -space-x-2">
            <img src={PREVIEW_IMAGES.first} alt="" className="h-8 w-8 rounded-full border-2 border-white object-cover" />
            <img src={PREVIEW_IMAGES.second} alt="" className="h-8 w-8 rounded-full border-2 border-white object-cover" />
          </div>
          <p className="mt-1.5 text-[8px] font-bold text-[#9c5265]">It&apos;s a match</p>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-[#c47b89]" />
        <div className="w-[84px] rounded-[14px] border border-[#dfcdd0] bg-white p-2 shadow-sm">
          <div className="flex items-center gap-1.5">
            <Users className="h-7 w-7 rounded-full bg-[#f8e8eb] p-1.5 text-[#a94e65]" />
            <div>
              <p className="text-[8px] font-bold text-[#49393c]">Connections</p>
              <p className="text-[7px] text-[#9a888b]">Start talking</p>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-1 text-[8px] font-semibold text-[#a94e65]">
            Open chat <ChevronRight className="h-2.5 w-2.5" />
          </div>
        </div>
      </div>
      <div className="mx-auto mt-5 flex w-fit items-center gap-1.5 rounded-full border border-[#e4cdd1] bg-white/75 px-3 py-1.5 text-[9px] font-medium text-[#725c61]">
        Likes <ArrowRight className="h-3 w-3 text-[#bd7381]" /> Match <ArrowRight className="h-3 w-3 text-[#bd7381]" /> Connections
      </div>
    </PreviewChrome>
  );
}

const CONVERSATION_STAGES = [
  { label: "Messages", icon: MessageCircle },
  { label: "Audio call", icon: AudioLines },
  { label: "More messages", icon: MessageCircle },
  { label: "Video call", icon: Video },
  { label: "Plan a date", icon: CalendarDays },
] as const;

function MiniConversationPreview() {
  return (
    <PreviewChrome className="h-[218px] bg-[linear-gradient(145deg,#fcfbfa,#f3eeee)]">
      <div className="px-4 pb-1 pt-10">
        <p className="font-serif text-[15px] font-bold text-[#302629]">A conversation with intention</p>
        <p className="mt-0.5 text-[9px] text-[#817376]">Each step unlocks together.</p>
      </div>
      <div className="mx-4 mt-2 rounded-[16px] border border-white bg-white/80 px-3 py-2 shadow-sm">
        {CONVERSATION_STAGES.map(({ label, icon: Icon }, index) => (
          <div key={label} className="flex items-center gap-2">
            <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${index === 0 ? "bg-[#a94e65] text-white" : "bg-[#f7e9eb] text-[#a94e65]"}`}>
              <Icon className="h-3 w-3" />
            </div>
            <span className={`text-[9px] ${index === 0 ? "font-bold text-[#49393c]" : "font-medium text-[#756467]"}`}>{label}</span>
            {index < CONVERSATION_STAGES.length - 1 && <div className="mx-1 h-2 flex-1 border-s border-dashed border-[#d8b9bf]" />}
          </div>
        ))}
      </div>
      <div className="mx-auto mt-2 flex w-fit items-center gap-1.5 rounded-full bg-[#f8e8eb] px-3 py-1 text-[8px] font-semibold text-[#9c5265]">
        <Check className="h-3 w-3" /> Progress together, never rush
      </div>
    </PreviewChrome>
  );
}

function MiniDnaPreview() {
  return (
    <PreviewChrome className="h-[218px] bg-[radial-gradient(circle_at_80%_15%,rgba(196,130,144,0.18),transparent_38%),linear-gradient(145deg,#fffafa,#f5edef)]">
      <div className="flex items-center justify-between px-4 pb-2 pt-10">
        <div className="flex items-center gap-1.5">
          <Dna className="h-4 w-4 text-[#a94e65]" />
          <p className="font-serif text-[15px] font-bold text-[#302629]">Connection DNA</p>
        </div>
        <span className="text-[8px] font-semibold text-[#a94e65]">Question 4 of 15</span>
      </div>
      <div className="mx-4 rounded-[17px] border border-white bg-white/85 p-3.5 shadow-[0_8px_20px_rgba(75,43,51,0.08)]">
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-[#f3e1e4]">
          <div className="h-full w-[27%] rounded-full bg-[#b76176]" />
        </div>
        <p className="font-serif text-[14px] font-bold leading-snug text-[#3e3033]">What helps you feel close to someone?</p>
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {["Time together", "Words", "Small gestures"].map((choice, index) => (
            <div key={choice} className={`rounded-[10px] border px-2 py-2 text-center text-[8px] font-semibold ${index === 1 ? "border-[#c47b89] bg-[#f9e9ec] text-[#9c5265]" : "border-[#eadcde] bg-white text-[#77666a]"}`}>
              {choice}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex justify-center gap-1.5">
        {["Communication", "Pace", "Depth"].map(label => (
          <span key={label} className="rounded-full bg-white/75 px-2.5 py-1 text-[8px] font-medium text-[#8d6971] shadow-sm">{label}</span>
        ))}
      </div>
    </PreviewChrome>
  );
}

function MiniJourneyPreview() {
  const stages = [
    { label: "Discover", icon: Sparkles },
    { label: "Open", icon: Heart },
    { label: "Connect", icon: Users },
    { label: "Talk", icon: MessageCircle },
    { label: "Meet", icon: CalendarDays },
  ];

  return (
    <PreviewChrome className="h-[218px] bg-[linear-gradient(145deg,#fffaf9,#f3e9eb)]">
      <div className="px-4 pb-2 pt-10">
        <p className="font-serif text-[17px] font-bold text-[#302629]">The Lulou journey</p>
        <p className="mt-0.5 text-[9px] text-[#817376]">A thoughtful path to something real.</p>
      </div>
      <div className="mx-4 mt-3 flex items-start justify-between rounded-[18px] border border-white bg-white/75 px-3 py-4 shadow-sm">
        {stages.map(({ label, icon: Icon }, index) => (
          <div key={label} className="flex min-w-0 items-start">
            <div className="flex flex-col items-center gap-1">
              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${index === 0 ? "bg-[#a94e65] text-white" : "bg-[#f8e8eb] text-[#a94e65]"}`}>
                <Icon className="h-3.5 w-3.5" />
              </div>
              <span className={`text-[7px] ${index === 0 ? "font-bold text-[#49393c]" : "font-medium text-[#756467]"}`}>{label}</span>
            </div>
            {index < stages.length - 1 && <ArrowRight className="mx-0.5 mt-2 h-2.5 w-2.5 shrink-0 text-[#cc8a96]" />}
          </div>
        ))}
      </div>
      <div className="mx-auto mt-4 flex w-fit items-center gap-1.5 rounded-full bg-[#a94e65] px-3.5 py-1.5 text-[9px] font-semibold text-white shadow-sm">
        Find your connection <ArrowRight className="h-3 w-3" />
      </div>
    </PreviewChrome>
  );
}

/** A concise first-account tour. Completion is server-backed, not localStorage. */
export function LulouOnboardingTour({ required = false }: { required?: boolean }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useLanguageContext();
  const [step, setStep] = useState(0);
  const pointerStartX = useRef<number | null>(null);
  const { data: settings } = useQuery<UserSettings>({
    queryKey: ["/api/settings", user?.id],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/settings");
      return response.json() as Promise<UserSettings>;
    },
    enabled: !!user,
    staleTime: 30_000,
  });
  const complete = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("PATCH", "/api/settings", { onboardingTutorialCompleted: true });
      if (!response.ok) throw new Error("Couldn't save tutorial progress");
      return response.json() as Promise<UserSettings>;
    },
    onSuccess: saved => queryClient.setQueryData(["/api/settings", user?.id], saved),
  });

  if (!settings || settings.onboardingTutorialCompleted) return null;

  const STEPS = [
    { title: t("tutorial_wheel_title"), body: t("tutorial_wheel_body"), preview: <MiniWheelPreview /> },
    { title: t("tutorial_discover_title"), body: t("tutorial_discover_body"), preview: <MiniDiscoverPreview /> },
    { title: t("tutorial_likes_title"), body: t("tutorial_likes_body"), preview: <MiniLikesConnectionsPreview /> },
    { title: t("tutorial_conversation_title"), body: t("tutorial_conversation_body"), preview: <MiniConversationPreview /> },
    { title: t("tutorial_dna_title"), body: t("tutorial_dna_body"), preview: <MiniDnaPreview /> },
    { title: t("tutorial_journey_title"), body: t("tutorial_journey_body"), preview: <MiniJourneyPreview /> },
  ] as const;
  const current = STEPS[step];
  const finish = () => complete.mutate();
  const goToStep = (nextStep: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, nextStep)));

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-[3px]" data-testid="lulou-onboarding-tour">
      <section
        className="max-h-[calc(100dvh-24px)] w-full max-w-sm touch-pan-y overflow-y-auto rounded-[30px] border border-primary/20 bg-background p-4 shadow-2xl sm:p-5"
        onPointerDown={event => { pointerStartX.current = event.clientX; }}
        onPointerUp={event => {
          if (pointerStartX.current == null) return;
          const delta = event.clientX - pointerStartX.current;
          pointerStartX.current = null;
          if (Math.abs(delta) < 48) return;
          goToStep(step + (delta < 0 ? 1 : -1));
        }}
        onPointerCancel={() => { pointerStartX.current = null; }}
      >
        <div key={step} className="tutorial-slide-in">
          <div className="mb-4">{current.preview}</div>
          <div className="px-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-primary/70">{t("welcome_to_lulou")}</p>
            <h2 className="mt-1.5 font-serif text-[25px] font-semibold tracking-tight">{current.title}</h2>
            <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{current.body}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2 px-1">
          <div className="flex min-w-12 items-center gap-1" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
            {STEPS.map((_, index) => (
              <button
                key={index}
                type="button"
                onClick={() => goToStep(index)}
                className={`h-1.5 rounded-full transition-all duration-300 ${index === step ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/25"}`}
                aria-label={`Go to step ${index + 1}`}
              />
            ))}
          </div>
          {required
            ? <span className="w-12" aria-hidden="true" />
            : <button type="button" onClick={finish} className="px-2 py-2 text-sm font-medium text-muted-foreground">{t("tutorial_skip_label")}</button>}
          <button
            type="button"
            onClick={() => step === STEPS.length - 1 ? finish() : goToStep(step + 1)}
            className="flex min-h-11 items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition-transform active:scale-[0.98]"
            disabled={complete.isPending}
          >
            {step === STEPS.length - 1 ? t("tutorial_got_it_label") : t("tutorial_next_label")}
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </section>
    </div>
  );
}