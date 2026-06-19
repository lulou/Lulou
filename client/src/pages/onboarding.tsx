import { useState, useRef } from "react";
import { useLanguageContext } from "@/contexts/language-context";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { cleanErrorMessage, withRetry } from "@/lib/profile-upsert";
import { writeDebug } from "@/lib/debug-store";
import { SIGNALS, GREEN_FLAGS, DATING_INTENTS, CONNECTION_STYLES, CONVERSATION_STARTERS, PROFILE_QUESTIONS } from "@shared/schema";
import { Loader2, ArrowRight, ArrowLeft, Check, AlertCircle, Plus, X, ImagePlus } from "lucide-react";
import { DobPicker } from "@/components/dob-picker";
import { LulouFlowerIcon } from "@/components/app-layout";
import { HeightPicker } from "@/components/height-picker";
import type { Profile } from "@shared/schema";
import { convertPhotoToJpeg } from "@/lib/photo-utils";
import { useUnits, formatDistance } from "@/lib/units";

const STEP_KEYS = ["ob_step_basics","ob_step_photos","ob_step_starters","ob_step_questions","ob_step_signals","ob_step_intent","ob_step_green_flags","ob_step_pace"] as const;

const INTENT_DESCRIPTIONS: Record<string, string> = {
  "Committed Relationship": "Looking for a life partner.",
  "Serious Dating":         "Looking for something real and seeing where it leads.",
  "Open To Connection":     "Open minded, but not interested in casual dating.",
};

const AU_STATE_ABBR: Record<string, string> = {
  "New South Wales": "NSW", "Victoria": "VIC", "Queensland": "QLD",
  "South Australia": "SA", "Western Australia": "WA", "Tasmania": "TAS",
  "Australian Capital Territory": "ACT", "Northern Territory": "NT",
};

const INTENT_ICONS: Record<string, string> = {
  "Committed Relationship": "💍",
  "Serious Dating": "❤️",
  "Open To Connection": "✨",
};

function RadiusLabel({ locationRadius }: { locationRadius: number }) {
  const [units] = useUnits();
  const { t } = useLanguageContext();
  return <Label>{t("search_radius")}: {formatDistance(locationRadius, units)}</Label>;
}

function RadiusDescription({ locationRadius }: { locationRadius: number }) {
  const [units] = useUnits();
  const { t } = useLanguageContext();
  return (
    <p className="text-xs text-muted-foreground">
      {t("people_within_radius").replace("{distance}", formatDistance(locationRadius, units))}
    </p>
  );
}

// Parse stored starters ("starter text answer text") back into separate keys + answers
function parseStoredStarters(stored: string[]): { starters: string[]; answers: Record<string, string> } {
  const starters: string[] = [];
  const answers: Record<string, string> = {};
  for (const s of stored) {
    const match = (CONVERSATION_STARTERS as readonly string[]).find(k => s.startsWith(k));
    if (match) {
      starters.push(match);
      answers[match] = s.slice(match.length).trim();
    }
  }
  return { starters, answers };
}

// Determine which step to resume at based on what fields are already filled
function computeInitialStep(profile: Profile | null): number {
  if (!profile) return 0;

  const basicsOk =
    !!profile.firstName && profile.firstName !== "New User" &&
    (profile.age ?? 0) >= 18 &&
    !!profile.gender && profile.gender !== "Prefer not to say" &&
    !!profile.datingPreference && profile.datingPreference !== "Everyone" &&
    !!profile.location && profile.location !== "Not set" &&
    !!profile.email;
  if (!basicsOk) return 0;

  if (!profile.photos || profile.photos.length < 2) return 1;

  const { starters, answers } = parseStoredStarters(profile.conversationStarters ?? []);
  const startersOk = starters.length >= 2 && starters.every(s => answers[s]?.trim());
  if (!startersOk) return 2;

  if (!profile.questions || profile.questions.length < 2) return 3;
  if (!profile.signals || profile.signals.length < 1) return 4;
  if (!profile.datingIntent || profile.datingIntent === "Not set") return 5;
  if (!profile.greenFlags || profile.greenFlags.length < 3) return 6;
  if (!profile.connectionStyle || profile.connectionStyle === "Not set") return 7;

  return 7;
}

function calculateAgeFromDob(dob: string): number {
  if (!dob) return 0;
  const today = new Date();
  const birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

// Build initial formData from an existing profile (partial or complete)
function buildInitialFormData(profile: Profile | null, userEmail = "") {
  if (!profile) {
    return {
      firstName: "",
      age: 25,
      dateOfBirth: "",
      gender: "",
      datingPreference: "",
      location: "",
      height: "",
      locationRadius: 25,
      photos: [] as string[],
      signals: [] as string[],
      datingIntent: "",
      greenFlags: [] as string[],
      connectionStyle: "",
      email: userEmail,
      phoneNumber: "",
      conversationStarters: [] as string[],
      starterAnswers: {} as Record<string, string>,
      questions: [] as string[],
      customQuestions: [] as Array<{ question: string; answer: string }>,
      viewerQuestions: [] as Array<{ question: string }>,
      customStarters: [] as string[],
      pronouns: "",
      customGreenFlags: [] as string[],
      customSignals: [] as string[],
    };
  }

  const { starters, answers } = parseStoredStarters(profile.conversationStarters ?? []);

  return {
    firstName: profile.firstName && profile.firstName !== "New User" ? profile.firstName : "",
    age: (profile.age ?? 0) >= 18 ? profile.age! : 25,
    dateOfBirth: (profile as any).dateOfBirth ?? "",
    gender: profile.gender && profile.gender !== "Prefer not to say" ? profile.gender : "",
    datingPreference: profile.datingPreference && profile.datingPreference !== "Everyone" ? profile.datingPreference : "",
    location: profile.location && profile.location !== "Not set" ? profile.location : "",
    height: profile.height ?? "",
    locationRadius: profile.locationRadius ?? 25,
    photos: profile.photos ?? [],
    signals: profile.signals ?? [],
    datingIntent: profile.datingIntent && profile.datingIntent !== "Not set" ? profile.datingIntent : "",
    greenFlags: profile.greenFlags ?? [],
    connectionStyle: profile.connectionStyle && profile.connectionStyle !== "Not set" ? profile.connectionStyle : "",
    email: profile.email ?? "",
    phoneNumber: profile.phoneNumber ?? "",
    conversationStarters: starters,
    starterAnswers: answers,
    questions: profile.questions ?? [],
    customQuestions: (profile as any).customQuestions ?? [],
    viewerQuestions: ((profile as any).viewerQuestions ?? []) as Array<{ question: string }>,
    customStarters: ((profile as any).customStarters ?? []) as string[],
    pronouns: (profile as any).pronouns ?? "",
    customGreenFlags: ((profile as any).customGreenFlags ?? []) as string[],
    customSignals: ((profile as any).customSignals ?? []) as string[],
  };
}

interface OnboardingProps {
  existingProfile?: Profile | null;
  userEmail?: string;
}

export default function Onboarding({ existingProfile = null, userEmail = "" }: OnboardingProps) {
  const { t } = useLanguageContext();
  const [step, setStep] = useState(() => computeInitialStep(existingProfile));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { profileInitError } = useAuth();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState(() => buildInitialFormData(existingProfile, userEmail));

  const [locationQuery, setLocationQuery] = useState(() => {
    const loc = existingProfile?.location;
    return (loc && loc !== "Not set") ? loc : "";
  });
  const [locationSuggestions, setLocationSuggestions] = useState<Array<{
    display_name: string; lat: string; lon: string; address: Record<string, string>;
  }>>([]);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationSelected, setLocationSelected] = useState(
    () => !!(existingProfile?.location && existingProfile.location !== "Not set")
  );
  const locationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [customQDraft, setCustomQDraft] = useState({ question: "", answer: "" });
  const [viewerQDraft, setViewerQDraft] = useState("");
  const [customStarterDraft, setCustomStarterDraft] = useState("");

  const createProfile = useMutation({
    mutationFn: async () => {
      const fullStarters = formData.conversationStarters
        .filter(s => formData.starterAnswers[s])
        .map(s => `${s} ${formData.starterAnswers[s]}`);
      const { starterAnswers, ...rest } = formData;
      const payload = {
        ...rest,
        conversationStarters: fullStarters,
        customQuestions: formData.customQuestions,
        onboardingComplete: true,
      };
      console.log("[PROFILE_SAVE] START", { label: "createProfile", fieldKeys: Object.keys(payload) });
      writeDebug({ profileInsertAttempted: true, profileInsertSucceeded: false, profileErrorMessage: null });
      // withRetry retries up to 2 times (1 s + 2 s backoff) on transient
      // network/5xx errors.  4xx validation errors are not retried.
      const response = await withRetry(
        () => apiRequest("POST", "/api/profile", payload),
        "createProfile",
      );
      // Parse the returned profile row so onSuccess can pre-populate the cache.
      const profileData = await response.json();
      console.log("[PROFILE_SAVE] SUCCESS", { label: "createProfile", userId: profileData?.userId });
      writeDebug({ profileInsertSucceeded: true });
      return profileData;
    },
    onSuccess: (profileData) => {
      setSaveError(null);
      // Pre-populate the /api/profile data cache with the just-created row so
      // the Profile page renders without a skeleton flash on first visit.
      queryClient.setQueryData(["/api/profile"], profileData);
      // CRITICAL: tell AppContent the profile now exists.
      // Without this, AppContent's gate keeps effectiveProfileExists=false and
      // continues rendering <Onboarding> — trapping the user in an infinite loop
      // even after profile creation succeeds.  The navigate("/discover") below
      // only works once the gate switches to "render_main_app".
      queryClient.setQueryData(["profile-exists-check"], { exists: true, fetchFailed: false });
      console.log("[PROFILE_SAVE] GATE_UNBLOCKED", { profileExists: true });
      navigate("/discover");
    },
    onError: (error: any) => {
      const msg = cleanErrorMessage(error);
      console.error("[PROFILE_SAVE] FAILURE", { label: "createProfile", rawError: error?.message, cleanedError: msg });
      writeDebug({ profileErrorMessage: msg });
      // formData is NOT cleared — the user's entered data is preserved for retry.
      setSaveError(msg);
      toast({ title: t("save_profile_error"), description: msg, variant: "destructive", duration: 8000 });
    },
  });

  const update = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const toggleArrayItem = (field: string, item: string, max: number) => {
    setFormData(prev => {
      const arr = (prev as any)[field] as string[];
      if (arr.includes(item)) return { ...prev, [field]: arr.filter(i => i !== item) };
      if (arr.length >= max) return prev;
      return { ...prev, [field]: [...arr, item] };
    });
  };

  const canProceed = () => {
    switch (step) {
      case 0: return formData.firstName && formData.dateOfBirth && calculateAgeFromDob(formData.dateOfBirth) >= 18 && formData.gender && formData.datingPreference && formData.location && formData.email;
      case 1: return formData.photos.length >= 2;
      case 2: return formData.conversationStarters.length >= 2 && formData.conversationStarters.length <= 3 && formData.conversationStarters.every(s => formData.starterAnswers[s]?.trim());
      case 3: return formData.questions.length >= 2 && formData.questions.length <= 3;
      case 4: return formData.signals.length >= 1 && formData.signals.length <= 5;
      case 5: return formData.datingIntent !== "";
      case 6: return formData.greenFlags.length >= 3;
      case 7: return formData.connectionStyle !== "";
      default: return false;
    }
  };

  const stepLabels = STEP_KEYS.map(k => t(k as any));

  const handleNext = () => {
    if (step < STEP_KEYS.length - 1) setStep(step + 1);
    else createProfile.mutate();
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="px-6 py-5 flex items-center gap-2">
        <LulouFlowerIcon className="w-6 h-6 text-primary" />
        <span className="font-serif text-lg font-semibold">Lulou</span>
      </div>

      {profileInitError && (
        <div className="mx-6 mb-4 p-3 rounded-md bg-destructive/10 border border-destructive/20 flex items-start gap-2" data-testid="banner-profile-error">
          <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
          <p className="text-sm text-destructive">{profileInitError}</p>
        </div>
      )}

      {saveError && (
        <div className="mx-6 mb-4 p-3 rounded-md bg-destructive/10 border border-destructive/20 flex items-start gap-2" data-testid="banner-save-error">
          <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
          <div className="text-sm text-destructive">
            <p className="font-medium">{t("save_profile_error")}</p>
            <p>{saveError}</p>
          </div>
        </div>
      )}

      <div className="flex-1 flex items-center justify-center px-6 pb-12">
        <div className="w-full max-w-lg space-y-8">
          <div className="space-y-2">
            <div className="flex items-center justify-between mb-8">
              <span className="text-xs text-muted-foreground/60 font-medium tabular-nums">
                Step {step + 1} of {STEP_KEYS.length}
              </span>
              <div className="flex items-center gap-1.5">
                {STEP_KEYS.map((s, i) => (
                  <div
                    key={s}
                    className={`rounded-full transition-all duration-500 ease-out ${
                      i < step    ? "w-1.5 h-1.5 bg-primary/45" :
                      i === step  ? "w-5 h-1.5 bg-primary" :
                      "w-1.5 h-1.5 bg-border"
                    }`}
                    data-testid={`progress-step-${i}`}
                  />
                ))}
              </div>
            </div>
            <p className="text-xs font-medium tracking-wider uppercase text-primary">{stepLabels[step]}</p>
            <h2 className="font-serif text-2xl font-bold" data-testid="text-step-title">
              {step === 0 && t("ob_title_0")}
              {step === 1 && t("ob_title_1")}
              {step === 2 && t("ob_title_2")}
              {step === 3 && t("ob_title_3")}
              {step === 4 && t("ob_title_4")}
              {step === 5 && t("ob_title_5")}
              {step === 6 && t("ob_title_6")}
              {step === 7 && t("ob_title_7")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {step === 0 && t("ob_desc_0")}
              {step === 1 && t("ob_desc_1")}
              {step === 2 && t("ob_desc_2")}
              {step === 3 && t("ob_desc_3")}
              {step === 4 && t("ob_desc_4")}
              {step === 5 && t("ob_desc_5")}
              {step === 6 && t("ob_desc_6")}
              {step === 7 && t("ob_desc_7")}
            </p>
          </div>

          <div className="min-h-[280px]">
            {step === 0 && (
              <div className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="firstName">{t("label_first_name")}</Label>
                  <Input
                    id="firstName"
                    value={formData.firstName}
                    onChange={e => update("firstName", e.target.value)}
                    placeholder={t("ph_first_name")}
                    data-testid="input-first-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("label_dob")}</Label>
                  <DobPicker
                    value={formData.dateOfBirth}
                    onChange={dob => {
                      update("dateOfBirth", dob);
                      if (dob) update("age", calculateAgeFromDob(dob));
                    }}
                    testIdPrefix="dob"
                  />
                  {formData.dateOfBirth && calculateAgeFromDob(formData.dateOfBirth) < 18 && (
                    <p className="text-xs text-destructive flex items-center gap-1.5 mt-1" data-testid="text-under-18-error">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      {t("under_18_error")}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>{t("label_gender")}</Label>
                  <Select value={formData.gender} onValueChange={v => update("gender", v)}>
                    <SelectTrigger data-testid="select-gender"><SelectValue placeholder={t("sel_gender")} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="woman">{t("gender_woman")}</SelectItem>
                      <SelectItem value="man">{t("gender_man")}</SelectItem>
                      <SelectItem value="non-binary">{t("gender_nonbinary")}</SelectItem>
                      <SelectItem value="trans woman">{t("gender_trans_woman")}</SelectItem>
                      <SelectItem value="trans man">{t("gender_trans_man")}</SelectItem>
                      <SelectItem value="genderqueer">{t("gender_genderqueer")}</SelectItem>
                      <SelectItem value="genderfluid">{t("gender_genderfluid")}</SelectItem>
                      <SelectItem value="agender">{t("gender_agender")}</SelectItem>
                      <SelectItem value="two-spirit">{t("gender_two_spirit")}</SelectItem>
                      <SelectItem value="other">{t("gender_other")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("label_interested_in")}</Label>
                  <Select value={formData.datingPreference} onValueChange={v => update("datingPreference", v)}>
                    <SelectTrigger data-testid="select-dating-preference"><SelectValue placeholder={t("sel_dating_pref")} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="women">{t("pref_women")}</SelectItem>
                      <SelectItem value="men">{t("pref_men")}</SelectItem>
                      <SelectItem value="non-binary people">{t("pref_nonbinary_ppl")}</SelectItem>
                      <SelectItem value="trans women">{t("pref_trans_women")}</SelectItem>
                      <SelectItem value="trans men">{t("pref_trans_men")}</SelectItem>
                      <SelectItem value="everyone">{t("pref_everyone")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("label_pronouns_opt")}</Label>
                  <Select value={formData.pronouns} onValueChange={v => update("pronouns", v)}>
                    <SelectTrigger data-testid="select-pronouns"><SelectValue placeholder={t("sel_pronouns")} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="she/her">{t("pronoun_she_her")}</SelectItem>
                      <SelectItem value="he/him">{t("pronoun_he_him")}</SelectItem>
                      <SelectItem value="they/them">{t("pronoun_they_them")}</SelectItem>
                      <SelectItem value="she/they">{t("pronoun_she_they")}</SelectItem>
                      <SelectItem value="he/they">{t("pronoun_he_they")}</SelectItem>
                      <SelectItem value="any pronouns">{t("pronoun_any")}</SelectItem>
                      <SelectItem value="ask me">{t("pronoun_ask_me")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("label_location")}</Label>
                  <div className="relative">
                    <div className="relative flex items-center">
                      <Input
                        value={locationQuery}
                        onChange={e => {
                          const q = e.target.value;
                          setLocationQuery(q);
                          setLocationSelected(false);
                          update("location", "");
                          if (locationTimerRef.current) clearTimeout(locationTimerRef.current);
                          if (q.trim().length < 2) { setLocationSuggestions([]); return; }
                          locationTimerRef.current = setTimeout(async () => {
                            setLocationLoading(true);
                            try {
                              const res = await fetch(
                                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=au&limit=6&addressdetails=1`,
                                { headers: { "User-Agent": "LulouDating/1.0 contact@lulou.app" } }
                              );
                              setLocationSuggestions(res.ok ? await res.json() : []);
                            } catch { setLocationSuggestions([]); }
                            finally { setLocationLoading(false); }
                          }, 380);
                        }}
                        placeholder="Search suburb, city or postcode"
                        className="pe-9"
                        data-testid="input-location"
                      />
                      <span className="absolute end-3 pointer-events-none">
                        {locationLoading
                          ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                          : locationSelected
                          ? <Check className="w-4 h-4 text-green-500" />
                          : null}
                      </span>
                    </div>
                    {locationSuggestions.length > 0 && !locationSelected && (
                      <div
                        className="absolute top-full left-0 right-0 bg-background border border-border/40 rounded-2xl overflow-hidden z-50"
                        style={{ marginTop: 6, boxShadow: "0 8px 40px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.05)" }}
                      >
                        {locationSuggestions.map((item, idx) => {
                          const a = item.address;
                          const area = a.suburb || a.quarter || a.city_district || a.town || a.village || a.city || a.county;
                          const stateAbbr = a.state ? (AU_STATE_ABBR[a.state] ?? a.state) : null;
                          const label = [area, stateAbbr].filter(Boolean).join(", ") || item.display_name.split(",")[0].trim();
                          const [suburb, ...rest] = label.split(", ");
                          return (
                            <button
                              key={idx}
                              type="button"
                              className="w-full text-start px-4 py-3.5 flex items-center gap-3.5 hover:bg-muted/40 active:bg-muted/60 transition-colors border-b border-border/15 last:border-0 group"
                              onClick={() => {
                                update("location", label);
                                update("latitude", parseFloat(item.lat));
                                update("longitude", parseFloat(item.lon));
                                setLocationQuery(label);
                                setLocationSuggestions([]);
                                setLocationSelected(true);
                              }}
                              data-testid={`button-location-suggestion-${idx}`}
                            >
                              <div
                                className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-colors"
                                style={{ background: "hsl(350 45% 52% / 0.08)" }}
                              >
                                <span className="text-sm leading-none">📍</span>
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-foreground truncate">{suburb}</p>
                                {rest.length > 0 && (
                                  <p className="text-xs text-muted-foreground truncate mt-0.5">{rest.join(", ")}</p>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{t("label_height_opt")}</Label>
                  <HeightPicker
                    value={formData.height}
                    onChange={v => update("height", v)}
                    testId="input-height"
                  />
                </div>
                <div className="space-y-2.5">
                  <Label>{t("search_radius")}</Label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {([
                      { label: "10 km", value: 10 },
                      { label: "25 km", value: 25 },
                      { label: "50 km", value: 50 },
                      { label: "100 km", value: 100 },
                    ] as const).map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => update("locationRadius", opt.value)}
                        className={`py-2.5 rounded-xl text-xs font-semibold border transition-all duration-200 active:scale-95 ${
                          formData.locationRadius === opt.value
                            ? "bg-primary text-primary-foreground border-transparent shadow-sm"
                            : "border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40 bg-background"
                        }`}
                        data-testid={`button-distance-${opt.value}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => update("locationRadius", 0)}
                    className={`w-full py-2.5 rounded-xl text-xs font-semibold border transition-all duration-200 active:scale-95 ${
                      formData.locationRadius === 0
                        ? "bg-primary text-primary-foreground border-transparent shadow-sm"
                        : "border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/40 bg-background"
                    }`}
                    data-testid="button-distance-0"
                  >
                    Anywhere
                  </button>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">{t("ob_email_label")}</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={e => update("email", e.target.value)}
                    placeholder={t("ob_email_ph")}
                    data-testid="input-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("ob_phone_label")}</Label>
                  <div
                    className="flex overflow-hidden rounded-xl border border-input focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0"
                    style={{ background: "hsl(var(--background))" }}
                  >
                    <div className="flex items-center px-3 border-r border-input bg-muted/40 shrink-0 select-none">
                      <span className="text-sm font-semibold text-muted-foreground">+61</span>
                    </div>
                    <input
                      type="tel"
                      inputMode="numeric"
                      placeholder="412 345 678"
                      value={
                        formData.phoneNumber.startsWith("+61")
                          ? formData.phoneNumber.slice(3)
                          : formData.phoneNumber
                      }
                      onChange={e => {
                        const digits = e.target.value.replace(/\D/g, "").slice(0, 9);
                        update("phoneNumber", digits ? "+61" + digits : "");
                      }}
                      className="flex-1 px-3 py-3 text-sm bg-transparent outline-none"
                      data-testid="input-phone-number"
                    />
                  </div>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  {[0, 1, 2, 3, 4, 5].map(i => (
                    <PhotoSlot
                      key={i}
                      index={i}
                      photo={formData.photos[i]}
                      onSelect={(url) => {
                        const newPhotos = [...formData.photos];
                        if (newPhotos[i]) {
                          newPhotos[i] = url;
                        } else {
                          newPhotos.push(url);
                        }
                        update("photos", newPhotos);
                      }}
                      onRemove={() => {
                        update("photos", formData.photos.filter((_, idx) => idx !== i));
                      }}
                    />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  {formData.photos.length}/6 {t("photos_count_msg")}
                </p>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                {/* ── Custom conversation starters ─────────────────── */}
                <div className="space-y-2 pb-3 border-b">
                  <p className="text-sm font-semibold text-foreground">{t("custom_starter_title")}</p>
                  <p className="text-xs text-muted-foreground">{t("custom_starter_desc")}</p>
                  {formData.customStarters.map((s, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <p className="flex-1 text-sm border rounded-md px-3 py-2 bg-muted/30">{s}</p>
                      <button
                        className="shrink-0 w-6 h-6 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                        onClick={() => setFormData(prev => ({ ...prev, customStarters: prev.customStarters.filter((_, j) => j !== i) }))}
                        data-testid={`button-remove-custom-starter-${i}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {formData.customStarters.length < 3 && (
                    <div className="flex gap-2">
                      <Input
                        value={customStarterDraft}
                        onChange={e => setCustomStarterDraft(e.target.value)}
                        placeholder={t("ph_custom_starter")}
                        maxLength={120}
                        className="text-sm"
                        data-testid="input-custom-starter-draft"
                        onKeyDown={e => {
                          if (e.key === "Enter" && customStarterDraft.trim()) {
                            setFormData(prev => ({ ...prev, customStarters: [...prev.customStarters, customStarterDraft.trim()] }));
                            setCustomStarterDraft("");
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!customStarterDraft.trim()}
                        onClick={() => {
                          if (!customStarterDraft.trim()) return;
                          setFormData(prev => ({ ...prev, customStarters: [...prev.customStarters, customStarterDraft.trim()] }));
                          setCustomStarterDraft("");
                        }}
                        data-testid="button-add-custom-starter"
                        className="shrink-0 gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" /> {t("add_label")}
                      </Button>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {CONVERSATION_STARTERS.map(starter => {
                    const selected = formData.conversationStarters.includes(starter);
                    return (
                      <Badge
                        key={starter}
                        variant={selected ? "default" : "outline"}
                        className={`cursor-pointer text-sm py-2 px-4 transition-all ${
                          selected ? "bg-primary text-primary-foreground" : ""
                        }`}
                        onClick={() => toggleArrayItem("conversationStarters", starter, 3)}
                        data-testid={`badge-starter-${starter.slice(0, 20).toLowerCase().replace(/\s+/g, "-")}`}
                      >
                        {selected && <Check className="w-3 h-3 me-1" />}
                        {starter}
                      </Badge>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  {formData.conversationStarters.length}{t("starters_selected_count")}
                </p>
                {formData.conversationStarters.map(starter => (
                  <div key={starter} className="space-y-1.5">
                    <p className="text-sm font-medium text-primary">{starter}</p>
                    <Input
                      value={formData.starterAnswers[starter] || ""}
                      onChange={e => setFormData(prev => ({
                        ...prev,
                        starterAnswers: { ...prev.starterAnswers, [starter]: e.target.value }
                      }))}
                      placeholder={t("your_answer_ph")}
                      maxLength={200}
                      data-testid={`input-starter-answer-${starter.slice(0, 20).toLowerCase().replace(/\s+/g, "-")}`}
                    />
                  </div>
                ))}

              </div>
            )}

            {step === 3 && (
              <div className="space-y-3">
                {/* ── Questions for viewers to answer ─────────────────── */}
                <div className="space-y-2 pb-3 border-b">
                  <p className="text-sm font-semibold text-foreground">{t("write_own_question_title")}</p>
                  <p className="text-xs text-muted-foreground">{t("write_own_question_desc")}</p>
                  {formData.viewerQuestions.map((vq, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <p className="flex-1 text-sm border rounded-md px-3 py-2 bg-muted/30">{vq.question}</p>
                      <button
                        className="shrink-0 w-6 h-6 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                        onClick={() => setFormData(prev => ({ ...prev, viewerQuestions: prev.viewerQuestions.filter((_, j) => j !== i) }))}
                        data-testid={`button-remove-viewer-q-${i}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {formData.viewerQuestions.length < 3 && (
                    <div className="flex gap-2">
                      <Input
                        value={viewerQDraft}
                        onChange={e => setViewerQDraft(e.target.value)}
                        placeholder={t("ph_viewer_question")}
                        maxLength={150}
                        className="text-sm"
                        data-testid="input-viewer-q-draft"
                        onKeyDown={e => {
                          if (e.key === "Enter" && viewerQDraft.trim()) {
                            setFormData(prev => ({ ...prev, viewerQuestions: [...prev.viewerQuestions, { question: viewerQDraft.trim() }] }));
                            setViewerQDraft("");
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!viewerQDraft.trim()}
                        onClick={() => {
                          if (!viewerQDraft.trim()) return;
                          setFormData(prev => ({ ...prev, viewerQuestions: [...prev.viewerQuestions, { question: viewerQDraft.trim() }] }));
                          setViewerQDraft("");
                        }}
                        data-testid="button-add-viewer-q"
                        className="shrink-0 gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add
                      </Button>
                    </div>
                  )}
                </div>
                {PROFILE_QUESTIONS.map(question => {
                  const selected = formData.questions.includes(question);
                  return (
                    <Card
                      key={question}
                      className={`p-4 cursor-pointer transition-all hover-elevate ${
                        selected ? "border-primary bg-primary/5" : ""
                      }`}
                      onClick={() => toggleArrayItem("questions", question, 3)}
                      data-testid={`card-question-${question.slice(0, 25).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm">{question}</span>
                        {selected && (
                          <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                            <Check className="w-3 h-3 text-primary-foreground" />
                          </div>
                        )}
                      </div>
                    </Card>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  {formData.questions.length}{t("starters_selected_count")}
                </p>

                {/* ── Custom questions ─────────────────────────────────── */}
                <div className="pt-2 space-y-2">
                  <p className="text-xs font-medium tracking-wider uppercase text-primary">{t("write_own_question_title")}</p>
                  {(formData.customQuestions as Array<{ question: string; answer: string }>).map((cq, i) => (
                    <Card key={i} className="p-3 border-primary/30 bg-primary/3" data-testid={`card-custom-question-${i}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-primary truncate">{cq.question}</p>
                          {cq.answer && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{cq.answer}</p>}
                        </div>
                        <button
                          className="shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                          onClick={() => setFormData(prev => ({ ...prev, customQuestions: prev.customQuestions.filter((_: { question: string; answer: string }, j: number) => j !== i) }))}
                          data-testid={`button-remove-custom-question-${i}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </Card>
                  ))}

                  {formData.customQuestions.length < 3 && (
                    <Card className="p-3 space-y-2 border-dashed" data-testid="card-add-custom-question">
                      <p className="text-xs text-muted-foreground font-medium">{t("write_own_question_title")}</p>
                      <Input
                        value={customQDraft.question}
                        onChange={e => setCustomQDraft(prev => ({ ...prev, question: e.target.value }))}
                        placeholder={t("ph_custom_question")}
                        maxLength={150}
                        className="text-sm"
                        data-testid="input-custom-question-text"
                      />
                      <Input
                        value={customQDraft.answer}
                        onChange={e => setCustomQDraft(prev => ({ ...prev, answer: e.target.value }))}
                        placeholder={t("ph_your_answer")}
                        maxLength={200}
                        className="text-sm"
                        data-testid="input-custom-question-answer"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!customQDraft.question.trim() || !customQDraft.answer.trim()}
                        onClick={() => {
                          if (!customQDraft.question.trim() || !customQDraft.answer.trim()) return;
                          setFormData(prev => ({
                            ...prev,
                            customQuestions: [...prev.customQuestions, { question: customQDraft.question.trim(), answer: customQDraft.answer.trim() }],
                          }));
                          setCustomQDraft({ question: "", answer: "" });
                        }}
                        className="gap-1.5"
                        data-testid="button-add-custom-question"
                      >
                        <Plus className="w-3.5 h-3.5" /> {t("add_question_label")}
                      </Button>
                    </Card>
                  )}
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {SIGNALS.map(signal => (
                    <Badge
                      key={signal}
                      variant={formData.signals.includes(signal) ? "default" : "outline"}
                      className={`cursor-pointer text-sm py-2 px-4 transition-all ${
                        formData.signals.includes(signal) ? "bg-primary text-primary-foreground" : ""
                      }`}
                      onClick={() => toggleArrayItem("signals", signal, 5)}
                      data-testid={`badge-signal-${signal.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      {formData.signals.includes(signal) && <Check className="w-3 h-3 me-1" />}
                      {signal}
                    </Badge>
                  ))}
                  <p className="w-full text-xs text-muted-foreground mt-2">
                    {t("n_of_5_selected").replace("{n}", String(formData.signals.length))}
                  </p>
                </div>
                <div className="space-y-2 pt-2 border-t">
                  <p className="text-sm font-medium">{t("your_own_trait_label")} <span className="text-muted-foreground text-xs">{t("optional_up_to_3")}</span></p>
                  <div className="flex flex-wrap gap-2">
                    {formData.customSignals.map((s, i) => (
                      <Badge key={i} variant="secondary" className="gap-1.5 text-sm py-1.5 px-3">
                        {s}
                        <button onClick={() => setFormData(prev => ({ ...prev, customSignals: prev.customSignals.filter((_, j) => j !== i) }))} data-testid={`button-remove-custom-signal-${i}`}>
                          <X className="w-3 h-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                  {formData.customSignals.length < 3 && (
                    <div className="flex gap-2">
                      <Input
                        placeholder={t("ph_custom_signal")}
                        maxLength={40}
                        className="text-sm"
                        data-testid="input-custom-signal-draft"
                        onKeyDown={e => {
                          if (e.key === "Enter") {
                            const val = (e.target as HTMLInputElement).value.trim();
                            if (val) {
                              setFormData(prev => ({ ...prev, customSignals: [...prev.customSignals, val] }));
                              (e.target as HTMLInputElement).value = "";
                            }
                          }
                        }}
                      />
                      <Button size="sm" variant="outline" className="shrink-0 gap-1" data-testid="button-add-custom-signal"
                        onClick={e => {
                          const input = (e.currentTarget.previousElementSibling as HTMLInputElement);
                          const val = input?.value?.trim();
                          if (val) { setFormData(prev => ({ ...prev, customSignals: [...prev.customSignals, val] })); input.value = ""; }
                        }}>
                        <Plus className="w-3.5 h-3.5" /> {t("add_label")}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {step === 5 && (
              <div className="space-y-2.5">
                {DATING_INTENTS.map(intent => {
                  const selected = formData.datingIntent === intent;
                  return (
                    <button
                      key={intent}
                      type="button"
                      className="w-full text-start"
                      onClick={() => update("datingIntent", intent)}
                      data-testid={`card-intent-${intent.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <div
                        className="rounded-2xl border transition-all duration-200 active:scale-[0.99]"
                        style={{
                          padding: "16px 18px",
                          borderColor: selected ? "hsl(350 45% 52%)" : "hsl(var(--border))",
                          background: selected
                            ? "linear-gradient(135deg, hsl(350 45% 52% / 0.06) 0%, hsl(350 45% 52% / 0.02) 100%)"
                            : "hsl(var(--background))",
                          boxShadow: selected ? "0 0 0 1px hsl(350 45% 52% / 0.25)" : "none",
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3 min-w-0">
                            <span className="text-xl leading-none mt-0.5 shrink-0">{INTENT_ICONS[intent] ?? "💫"}</span>
                            <div className="min-w-0">
                              <p className={`font-semibold text-sm leading-snug ${selected ? "text-primary" : "text-foreground"}`}>
                                {intent}
                              </p>
                              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                                {INTENT_DESCRIPTIONS[intent] ?? ""}
                              </p>
                            </div>
                          </div>
                          <div
                            className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 transition-all duration-200"
                            style={{
                              background: selected ? "hsl(350 45% 52%)" : "transparent",
                              border: selected ? "none" : "1.5px solid hsl(var(--border))",
                            }}
                          >
                            {selected && <Check className="w-3 h-3 text-white" />}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {step === 6 && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {GREEN_FLAGS.map(flag => (
                    <Badge
                      key={flag}
                      variant={formData.greenFlags.includes(flag) ? "default" : "outline"}
                      className={`cursor-pointer text-sm py-2 px-4 transition-all ${
                        formData.greenFlags.includes(flag) ? "bg-primary text-primary-foreground" : ""
                      }`}
                      onClick={() => toggleArrayItem("greenFlags", flag, 4)}
                      data-testid={`badge-flag-${flag.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      {formData.greenFlags.includes(flag) && <Check className="w-3 h-3 me-1" />}
                      {flag}
                    </Badge>
                  ))}
                  <p className="w-full text-xs text-muted-foreground mt-2">
                    {t("n_of_4_selected_min3").replace("{n}", String(formData.greenFlags.length))}
                  </p>
                </div>
                <div className="space-y-2 pt-2 border-t">
                  <p className="text-sm font-medium">{t("your_own_green_flag_label")} <span className="text-muted-foreground text-xs">{t("optional_up_to_3")}</span></p>
                  <div className="flex flex-wrap gap-2">
                    {formData.customGreenFlags.map((f, i) => (
                      <Badge key={i} variant="outline" className="gap-1.5 text-sm py-1.5 px-3">
                        {f}
                        <button onClick={() => setFormData(prev => ({ ...prev, customGreenFlags: prev.customGreenFlags.filter((_, j) => j !== i) }))} data-testid={`button-remove-custom-flag-${i}`}>
                          <X className="w-3 h-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                  {formData.customGreenFlags.length < 3 && (
                    <div className="flex gap-2">
                      <Input
                        placeholder={t("ph_custom_green_flag")}
                        maxLength={40}
                        className="text-sm"
                        data-testid="input-custom-green-flag-draft"
                        onKeyDown={e => {
                          if (e.key === "Enter") {
                            const val = (e.target as HTMLInputElement).value.trim();
                            if (val) {
                              setFormData(prev => ({ ...prev, customGreenFlags: [...prev.customGreenFlags, val] }));
                              (e.target as HTMLInputElement).value = "";
                            }
                          }
                        }}
                      />
                      <Button size="sm" variant="outline" className="shrink-0 gap-1" data-testid="button-add-custom-green-flag"
                        onClick={e => {
                          const input = (e.currentTarget.previousElementSibling as HTMLInputElement);
                          const val = input?.value?.trim();
                          if (val) { setFormData(prev => ({ ...prev, customGreenFlags: [...prev.customGreenFlags, val] })); input.value = ""; }
                        }}>
                        <Plus className="w-3.5 h-3.5" /> Add
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {step === 7 && (
              <div className="space-y-3">
                {CONNECTION_STYLES.map(style => (
                  <Card
                    key={style}
                    className={`p-5 cursor-pointer transition-all hover-elevate ${
                      formData.connectionStyle === style ? "border-primary bg-primary/5" : ""
                    }`}
                    onClick={() => update("connectionStyle", style)}
                    data-testid={`card-style-${style.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{style}</span>
                      {formData.connectionStyle === style && (
                        <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                          <Check className="w-3 h-3 text-primary-foreground" />
                        </div>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-4 pt-4">
            {step > 0 ? (
              <Button variant="ghost" onClick={() => setStep(step - 1)} data-testid="button-back">
                <ArrowLeft className="w-4 h-4 me-2 rtl:rotate-180" /> Back
              </Button>
            ) : <div />}
            <Button
              onClick={handleNext}
              disabled={!canProceed() || createProfile.isPending}
              data-testid="button-next"
            >
              {step === STEP_KEYS.length - 1 ? (
                createProfile.isPending ? t("creating_profile_label") : t("complete_profile_label")
              ) : (
                <>Continue <ArrowRight className="w-4 h-4 ms-2 rtl:rotate-180" /></>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PhotoSlot({ index, photo, onSelect, onRemove }: {
  index: number;
  photo?: string;
  onSelect: (url: string) => void;
  onRemove: () => void;
}) {
  const { t } = useLanguageContext();
  const { toast } = useToast();
  const [converting, setConverting] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setConverting(true);
    try {
      const jpeg = await convertPhotoToJpeg(file);
      onSelect(jpeg);
    } catch (err: any) {
      toast({
        title: t("photo_not_added_title"),
        description: err?.message || t("photo_not_added_desc"),
        variant: "destructive",
      });
    } finally {
      setConverting(false);
    }
  };

  return (
    <div
      className="relative aspect-[3/4] rounded-xl overflow-hidden"
      style={{ border: "1px solid hsl(var(--border) / 0.45)" }}
      data-testid={`photo-slot-${index}`}
    >
      {converting ? (
        <div className="flex items-center justify-center w-full h-full bg-muted/30">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/50" />
        </div>
      ) : photo ? (
        <>
          <img src={photo} alt={`Photo ${index + 1}`} className="w-full h-full object-cover" />
          {index === 0 && (
            <div className="absolute bottom-2 left-2 pointer-events-none">
              <span className="text-[9px] font-bold tracking-widest uppercase text-white/90 bg-black/35 backdrop-blur-sm px-2 py-0.5 rounded-full">
                Main
              </span>
            </div>
          )}
          <button
            onClick={onRemove}
            className="absolute top-2 end-2 w-6 h-6 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center active:scale-90 transition-transform"
            data-testid={`button-remove-photo-${index}`}
          >
            <X className="w-3 h-3 text-white" />
          </button>
        </>
      ) : (
        <label
          className="flex flex-col items-center justify-center w-full h-full cursor-pointer gap-1.5 active:scale-95 transition-transform"
          style={{ background: "linear-gradient(135deg, hsl(var(--muted) / 0.55), hsl(var(--muted) / 0.30))" }}
        >
          <ImagePlus className="w-5 h-5 text-muted-foreground/35" />
          <span className="text-[11px] font-medium text-muted-foreground/45 tracking-wide">
            {index === 0 ? "Main photo" : "Add photo"}
          </span>
          <input
            type="file"
            accept="image/*"
            capture={undefined}
            onChange={handleFileChange}
            className="hidden"
            data-testid={`input-photo-${index}`}
          />
        </label>
      )}
    </div>
  );
}
