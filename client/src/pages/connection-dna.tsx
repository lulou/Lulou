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

// ── Trait computation ─────────────────────────────────────────────────────────
// Scores 15 dimensions using the same answer-weight table the server uses, then
// picks the top 4 dimensions by absolute deviation from the neutral midpoint (50)
// — the most *characteristic* signals — and maps each to an evocative label.
function computeTopTraits(responses: Record<string, number>): string[] {
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

  // Labels vary with the actual score direction so they reflect the user's choices
  const TRAIT_MAP: Record<string, (s: number) => string> = {
    commDirectness:    s => s >= 62 ? "Direct communicator"           : s <= 38 ? "Reads between the lines"       : "Thoughtful communicator",
    emotionalDepth:    s => s >= 62 ? "Emotionally intentional"       : s <= 38 ? "Keeps things light"            : "Emotionally balanced",
    affectionStyle:    s => s >= 62 ? "Affectionate by nature"        : s <= 38 ? "Quietly devoted"               : "Shows care through actions",
    socialEnergy:      s => s >= 62 ? "Energised by people"           : s <= 38 ? "Cherishes quiet connection"    : "Comfortably social",
    independence:      s => s >= 62 ? "Values personal space"         : s <= 38 ? "Seeks deep togetherness"       : "Balances closeness and space",
    conflictRepair:    s => s >= 62 ? "Resolves conflict openly"      : s <= 38 ? "Needs time to process"         : "Works through disagreement",
    datingPace:        s => s >= 62 ? "Connects quickly"              : s <= 38 ? "Slow-burn connection"          : "Takes time to feel sure",
    planningStyle:     s => s >= 62 ? "Values structure"              : s <= 38 ? "Spontaneous at heart"          : "Balances plans and flow",
    futureAlignment:   s => s >= 62 ? "Clear about the future"        : s <= 38 ? "Open to where life leads"      : "Future-aware",
    playfulness:       s => s >= 62 ? "Playful and lighthearted"      : s <= 38 ? "Grounded and thoughtful"       : "Earnest with a lighter side",
    commFrequency:     s => s >= 62 ? "Loves staying connected"       : s <= 38 ? "Communicates with purpose"     : "Consistent communicator",
    ambitionPriority:  s => s >= 62 ? "Driven by purpose"             : s <= 38 ? "Values presence over ambition" : "Balances ambition and connection",
    availabilityScore: s => s >= 62 ? "Fully invested in dating"      : s <= 38 ? "Dating around a full life"    : "Intentionally available",
    lifestyle:         s => s >= 62 ? "Active, full lifestyle"        : s <= 38 ? "Calm and considered pace"      : "Balanced lifestyle",
    seriousness:       s => s >= 62 ? "Relationship intentional"      : s <= 38 ? "Living in the moment"          : "Open to commitment",
  };

  return Object.entries(scores)
    .filter(([dim]) => TRAIT_MAP[dim])
    .sort(([, a], [, b]) => Math.abs(b - NEUTRAL) - Math.abs(a - NEUTRAL))
    .slice(0, 4)
    .map(([dim, score]) => TRAIT_MAP[dim](score));
}

export default function ConnectionDna() {
  const [, navigate]       = useLocation();
  const { toast }          = useToast();
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
      navigate("/discover");
    } catch {
      toast({ title: "Something went wrong", description: "Please try again.", variant: "destructive" });
    } finally {
      setCompleting(false);
    }
  }, [navigate, toast, queryClient]);

  if (!loaded) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  // Intro screen (step = 0)
  if (step === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12 bg-background">
        <div className="max-w-md w-full text-center space-y-8">
          <div className="flex flex-col items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Dna className="w-8 h-8 text-primary" />
            </div>
            <div className="space-y-2">
              <h1 className="font-serif text-3xl font-bold" data-testid="text-dna-title">Connection DNA</h1>
              <p className="text-muted-foreground leading-relaxed">
                15 quick questions to understand how you connect — not just what you look like.
              </p>
            </div>
          </div>

          <div className="bg-card border border-border/50 rounded-2xl p-6 space-y-4 text-left shadow-sm">
            <p className="text-sm font-semibold text-foreground">What this does</p>
            <div className="space-y-3">
              {[
                "Matches you with people who connect the way you do",
                "Helps us explain why we introduced two people",
                "Improves over time as Lulou learns from real interactions",
              ].map((item, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Check className="w-3 h-3 text-primary" />
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{item}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs text-muted-foreground/60">
              Your answers are private. We never share raw scores with other users.
            </p>
            <Button
              className="w-full rounded-full h-12 text-base"
              onClick={() => { setDirection(1); setStep(1); }}
              data-testid="button-start-dna"
            >
              Begin — takes about 3 minutes
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Completion screen
  if (step > TOTAL) {
    const traits = computeTopTraits(responses);

    return (
      <div className="min-h-screen flex flex-col bg-background">
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-md mx-auto px-6 py-12 flex flex-col items-center text-center space-y-8">

            {/* Icon + heading */}
            <div className="flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Dna className="w-8 h-8 text-primary" />
              </div>
              <div className="space-y-2">
                <h2 className="font-serif text-3xl font-bold" data-testid="text-dna-complete-title">
                  Your Connection DNA is ready
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  Your answers help Lulou understand how you communicate, connect, build trust, and approach relationships.
                </p>
              </div>
            </div>

            {/* Trait chips — computed from actual responses */}
            {traits.length > 0 && (
              <div className="w-full space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                  Your strongest signals
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {traits.map((trait, i) => (
                    <span
                      key={i}
                      className="px-4 py-2 rounded-full text-sm font-medium bg-primary/10 text-primary border border-primary/20"
                    >
                      {trait}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* What Lulou does with it */}
            <div className="w-full bg-card border border-border/50 rounded-2xl p-6 space-y-4 text-left shadow-sm">
              <p className="text-sm font-semibold text-foreground">How Lulou uses your DNA</p>
              <div className="space-y-3">
                {[
                  "Ranks more compatible profiles higher on Discover",
                  "Identifies shared values and communication styles",
                  "Improves the quality of introductions over time",
                  "Generates meaningful compatibility reasons",
                  "Learns what type of connection works best for you",
                ].map((item, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-primary" />
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed">{item}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Privacy note */}
            <p className="text-xs text-muted-foreground/60 leading-relaxed px-2">
              Your individual answers are private. Other members only see selected profile signals and compatibility insights.
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
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Building your profile…</>
                  : "See my connections"}
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
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border/30 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center gap-3">
          <button
            onClick={goBack}
            disabled={step === 1}
            className="p-2 rounded-full hover:bg-muted transition-colors disabled:opacity-30"
            aria-label="Go back"
            data-testid="button-dna-back"
          >
            <ChevronLeft className="w-5 h-5" />
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
                        w-full text-left px-5 py-4 rounded-2xl border transition-all duration-150
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
        <div className="pb-8 px-6 flex justify-center">
          <button
            onClick={() => { setDirection(1); setStep(s => s + 1); }}
            className="text-sm text-primary hover:underline"
            data-testid="button-dna-next"
          >
            Next question →
          </button>
        </div>
      )}
      {answered !== null && step === TOTAL && (
        <div className="pb-8 px-6 flex justify-center">
          <button
            onClick={() => { setDirection(1); setStep(s => s + 1); }}
            className="text-sm text-primary hover:underline"
            data-testid="button-dna-review"
          >
            Review answers →
          </button>
        </div>
      )}
    </div>
  );
}
