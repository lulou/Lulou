import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ChevronLeft, Dna, Check, Loader2 } from "lucide-react";
import { DNA_QUESTIONS } from "@/lib/dna-questions";
import { getAuthHeaders, API_BASE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLanguageContext } from "@/contexts/language-context";

const TOTAL = DNA_QUESTIONS.length;

// ── Local storage key for offline resume ────────────────────────────────────
const LS_KEY = "lulou_dna_progress";

function loadLocalProgress(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveLocalProgress(r: Record<string, number>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(r)); } catch {}
}
function clearLocalProgress() {
  try { localStorage.removeItem(LS_KEY); } catch {}
}

// ── Trait key computation ──────────────────────────────────────────────────────
// Returns i18n key strings (e.g. "trait_commDirectness_high") rather than
// English labels so the component can translate them at render time.
type TraitKey = string;

function computeTopTraitKeys(responses: Record<string, number>): TraitKey[] {
  const NEUTRAL = 50;
  const accum: Record<string, number[]> = {};

  for (const q of DNA_QUESTIONS) {
    const idx = responses[q.id];
    if (idx == null || idx < 0 || idx >= q.answers.length) continue;
    for (const [dim, val] of Object.entries(q.answers[idx].weights)) {
      if (!accum[dim]) accum[dim] = [];
      accum[dim].push(val as number);
    }
  }

  const scores: Record<string, number> = {};
  for (const [dim, vals] of Object.entries(accum)) {
    scores[dim] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  // Returns the i18n key suffix: "high" (≥62), "low" (≤38), or "mid"
  const TRAIT_DIMS = [
    "commDirectness", "emotionalDepth", "affectionStyle", "socialEnergy",
    "independence", "conflictRepair", "datingPace", "planningStyle",
    "futureAlignment", "playfulness", "commFrequency", "ambitionPriority",
    "availabilityScore", "lifestyle", "seriousness",
  ] as const;

  return Object.entries(scores)
    .filter(([dim]) => (TRAIT_DIMS as readonly string[]).includes(dim))
    .sort(([, a], [, b]) => Math.abs(b - NEUTRAL) - Math.abs(a - NEUTRAL))
    .slice(0, 4)
    .map(([dim, score]) => {
      const tier = score >= 62 ? "high" : score <= 38 ? "low" : "mid";
      return `trait_${dim}_${tier}`;
    });
}

export default function ConnectionDna() {
  const [, navigate]       = useLocation();
  const { toast }          = useToast();
  const { t }              = useLanguageContext();
  const queryClient        = useQueryClient();
  const [step, setStep]    = useState(0);         // 0 = intro, 1-N = questions, N+1 = done
  const [responses, setResponses]   = useState<Record<string, number>>({});
  const [direction, setDirection]   = useState<1 | -1>(1);
  const [saving, setSaving]         = useState(false);
  const [completing, setCompleting] = useState(false);
  const [loaded, setLoaded]         = useState(false);

  // ── Load saved progress on mount ──────────────────────────────────────────
  useEffect(() => {
    async function loadProgress() {
      const local = loadLocalProgress();
      // Try server first
      try {
        const res = await fetch(`${API_BASE}/api/dna/responses`, { headers: await getAuthHeaders() });
        if (res.ok) {
          const { responses: serverResponses } = await res.json();
          const merged = { ...local, ...serverResponses };
          setResponses(merged);
          // Resume at first unanswered question
          const firstUnanswered = DNA_QUESTIONS.findIndex(q => merged[q.id] == null);
          const resumeStep = firstUnanswered === -1 ? TOTAL : firstUnanswered;
          setStep(resumeStep > 0 ? resumeStep : 0);
          setLoaded(true);
          return;
        }
      } catch {}
      // Fall back to local
      setResponses(local);
      const firstUnanswered = DNA_QUESTIONS.findIndex(q => local[q.id] == null);
      const resumeStep = firstUnanswered === -1 ? TOTAL : firstUnanswered;
      setStep(resumeStep > 0 ? resumeStep : 0);
      setLoaded(true);
    }
    loadProgress();
  }, []);

  // ── Save single answer ─────────────────────────────────────────────────────
  const saveAnswer = useCallback(async (questionId: string, answerIndex: number) => {
    try {
      setSaving(true);
      await fetch(`${API_BASE}/api/dna/response`, {
        method: "POST",
        headers: { ...await getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, answerIndex }),
      });
    } catch {
      // Non-critical; local storage still has it
    } finally {
      setSaving(false);
    }
  }, []);

  // ── Handle answer selection ────────────────────────────────────────────────
  const handleAnswer = useCallback((questionId: string, answerIndex: number) => {
    const newResponses = { ...responses, [questionId]: answerIndex };
    setResponses(newResponses);
    saveLocalProgress(newResponses);
    void saveAnswer(questionId, answerIndex);

    setDirection(1);
    setTimeout(() => {
      setStep(s => s + 1);
    }, 180);
  }, [responses, saveAnswer]);

  // ── Go back ───────────────────────────────────────────────────────────────
  const goBack = useCallback(() => {
    setDirection(-1);
    setStep(s => Math.max(0, s - 1));
  }, []);

  // ── Complete quiz ─────────────────────────────────────────────────────────
  const completeQuiz = useCallback(async () => {
    setCompleting(true);
    try {
      const res = await fetch(`${API_BASE}/api/dna/complete`, {
        method: "POST",
        headers: await getAuthHeaders(),
      });
      if (!res.ok) throw new Error("Failed");
      clearLocalProgress();
      // Tell App.tsx gate that DNA is now complete so it unlocks the main app.
      queryClient.setQueryData(["dna-status-check"], { completed: true, hasDna: true });
      queryClient.setQueryData(["profile-exists-check"], (current: any) => current
        ? { ...current, exists: true }
        : { exists: true, fetchFailed: false, confirmedMissing: false });
      navigate("/");
    } catch {
      toast({ title: t("something_went_wrong"), description: t("dna_error_try_again"), variant: "destructive" });
    } finally {
      setCompleting(false);
    }
  }, [navigate, toast, queryClient, t]);

  if (!loaded) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  // Intro screen (step = 0)
  if (step === 0) {
    return (
      <div
        className="min-h-[100dvh] flex flex-col items-center justify-center px-6 py-12 bg-background"
        style={{
          paddingInlineStart: "max(1.5rem, env(safe-area-inset-left, 0px))",
          paddingInlineEnd: "max(1.5rem, env(safe-area-inset-right, 0px))",
          paddingTop: "max(3rem, env(safe-area-inset-top, 0px))",
          paddingBottom: "max(3rem, env(safe-area-inset-bottom, 0px))",
        }}
      >
        <div className="max-w-md w-full text-center space-y-8">
          <div className="flex flex-col items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Dna className="w-8 h-8 text-primary" />
            </div>
            <div className="space-y-2">
              <h1 className="font-serif text-3xl font-bold" data-testid="text-dna-title">{t("dna_intro_title")}</h1>
              <p className="text-muted-foreground leading-relaxed">
                {t("dna_intro_subtitle")}
              </p>
            </div>
          </div>

          <div className="bg-card border border-border/50 rounded-2xl p-6 space-y-4 text-left shadow-sm">
            <p className="text-sm font-semibold text-foreground">{t("dna_intro_what_this_does")}</p>
            <div className="space-y-3">
              {(["dna_intro_bullet_1", "dna_intro_bullet_2", "dna_intro_bullet_3"] as const).map((key, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Check className="w-3 h-3 text-primary" />
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{t(key)}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs text-muted-foreground/60">
              {t("dna_intro_privacy")}
            </p>
            <Button
              className="w-full rounded-full h-12 text-base"
              onClick={() => { setDirection(1); setStep(1); }}
              data-testid="button-start-dna"
            >
              {t("dna_intro_begin_btn")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Completion screen
  if (step > TOTAL) {
    const traitKeys = computeTopTraitKeys(responses);

    return (
      <div className="min-h-[100dvh] flex flex-col bg-background">
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-md mx-auto px-6 py-12 flex flex-col items-center text-center space-y-8">

            {/* Icon + heading */}
            <div className="flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Dna className="w-8 h-8 text-primary" />
              </div>
              <div className="space-y-2">
                <h2 className="font-serif text-3xl font-bold" data-testid="text-dna-complete-title">
                  {t("dna_complete_title")}
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  {t("dna_complete_subtitle")}
                </p>
              </div>
            </div>

            {/* Trait chips — computed from actual responses, translated at render */}
            {traitKeys.length > 0 && (
              <div className="w-full space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                  {t("dna_complete_signals_label")}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {traitKeys.map((key, i) => (
                    <span
                      key={i}
                      className="px-4 py-2 rounded-full text-sm font-medium bg-primary/10 text-primary border border-primary/20"
                    >
                      {t(key as Parameters<typeof t>[0])}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* What Lulou does with it */}
            <div className="w-full bg-card border border-border/50 rounded-2xl p-6 space-y-4 text-left shadow-sm">
              <p className="text-sm font-semibold text-foreground">{t("dna_complete_how_lulou_uses")}</p>
              <div className="space-y-3">
                {(["dna_complete_bullet_1", "dna_complete_bullet_2", "dna_complete_bullet_3", "dna_complete_bullet_4", "dna_complete_bullet_5"] as const).map((key, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-primary" />
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed">{t(key)}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Privacy note */}
            <p className="text-xs text-muted-foreground/60 leading-relaxed px-2">
              {t("dna_complete_privacy")}
            </p>

            {/* CTA */}
            <div className="w-full pb-8">
              <Button
                className="w-full rounded-full h-12 text-base"
                onClick={completeQuiz}
                disabled={completing}
                data-testid="button-finish-dna"
              >
                {completing
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("dna_complete_building")}</>
                  : t("dna_complete_cta")}
              </Button>
            </div>

          </div>
        </div>
      </div>
    );
  }

  // Question screen (step = 1..TOTAL)
  const qIdx      = step - 1;
  const question  = DNA_QUESTIONS[qIdx];
  const answered  = responses[question.id] ?? null;
  const progress  = Math.round(((step - 1) / TOTAL) * 100);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      {/* Header */}
      <div
        className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border/30 px-4 py-3"
        style={{
          paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))",
          paddingInlineStart: "max(1rem, env(safe-area-inset-left, 0px))",
          paddingInlineEnd: "max(1rem, env(safe-area-inset-right, 0px))",
        }}
      >
        <div className="max-w-lg mx-auto flex items-center gap-3">
          <button
            onClick={goBack}
            disabled={step === 1}
            className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted transition-colors disabled:opacity-30"
            aria-label={t("dna_go_back")}
            data-testid="button-dna-back"
          >
            <ChevronLeft className="w-5 h-5 rtl:rotate-180" />
          </button>
          <div className="flex-1">
            <Progress value={progress} className="h-1.5 bg-muted" />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums w-12 text-right">
            {step} / {TOTAL}
          </span>
          {saving && <Loader2 className="w-3 h-3 text-muted-foreground/50 animate-spin flex-shrink-0" />}
        </div>
      </div>

      {/* Question */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-8">
        <div className="max-w-lg w-full">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={question.id}
              initial={{ opacity: 0, x: direction * 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -40 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="space-y-6"
            >
              {/* Context hint */}
              <p className="text-xs text-muted-foreground/60 uppercase tracking-wider" data-testid="text-dna-context">
                {question.context}
              </p>

              {/* Prompt */}
              <h2 className="font-serif text-2xl font-semibold leading-snug" data-testid="text-dna-prompt">
                {question.prompt}
              </h2>

              {/* Answers */}
              <div className="space-y-3" role="radiogroup" aria-label={question.prompt}>
                {question.answers.map((answer, idx) => {
                  const isSelected = answered === idx;
                  return (
                    <button
                      key={idx}
                      onClick={() => handleAnswer(question.id, idx)}
                      role="radio"
                      aria-checked={isSelected}
                      data-testid={`button-dna-answer-${idx}`}
                      className={`
                        min-h-14 w-full rounded-2xl border px-5 py-4 text-start transition-all duration-150
                        text-sm leading-relaxed font-medium
                        ${isSelected
                          ? "border-primary bg-primary/8 text-foreground shadow-sm"
                          : "border-border/60 bg-card hover:border-primary/40 hover:bg-primary/4 text-foreground/80"
                        }
                      `}
                    >
                      <span className="flex items-start gap-3">
                        <span className={`
                          w-5 h-5 rounded-full border-2 flex-shrink-0 mt-0.5 transition-all flex items-center justify-center
                          ${isSelected ? "border-primary bg-primary" : "border-border"}
                        `}>
                          {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                        </span>
                        {answer.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Footer: skip to next if already answered */}
      {answered !== null && step < TOTAL && (
        <div className="px-6 flex justify-center" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom, 0px))" }}>
          <button
            onClick={() => { setDirection(1); setStep(s => s + 1); }}
            className="text-sm text-primary hover:underline"
            data-testid="button-dna-next"
          >
            {t("dna_next_question")}
          </button>
        </div>
      )}
      {answered !== null && step === TOTAL && (
        <div className="px-6 flex justify-center" style={{ paddingBottom: "max(2rem, env(safe-area-inset-bottom, 0px))" }}>
          <button
            onClick={() => { setDirection(1); setStep(s => s + 1); }}
            className="text-sm text-primary hover:underline"
            data-testid="button-dna-review"
          >
            {t("dna_review_answers")}
          </button>
        </div>
      )}
    </div>
  );
}
