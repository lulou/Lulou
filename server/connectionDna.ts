/**
 * Connection DNA — scoring engine
 *
 * Converts raw quiz answer indices into 15 compatibility dimensions (0–100),
 * then produces a weighted similarity score between two profiles.
 * Stores component scores and generates human-readable reasons for
 * the "Why Lulou introduced you" section on Discover cards.
 *
 * Algorithm version — bump ALGO_VERSION whenever weights or formulas change.
 */

export const ALGO_VERSION = "dna_v1";

// ── Dimension keys ──────────────────────────────────────────────────────────

export type DimKey =
  | "seriousness"
  | "commDirectness"
  | "emotionalDepth"
  | "affectionStyle"
  | "socialEnergy"
  | "independence"
  | "conflictRepair"
  | "datingPace"
  | "planningStyle"
  | "futureAlignment"
  | "playfulness"
  | "commFrequency"
  | "ambitionPriority"
  | "availabilityScore"
  | "lifestyle";

export type DnaDimensions = Record<DimKey, number>;

// ── Question / answer bank (mirrors client/src/lib/dna-questions.ts) ────────
// Server-side copy so we can compute scores without importing client code.

interface AnswerWeights {
  [dim: string]: number;
}

interface ServerQuestion {
  id: string;
  answers: AnswerWeights[];
}

const QUESTIONS: ServerQuestion[] = [
  { id: "q01", answers: [
    { commDirectness: 90, conflictRepair: 80 },
    { commDirectness: 45, independence: 65 },
    { playfulness: 70, commDirectness: 35 },
    { commDirectness: 15, independence: 55 },
    { commDirectness: 10, emotionalDepth: 60 },
  ]},
  { id: "q02", answers: [
    { socialEnergy: 80, planningStyle: 15, datingPace: 70 },
    { socialEnergy: 60, planningStyle: 70, datingPace: 55 },
    { socialEnergy: 25, planningStyle: 50, datingPace: 40 },
    { independence: 75, socialEnergy: 45, datingPace: 45 },
    { socialEnergy: 85, planningStyle: 55, datingPace: 60 },
  ]},
  { id: "q03", answers: [
    { seriousness: 95, futureAlignment: 90 },
    { seriousness: 75, futureAlignment: 65 },
    { seriousness: 50, futureAlignment: 45 },
    { seriousness: 45, futureAlignment: 50 },
    { seriousness: 20, futureAlignment: 20 },
  ]},
  { id: "q04", answers: [
    { affectionStyle: 90, emotionalDepth: 70 },
    { affectionStyle: 55, lifestyle: 60 },
    { affectionStyle: 35, independence: 65 },
    { affectionStyle: 65, emotionalDepth: 85, commDirectness: 70 },
    { affectionStyle: 60, playfulness: 75 },
  ]},
  { id: "q05", answers: [
    { conflictRepair: 90, commDirectness: 85 },
    { conflictRepair: 70, commDirectness: 55 },
    { conflictRepair: 75, commDirectness: 65 },
    { conflictRepair: 30, independence: 60 },
    { conflictRepair: 15, emotionalDepth: 65 },
  ]},
  { id: "q06", answers: [
    { datingPace: 85, commDirectness: 70 },
    { datingPace: 55, emotionalDepth: 60 },
    { datingPace: 40, affectionStyle: 70 },
    { datingPace: 50, planningStyle: 45 },
    { datingPace: 20, independence: 65 },
  ]},
  { id: "q07", answers: [
    { independence: 10, socialEnergy: 75 },
    { independence: 30, socialEnergy: 60 },
    { independence: 50, socialEnergy: 50 },
    { independence: 72, socialEnergy: 40 },
    { independence: 88, socialEnergy: 30 },
  ]},
  { id: "q08", answers: [
    { emotionalDepth: 92, playfulness: 25 },
    { emotionalDepth: 55, playfulness: 55 },
    { emotionalDepth: 50, playfulness: 50 },
    { playfulness: 80, emotionalDepth: 30 },
    { emotionalDepth: 20, datingPace: 35 },
  ]},
  { id: "q09", answers: [
    { planningStyle: 90, lifestyle: 70 },
    { planningStyle: 68, lifestyle: 55 },
    { planningStyle: 50, lifestyle: 50 },
    { planningStyle: 12, socialEnergy: 75 },
    { planningStyle: 50, independence: 35 },
  ]},
  { id: "q10", answers: [
    { futureAlignment: 92, seriousness: 85 },
    { futureAlignment: 68, seriousness: 75 },
    { futureAlignment: 25, lifestyle: 75 },
    { futureAlignment: 38, ambitionPriority: 82 },
    { futureAlignment: 55, seriousness: 55 },
  ]},
  { id: "q11", answers: [
    { commFrequency: 92, affectionStyle: 70 },
    { commFrequency: 65, lifestyle: 55 },
    { commFrequency: 45, independence: 50 },
    { commFrequency: 22, independence: 68 },
    { commFrequency: 50, emotionalDepth: 65 },
  ]},
  { id: "q12", answers: [
    { emotionalDepth: 90, playfulness: 28 },
    { emotionalDepth: 65, playfulness: 68 },
    { playfulness: 85, emotionalDepth: 28 },
    { emotionalDepth: 52, playfulness: 52 },
    { emotionalDepth: 50, playfulness: 50 },
  ]},
  { id: "q13", answers: [
    { lifestyle: 88, socialEnergy: 75, ambitionPriority: 70 },
    { lifestyle: 65, planningStyle: 70 },
    { lifestyle: 38, planningStyle: 50 },
    { lifestyle: 50, planningStyle: 15 },
    { lifestyle: 22, availabilityScore: 80 },
  ]},
  { id: "q14", answers: [
    { availabilityScore: 92, datingPace: 75 },
    { availabilityScore: 65, lifestyle: 60 },
    { availabilityScore: 42, seriousness: 45 },
    { availabilityScore: 58, seriousness: 70 },
    { availabilityScore: 28, seriousness: 40 },
  ]},
  { id: "q15", answers: [
    { ambitionPriority: 85, lifestyle: 72 },
    { ambitionPriority: 45, emotionalDepth: 70, conflictRepair: 70 },
    { ambitionPriority: 42, playfulness: 72 },
    { ambitionPriority: 38, affectionStyle: 78, emotionalDepth: 72 },
    { ambitionPriority: 52, socialEnergy: 78, planningStyle: 20 },
  ]},
];

/** Neutral / midpoint used when a dimension isn't covered by any answer. */
const NEUTRAL = 50;

/** All valid dimension keys */
const ALL_DIMS: DimKey[] = [
  "seriousness","commDirectness","emotionalDepth","affectionStyle",
  "socialEnergy","independence","conflictRepair","datingPace",
  "planningStyle","futureAlignment","playfulness","commFrequency",
  "ambitionPriority","availabilityScore","lifestyle",
];

/**
 * Compute a user's DNA profile from their raw quiz answers.
 * @param responses  Map of questionId → answer index (0-based)
 */
export function computeDnaProfile(responses: Record<string, number>): DnaDimensions {
  const accum: Record<string, number[]> = {};
  for (const dim of ALL_DIMS) accum[dim] = [];

  for (const q of QUESTIONS) {
    const answerIdx = responses[q.id];
    if (answerIdx == null || answerIdx < 0 || answerIdx >= q.answers.length) continue;
    const weights = q.answers[answerIdx];
    for (const [dim, val] of Object.entries(weights)) {
      if (!accum[dim]) accum[dim] = [];
      accum[dim].push(val as number);
    }
  }

  const result: Partial<DnaDimensions> = {};
  for (const dim of ALL_DIMS) {
    const vals = accum[dim];
    result[dim as DimKey] = vals.length > 0
      ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
      : NEUTRAL;
  }
  return result as DnaDimensions;
}

// ── Compatibility weights (must sum to ~1.0) ────────────────────────────────

const COMPAT_WEIGHTS: Record<DimKey, number> = {
  seriousness:       0.20,
  futureAlignment:   0.15,
  commDirectness:    0.10,
  emotionalDepth:    0.10,
  independence:      0.09,
  datingPace:        0.08,
  commFrequency:     0.07,
  lifestyle:         0.07,
  conflictRepair:    0.05,
  planningStyle:     0.04,
  affectionStyle:    0.03,
  availabilityScore: 0.02,
  socialEnergy:      0.00,   // useful for reasons but not weighted
  playfulness:       0.00,
  ambitionPriority:  0.00,
};

/**
 * Compute pairwise compatibility (0–100) from two DNA profiles.
 * Returns the total score and per-component breakdown.
 */
export function computeCompatibility(
  a: DnaDimensions,
  b: DnaDimensions,
): { total: number; components: Record<string, number> } {
  let total = 0;
  const components: Record<string, number> = {};

  for (const dim of ALL_DIMS) {
    const diff = Math.abs(a[dim] - b[dim]);
    const sim  = Math.max(0, 100 - diff);         // 0–100
    const w    = COMPAT_WEIGHTS[dim];
    components[dim] = Math.round(sim);
    total += sim * w;
  }

  // Add a small serendipity factor (0–5) — prevents identical top scores
  const serendipity = Math.random() * 5;

  return {
    total: Math.min(100, Math.round(total + serendipity)),
    components,
  };
}

// ── Reason generation ────────────────────────────────────────────────────────

interface DnaReason {
  key: string;
  text: string;
}

const REASON_TEMPLATES: Array<{
  dim: DimKey;
  threshold: number;
  highA: (val: number) => boolean;
  text: (aVal: number) => string;
}> = [
  {
    dim: "seriousness",
    threshold: 15,
    highA: (v) => v >= 65,
    text: (v) => v >= 65
      ? "You're both looking for a serious, committed relationship"
      : "You share a similar, relaxed approach to seeing where things lead",
  },
  {
    dim: "futureAlignment",
    threshold: 18,
    highA: (v) => v >= 60,
    text: (v) => v >= 60
      ? "Your visions for the future are closely aligned"
      : "You're both keeping an open mind about the future",
  },
  {
    dim: "emotionalDepth",
    threshold: 20,
    highA: (v) => v >= 60,
    text: (v) => v >= 60
      ? "You both value deep, meaningful conversations"
      : "You have a similar preference for keeping things light early on",
  },
  {
    dim: "commDirectness",
    threshold: 20,
    highA: () => true,
    text: (v) => v >= 60
      ? "You share a direct, honest communication style"
      : "You both tend toward a similar, thoughtful approach to difficult conversations",
  },
  {
    dim: "independence",
    threshold: 18,
    highA: (v) => v >= 60,
    text: (v) => v >= 60
      ? "You both value personal space and independence within a relationship"
      : "You're both looking for real closeness and togetherness",
  },
  {
    dim: "datingPace",
    threshold: 20,
    highA: () => true,
    text: (v) => v >= 60
      ? "You tend to move at a similar pace in relationships"
      : "You're both happy to take things slowly and let things develop",
  },
  {
    dim: "lifestyle",
    threshold: 20,
    highA: () => true,
    text: (v) => v >= 65
      ? "Your day-to-day lifestyles are well matched"
      : "You share a similar, relaxed approach to life",
  },
  {
    dim: "commFrequency",
    threshold: 22,
    highA: () => true,
    text: (v) => v >= 55
      ? "You're aligned on how often you like to stay in touch"
      : "You share a preference for meaningful contact over constant messaging",
  },
  {
    dim: "planningStyle",
    threshold: 22,
    highA: () => true,
    text: (v) => v >= 60
      ? "You have a similar, structured approach to plans and dates"
      : "You're both drawn to spontaneity and going with the moment",
  },
  {
    dim: "conflictRepair",
    threshold: 20,
    highA: (v) => v >= 60,
    text: () => "You tend to approach disagreements in similar ways",
  },
];

/**
 * Generate 2–3 human-readable reasons explaining why two profiles were introduced.
 * Uses the top-similarity dimensions.
 */
export function generateReasons(
  a: DnaDimensions,
  b: DnaDimensions,
  isVarietyPick: boolean,
): DnaReason[] {
  if (isVarietyPick) {
    return [
      {
        key: "variety",
        text: "A different kind of introduction — your backgrounds differ but your core values align",
      },
      ...generateReasons(a, b, false).slice(0, 1),
    ];
  }

  const scored = REASON_TEMPLATES
    .map((tpl) => {
      const diff = Math.abs(a[tpl.dim] - b[tpl.dim]);
      const sim  = 100 - diff;
      return { tpl, diff, sim, aVal: a[tpl.dim] };
    })
    .filter((r) => r.diff <= r.tpl.threshold && r.sim >= 78)
    .sort((x, y) => y.sim - x.sim);

  const reasons: DnaReason[] = scored.slice(0, 3).map(({ tpl, aVal }) => ({
    key: tpl.dim,
    text: tpl.text(aVal),
  }));

  if (reasons.length === 0) {
    reasons.push({
      key: "values",
      text: "Lulou thought you might connect well — sometimes the best introductions are unexpected",
    });
  }

  return reasons;
}

/**
 * Convert a DNA profile object to a plain JSON string for storage.
 */
export function serializeDna(profile: DnaDimensions): string {
  return JSON.stringify(profile);
}

/**
 * Parse a stored DNA JSON string back into a DnaDimensions object.
 * Returns null if invalid.
 */
export function deserializeDna(raw: string | null): DnaDimensions | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return null;
    return obj as DnaDimensions;
  } catch {
    return null;
  }
}

/**
 * Normalised DNA bonus for the discover scoring pipeline (0–20 points).
 * Returns 10 (neutral) when either profile is missing DNA data.
 */
export function dnaBonusScore(
  userDna: DnaDimensions | null,
  candidateDna: DnaDimensions | null,
): number {
  if (!userDna || !candidateDna) return 10; // neutral — no penalty for missing data
  const { total } = computeCompatibility(userDna, candidateDna);
  // Map 0–100 compatibility to 0–20 bonus points
  return Math.round((total / 100) * 20);
}
