import { useState } from "react";
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
import { Loader2, ArrowRight, ArrowLeft, Check, AlertCircle } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import type { Profile } from "@shared/schema";
import { convertPhotoToJpeg } from "@/lib/photo-utils";
import { useUnits, formatDistance } from "@/lib/units";

const STEPS = ["Basics", "Photos", "Starters", "Questions", "Signals", "Intent", "Green Flags", "Pace"];

function RadiusLabel({ locationRadius }: { locationRadius: number }) {
  const [units] = useUnits();
  return <Label>Search Radius: {formatDistance(locationRadius, units)}</Label>;
}

function RadiusDescription({ locationRadius }: { locationRadius: number }) {
  const [units] = useUnits();
  return (
    <p className="text-xs text-muted-foreground">
      People within {formatDistance(locationRadius, units)} of your location
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
    };
  }

  const { starters, answers } = parseStoredStarters(profile.conversationStarters ?? []);

  return {
    firstName: profile.firstName && profile.firstName !== "New User" ? profile.firstName : "",
    age: (profile.age ?? 0) >= 18 ? profile.age! : 25,
    dateOfBirth: "",
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

  const createProfile = useMutation({
    mutationFn: async () => {
      const fullStarters = formData.conversationStarters
        .filter(s => formData.starterAnswers[s])
        .map(s => `${s} ${formData.starterAnswers[s]}`);
      const { starterAnswers, ...rest } = formData;
      const payload = {
        ...rest,
        conversationStarters: fullStarters,
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

  const handleNext = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
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
            <div className="flex items-center gap-2 mb-6">
              {STEPS.map((s, i) => (
                <div
                  key={s}
                  className={`h-1 flex-1 rounded-md transition-colors duration-300 ${i <= step ? "bg-primary" : "bg-muted"}`}
                  data-testid={`progress-step-${i}`}
                />
              ))}
            </div>
            <p className="text-xs font-medium tracking-wider uppercase text-primary">{STEPS[step]}</p>
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
                  <Label htmlFor="dob">Date of Birth</Label>
                  <Input
                    id="dob"
                    type="date"
                    max={new Date(Date.now() - 18 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}
                    value={formData.dateOfBirth}
                    onChange={e => {
                      const dob = e.target.value;
                      update("dateOfBirth", dob);
                      if (dob) update("age", calculateAgeFromDob(dob));
                    }}
                    data-testid="input-dob"
                  />
                  {formData.dateOfBirth && calculateAgeFromDob(formData.dateOfBirth) < 18 && (
                    <p className="text-xs text-destructive flex items-center gap-1.5 mt-1" data-testid="text-under-18-error">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      You must be 18 or older to use Lulou.
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
                  <Label htmlFor="location">{t("label_location")}</Label>
                  <Input
                    id="location"
                    value={formData.location}
                    onChange={e => update("location", e.target.value)}
                    placeholder={t("ph_location")}
                    data-testid="input-location"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="height">{t("label_height_opt")}</Label>
                  <Input
                    id="height"
                    value={formData.height}
                    onChange={e => update("height", e.target.value)}
                    placeholder={t("ph_height")}
                    data-testid="input-height"
                  />
                </div>
                <div className="space-y-2">
                  <RadiusLabel locationRadius={formData.locationRadius} />
                  <Slider
                    value={[formData.locationRadius]}
                    onValueChange={([v]) => update("locationRadius", v)}
                    min={5}
                    max={100}
                    step={5}
                    className="py-2"
                    data-testid="slider-radius"
                  />
                  <RadiusDescription locationRadius={formData.locationRadius} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email address</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={e => update("email", e.target.value)}
                    placeholder="your@email.com"
                    data-testid="input-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phoneNumber">Phone number (optional)</Label>
                  <Input
                    id="phoneNumber"
                    type="tel"
                    value={formData.phoneNumber}
                    onChange={e => update("phoneNumber", e.target.value)}
                    placeholder="e.g. +44 7700 900123"
                    data-testid="input-phone-number"
                  />
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
                  {formData.photos.length}/6 photos added (minimum 2)
                </p>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
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
                        {selected && <Check className="w-3 h-3 mr-1" />}
                        {starter}
                      </Badge>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  {formData.conversationStarters.length}/3 selected (min 2)
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
                      placeholder="Your answer..."
                      maxLength={200}
                      data-testid={`input-starter-answer-${starter.slice(0, 20).toLowerCase().replace(/\s+/g, "-")}`}
                    />
                  </div>
                ))}
              </div>
            )}

            {step === 3 && (
              <div className="space-y-3">
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
                  {formData.questions.length}/3 selected (min 2)
                </p>
              </div>
            )}

            {step === 4 && (
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
                    {formData.signals.includes(signal) && <Check className="w-3 h-3 mr-1" />}
                    {signal}
                  </Badge>
                ))}
                <p className="w-full text-xs text-muted-foreground mt-2">
                  {formData.signals.length}/5 selected
                </p>
              </div>
            )}

            {step === 5 && (
              <div className="space-y-3">
                {DATING_INTENTS.map(intent => (
                  <Card
                    key={intent}
                    className={`p-5 cursor-pointer transition-all hover-elevate ${
                      formData.datingIntent === intent ? "border-primary bg-primary/5" : ""
                    }`}
                    onClick={() => update("datingIntent", intent)}
                    data-testid={`card-intent-${intent.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{intent}</span>
                      {formData.datingIntent === intent && (
                        <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                          <Check className="w-3 h-3 text-primary-foreground" />
                        </div>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {step === 6 && (
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
                    {formData.greenFlags.includes(flag) && <Check className="w-3 h-3 mr-1" />}
                    {flag}
                  </Badge>
                ))}
                <p className="w-full text-xs text-muted-foreground mt-2">
                  {formData.greenFlags.length}/4 selected (minimum 3)
                </p>
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
                <ArrowLeft className="w-4 h-4 mr-2" /> Back
              </Button>
            ) : <div />}
            <Button
              onClick={handleNext}
              disabled={!canProceed() || createProfile.isPending}
              data-testid="button-next"
            >
              {step === STEPS.length - 1 ? (
                createProfile.isPending ? "Creating..." : "Complete Profile"
              ) : (
                <>Continue <ArrowRight className="w-4 h-4 ml-2" /></>
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
        title: "Photo not added",
        description: err?.message || "Could not process this photo. Try a JPEG or PNG.",
        variant: "destructive",
      });
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="relative aspect-[3/4] rounded-md bg-muted border-2 border-dashed border-muted-foreground/20 overflow-hidden group" data-testid={`photo-slot-${index}`}>
      {converting ? (
        <div className="flex items-center justify-center w-full h-full">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : photo ? (
        <>
          <img src={photo} alt={`Photo ${index + 1}`} className="w-full h-full object-cover" />
          <button
            onClick={onRemove}
            className="absolute top-1 right-1 w-6 h-6 rounded-full bg-background/80 flex items-center justify-center text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            data-testid={`button-remove-photo-${index}`}
          >
            x
          </button>
        </>
      ) : (
        <label className="flex items-center justify-center w-full h-full cursor-pointer text-muted-foreground/40 text-2xl font-light">
          +
          <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" data-testid={`input-photo-${index}`} />
        </label>
      )}
    </div>
  );
}
