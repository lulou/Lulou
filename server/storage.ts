import {
  type Profile, type InsertProfile,
  type Interaction, type InsertInteraction,
  type Match, type Message, type InsertMessage,
  type SpinRequest, type BlockedContact,
  type SavedWheelProfile,
  userElevates, blockedContacts, callCredits, savedWheelProfiles,
  membershipSubscriptions, userBenefits, sparkBalances, sparkPurchases,
} from "@shared/schema";
import { supabase as defaultSupabase } from "./supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { db, pool as localPool } from "./db";
import { eq, gt, sql, and, or, asc } from "drizzle-orm";
import { dnaBonusScore, deserializeDna, type DnaDimensions } from "./connectionDna";

const IS_DEV = process.env.NODE_ENV !== "production";

// ─── Elevate weights ──────────────────────────────────────────────────────────
// Normal = 1x, Elevate = 3x, Super Elevate = 8x
const ELEVATE_WEIGHT: Record<string, number> = {
  super_elevate: 8,
  elevate: 3,
};
const NORMAL_WEIGHT = 1;

function elevateWeight(p: Profile, now: Date): number {
  if (!p.elevateType || !p.elevateExpiresAt || p.elevateExpiresAt <= now) return NORMAL_WEIGHT;
  return ELEVATE_WEIGHT[p.elevateType] ?? NORMAL_WEIGHT;
}

/**
 * Weighted sampling without replacement.
 * Profiles with higher weights are proportionally more likely to appear early
 * in the result list, but every profile eventually gets a fair chance.
 * Multiple elevated users rotate fairly — no single user blocks everyone else.
 */
function weightedSample(pool: Profile[], count: number, now: Date): Profile[] {
  if (pool.length === 0) return [];
  const result: Profile[] = [];
  const remaining = pool.map(p => ({ p, w: elevateWeight(p, now) }));

  while (result.length < count && remaining.length > 0) {
    const total = remaining.reduce((s, r) => s + r.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < remaining.length; i++) {
      r -= remaining[i].w;
      if (r <= 0) { idx = i; break; }
    }
    result.push(remaining[idx].p);
    remaining.splice(idx, 1);
  }
  return result;
}

async function getActiveElevatesMap(): Promise<Map<string, { type: string; expiresAt: Date }>> {
  const now = new Date();
  const rows = await db.select().from(userElevates).where(gt(userElevates.expiresAt, now));
  const map = new Map<string, { type: string; expiresAt: Date }>();
  for (const row of rows) {
    map.set(row.userId, { type: row.elevateType, expiresAt: row.expiresAt });
  }
  return map;
}

function mergeElevatesIntoProfiles(
  profiles: Profile[],
  elevates: Map<string, { type: string; expiresAt: Date }>,
): Profile[] {
  return profiles.map(p => {
    const elev = elevates.get(p.userId);
    if (elev) return { ...p, elevateType: elev.type, elevateExpiresAt: elev.expiresAt };
    return { ...p, elevateType: null, elevateExpiresAt: null };
  });
}

// ─── Discover ranking ─────────────────────────────────────────────────────────

interface ScoreBreakdown {
  distance: number;        // 0–20
  recency: number;         // 0–20
  photoVerified: number;   // 0 or 10
  completeness: number;    // 0–12
  sharedIntent: number;    // 0 or 8
  sharedStyle: number;     // 0 or 7
  membership: number;      // 0 or 5
  newUser: number;         // 0–5
  jitter: number;          // ±2
  base: number;
  elevateMultiplier: number;
  final: number;
}

/**
 * Score a single candidate profile for the current user.
 * Returns a breakdown + `final` score used for ranking.
 * Higher = appears earlier in Discover.
 * Scores are internal — never sent to the client.
 */
function scoreProfile(
  candidate: Profile,
  userLat: number | null,
  userLng: number | null,
  locationRadius: number,
  userDatingIntent: string | null,
  userConnectionStyle: string | null,
  memberUserIds: Set<string>,
  now: Date,
): ScoreBreakdown {
  // 1. Distance closeness (0–20)
  // No radius or no coords → neutral score (doesn't penalise global users).
  // When radius is active the hard filter already excluded out-of-range profiles,
  // so the score just rewards closer candidates within the circle.
  let distance = 10;
  if (
    _hasLatLngColumns &&
    userLat !== null && userLng !== null &&
    locationRadius > 0 &&
    candidate.latitude != null && candidate.longitude != null
  ) {
    const miles = haversineDistanceMiles(userLat, userLng, candidate.latitude, candidate.longitude);
    distance = Math.max(0, Math.round(20 * (1 - miles / locationRadius)));
  }

  // 2. Recently active (0–20) — exponential-like tiers
  let recency = 0;
  if ((candidate as any).lastActive) {
    const ageHours = (now.getTime() - (candidate as any).lastActive.getTime()) / 3_600_000;
    if (ageHours < 24)         recency = 20;
    else if (ageHours < 168)   recency = 14; // 7 days
    else if (ageHours < 720)   recency = 8;  // 30 days
    else if (ageHours < 2160)  recency = 3;  // 90 days
  }

  // 3. Selfie / photo verified (0 or 10)
  const photoVerified = candidate.photoVerified ? 10 : 0;

  // 4. Profile completeness (0–12, 2 pts per completed section)
  let completeness = 0;
  if ((candidate.signals?.length ?? 0) > 0)                  completeness += 2;
  if ((candidate.greenFlags?.length ?? 0) > 0)               completeness += 2;
  if (candidate.datingIntent)                                 completeness += 2;
  if (candidate.connectionStyle)                              completeness += 2;
  if ((candidate.conversationStarters?.length ?? 0) > 0)     completeness += 2;
  if (((candidate as any).customStarters?.length ?? 0) > 0)  completeness += 2;

  // 5. Shared dating intent (0 or 8)
  const sharedIntent =
    userDatingIntent &&
    candidate.datingIntent &&
    userDatingIntent.trim().toLowerCase() === candidate.datingIntent.trim().toLowerCase()
      ? 8 : 0;

  // 6. Shared connection style (0 or 7)
  const sharedStyle =
    userConnectionStyle &&
    candidate.connectionStyle &&
    userConnectionStyle.trim().toLowerCase() === candidate.connectionStyle.trim().toLowerCase()
      ? 7 : 0;

  // 7. Membership priority discovery boost (0 or 5)
  // Members' profiles appear higher in others' Discover queues.
  const membership = memberUserIds.has(candidate.userId) ? 5 : 0;

  // 8. New-user boost (0–5) — helps recently-joined profiles get early visibility
  let newUser = 0;
  if (candidate.createdAt) {
    const ageDays = (now.getTime() - candidate.createdAt.getTime()) / 86_400_000;
    if (ageDays < 7)       newUser = 5;
    else if (ageDays < 14) newUser = 3;
    else if (ageDays < 30) newUser = 1;
  }

  // 9. Jitter (±2) — prevents identical top-20 on every Discover load
  const jitter = Math.random() * 4 - 2;

  const base = distance + recency + photoVerified + completeness +
               sharedIntent + sharedStyle + membership + newUser;

  // 10. Elevate multiplier (applied to base score, not jitter)
  let elevateMultiplier = 1.0;
  if (
    candidate.elevateType &&
    candidate.elevateExpiresAt &&
    candidate.elevateExpiresAt > now
  ) {
    elevateMultiplier = candidate.elevateType === "super_elevate" ? 2.5 : 1.8;
  }

  const final = base * elevateMultiplier + jitter;

  return {
    distance, recency, photoVerified, completeness,
    sharedIntent, sharedStyle, membership, newUser,
    jitter, base, elevateMultiplier, final,
  };
}

/**
 * Score, sort, log (DEV), and diversity-interleave a pool of profiles.
 * Returns at most `limit` profiles.
 */
function rankAndDiversify(
  pool: Profile[],
  userLat: number | null,
  userLng: number | null,
  locationRadius: number,
  userDatingIntent: string | null,
  userConnectionStyle: string | null,
  memberUserIds: Set<string>,
  now: Date,
  limit: number,
): Profile[] {
  if (pool.length === 0) return [];

  // Score every candidate
  const scored = pool.map(p => ({
    profile: p,
    s: scoreProfile(p, userLat, userLng, locationRadius, userDatingIntent, userConnectionStyle, memberUserIds, now),
  }));

  // Sort descending by final score
  scored.sort((a, b) => b.s.final - a.s.final);

  // DEV: readable breakdown for the top candidates
  if (IS_DEV) {
    scored.slice(0, Math.min(8, scored.length)).forEach(({ profile: p, s }) => {
      const name = (p as any).firstName ?? p.userId.slice(0, 8);
      const elev = s.elevateMultiplier > 1 ? ` ×${s.elevateMultiplier}` : "";
      console.log(
        `[SCORE] ${name} | final=${s.final.toFixed(1)}${elev} | ` +
        `base=${s.base} [dist=${s.distance} rec=${s.recency} verified=${s.photoVerified} ` +
        `complete=${s.completeness} intent=${s.sharedIntent} style=${s.sharedStyle} ` +
        `member=${s.membership} newUser=${s.newUser} jitter=${s.jitter.toFixed(1)}]`,
      );
    });
  }

  // Take top results then diversity-interleave by dating intent so users don't
  // see the same intent type repeated consecutively across all cards.
  const top = scored.slice(0, limit).map(s => s.profile);
  return diversifyProfiles(top);
}

/**
 * Round-robin interleave by datingIntent so consecutive Discover cards vary.
 * Preserves score order within each intent bucket.
 */
function diversifyProfiles(profiles: Profile[]): Profile[] {
  if (profiles.length <= 3) return profiles;
  const buckets = new Map<string, Profile[]>();
  for (const p of profiles) {
    const key = p.datingIntent ?? "__none__";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(p);
  }
  if (buckets.size === 1) return profiles; // already homogeneous — nothing to interleave
  const groups = [...buckets.values()];
  const result: Profile[] = [];
  let i = 0;
  while (result.length < profiles.length) {
    let picked = false;
    for (let attempt = 0; attempt < groups.length; attempt++) {
      const g = groups[(i + attempt) % groups.length];
      if (g.length > 0) {
        result.push(g.shift()!);
        i = (i + attempt + 1) % groups.length;
        picked = true;
        break;
      }
    }
    if (!picked) break;
  }
  return result;
}

/** Fetch user IDs with an active membership subscription from the local DB. */
async function getActiveMemberUserIds(): Promise<Set<string>> {
  const rows = await db
    .select({ userId: membershipSubscriptions.userId })
    .from(membershipSubscriptions)
    .where(eq(membershipSubscriptions.status, "active"));
  return new Set(rows.map(r => r.userId));
}

// ─── Taste profile — preference learning ─────────────────────────────────────
//
// Lulou learns what each user is genuinely attracted to by analysing their
// recent positive interactions (opens).  The taste profile is a lightweight
// feature vector derived from the last 50 opens; it adjusts the Discover
// ranking bonus without overriding the core quality/compatibility signals.
//
// Anti-filter-bubble: 25 % of every Discover batch is reserved for exploratory
// profiles that would NOT appear if the algorithm ran purely on learned taste.
// This keeps variety high and prevents preference narrowing over time.
//
// Anti-abuse: minimum 5 positive interactions before personalisation activates
// (cold-start protection); 30-minute cache so rapid fake-liking can't
// continuously retrain the profile mid-session.

interface TasteProfile {
  sampleSize: number;
  ageCenter: number | null;        // weighted avg age of opened profiles
  intentWeights: Map<string, number>;   // dating_intent  → 0–1 affinity weight
  styleWeights: Map<string, number>;    // connection_style → 0–1 affinity weight
  prefersVerified: number;         // 0–1 fraction of opens that were verified
  prefersActive: number;           // 0–1 fraction of opens with recent activity
  topSignals: Map<string, number>; // personality signal → normalised frequency
  computedAt: Date;
}

// In-process taste cache: keyed by userId, TTL 30 minutes.
const _tasteCache = new Map<string, TasteProfile>();
const TASTE_TTL_MS = 30 * 60_000;

/**
 * Derive a preference profile from the user's recent "open" interactions.
 * Returns null when the user has fewer than 5 opens (cold start).
 * Results are cached for 30 minutes.
 */
async function computeTasteProfile(
  userId: string,
  sb: SupabaseClient,
  now: Date,
): Promise<TasteProfile | null> {
  const cached = _tasteCache.get(userId);
  if (cached && now.getTime() - cached.computedAt.getTime() < TASTE_TTL_MS) return cached;

  // Fetch positive signals (opens) — limited to last 50 to bound query cost.
  const { data: openRows } = await sb
    .from("interactions")
    .select("to_user_id, created_at")
    .eq("from_user_id", userId)
    .eq("type", "open")
    .order("created_at", { ascending: false })
    .limit(50);

  if (!openRows || openRows.length < 5) return null; // cold start — no personalisation

  // Fetch a lightweight profile snapshot for each opened user.
  const openIds = (openRows as any[]).map((r) => r.to_user_id as string);
  const { data: profileRows } = await sb
    .from("profiles")
    .select("user_id, age, dating_intent, connection_style, photo_verified, last_active, signals")
    .in("user_id", openIds);

  if (!profileRows || profileRows.length === 0) return null;

  const profileMap = new Map((profileRows as any[]).map((p) => [p.user_id as string, p]));

  let weightedAgeSum = 0, weightedAgeCount = 0;
  let verifiedWeight = 0, activeWeight = 0, totalWeight = 0;
  const intentWeights  = new Map<string, number>();
  const styleWeights   = new Map<string, number>();
  const signalCounts   = new Map<string, number>();

  (openRows as any[]).forEach((row, idx) => {
    const p = profileMap.get(row.to_user_id as string);
    if (!p) return;
    // Recency decay: most-recent open = weight 1.0; 50th open ≈ weight 0.1.
    const w = 1.0 - (idx / openRows.length) * 0.9;
    totalWeight += w;

    if (p.age != null) { weightedAgeSum += p.age * w; weightedAgeCount += w; }
    if (p.dating_intent)    intentWeights.set(p.dating_intent,    (intentWeights.get(p.dating_intent)    ?? 0) + w);
    if (p.connection_style) styleWeights.set(p.connection_style,  (styleWeights.get(p.connection_style)  ?? 0) + w);
    if (p.photo_verified)   verifiedWeight += w;

    const lastActive = p.last_active ? new Date(p.last_active) : null;
    if (lastActive && now.getTime() - lastActive.getTime() < 7 * 86_400_000) activeWeight += w;

    if (Array.isArray(p.signals)) {
      (p.signals as string[]).forEach(s => signalCounts.set(s, (signalCounts.get(s) ?? 0) + w));
    }
  });

  // Normalise all weight maps to 0–1 so no single dimension dominates.
  const normalise = (m: Map<string, number>): Map<string, number> => {
    const max = Math.max(...m.values(), 1);
    return new Map([...m.entries()].map(([k, v]) => [k, v / max]));
  };

  const taste: TasteProfile = {
    sampleSize: openRows.length,
    ageCenter: weightedAgeCount > 0 ? weightedAgeSum / weightedAgeCount : null,
    intentWeights:  normalise(intentWeights),
    styleWeights:   normalise(styleWeights),
    prefersVerified: totalWeight > 0 ? verifiedWeight / totalWeight : 0.5,
    prefersActive:   totalWeight > 0 ? activeWeight   / totalWeight : 0.5,
    topSignals:      normalise(signalCounts),
    computedAt: now,
  };

  _tasteCache.set(userId, taste);

  if (IS_DEV) {
    const topIntents = [...taste.intentWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k}:${v.toFixed(2)}`).join(", ");
    console.log(`[TASTE] computed for ${userId.slice(0, 8)} | n=${taste.sampleSize} | ageCenter=${taste.ageCenter?.toFixed(1) ?? "?"} | intents=[${topIntents}]`);
  }

  return taste;
}

/**
 * Personalisation bonus added on top of the base Discover score (0–15 pts).
 * Rewards candidates whose age, dating intent and connection style match what
 * this user has shown genuine interest in through their open history.
 */
function tasteAffinityScore(candidate: Profile, taste: TasteProfile): number {
  let score = 0;

  // Age affinity (0–5 pts): score decays as candidate's age drifts from learned centre.
  if (taste.ageCenter !== null && candidate.age !== null) {
    const diff = Math.abs(candidate.age - taste.ageCenter);
    score += Math.max(0, 5 * (1 - diff / 10)); // full decay at ±10 years
  } else {
    score += 2.5; // neutral when either side is unknown
  }

  // Dating intent affinity (0–5 pts)
  if (candidate.datingIntent) {
    score += (taste.intentWeights.get(candidate.datingIntent) ?? 0) * 5;
  }

  // Connection style affinity (0–5 pts)
  if (candidate.connectionStyle) {
    score += (taste.styleWeights.get(candidate.connectionStyle) ?? 0) * 5;
  }

  return Math.min(15, score);
}

/**
 * Personalised Discover ranking.
 *
 * Layers a learned taste-affinity bonus on top of the base quality+compatibility
 * score, then applies a 75/25 core/exploratory split to prevent filter bubbles.
 * The exploratory 25% are randomly sampled from lower-scoring candidates so the
 * user occasionally encounters profiles outside their established pattern.
 */
async function loadDnaProfiles(
  userIds: string[],
): Promise<Map<string, DnaDimensions>> {
  const map = new Map<string, DnaDimensions>();
  if (userIds.length === 0) return map;
  try {
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(", ");
    const r = await (localPool as any).query(
      `SELECT user_id, dimensions FROM connection_dna_profiles WHERE user_id IN (${placeholders}) AND completed_at IS NOT NULL`,
      userIds,
    );
    for (const row of r.rows) {
      const dna = deserializeDna(row.dimensions);
      if (dna) map.set(row.user_id, dna);
    }
  } catch {
    // Non-critical — fall back gracefully with no DNA data
  }
  return map;
}

async function rankWithPersonalization(
  pool: Profile[],
  userId: string,
  sb: SupabaseClient,
  userLat: number | null,
  userLng: number | null,
  locationRadius: number,
  userDatingIntent: string | null,
  userConnectionStyle: string | null,
  memberUserIds: Set<string>,
  now: Date,
  limit: number,
): Promise<Profile[]> {
  if (pool.length === 0) return [];

  // Attempt to get personalisation; null = cold start → zero affinity bonus.
  const taste = await computeTasteProfile(userId, sb, now);

  // Load Connection DNA profiles for scoring (user + all candidates).
  // Falls back gracefully — no DNA data → neutral bonus (10 pts each).
  const candidateIds = pool.map(p => p.userId);
  const dnaMap = await loadDnaProfiles([userId, ...candidateIds]);
  const userDna = dnaMap.get(userId) ?? null;

  // Score every candidate.
  const scored = pool.map(p => {
    const b          = scoreProfile(p, userLat, userLng, locationRadius, userDatingIntent, userConnectionStyle, memberUserIds, now);
    const affinity   = taste ? tasteAffinityScore(p, taste) : 0;
    const candidateDna = dnaMap.get(p.userId) ?? null;
    const dnaBonus   = dnaBonusScore(userDna, candidateDna); // 0–20, neutral=10
    const jitter     = Math.random() * 4 - 2;
    return { profile: p, base: b, affinity, dnaBonus, final: b.base * b.elevateMultiplier + affinity + dnaBonus + jitter };
  });

  scored.sort((a, b) => b.final - a.final);

  if (IS_DEV) {
    scored.slice(0, Math.min(8, scored.length)).forEach(({ profile: p, base: b, affinity: aff, dnaBonus: dna, final: f }) => {
      const name = (p as any).firstName ?? p.userId.slice(0, 8);
      const elev = b.elevateMultiplier > 1 ? ` ×${b.elevateMultiplier}` : "";
      console.log(
        `[SCORE] ${name} | final=${f.toFixed(1)}${elev} | base=${b.base} affinity=${aff.toFixed(1)} dna=${dna} ` +
        `[dist=${b.distance} rec=${b.recency} verified=${b.photoVerified} complete=${b.completeness} ` +
        `intent=${b.sharedIntent} style=${b.sharedStyle} member=${b.membership} newUser=${b.newUser}]`,
      );
    });
    if (taste) console.log(`[TASTE] personalisation active for ${userId.slice(0, 8)} (n=${taste.sampleSize})`);
    if (userDna) console.log(`[DNA] profile loaded for ${userId.slice(0, 8)}`);
  }

  // Anti-filter-bubble split: 75 % top-scored (core), 25 % exploratory.
  // Exploratory slots are randomly sampled from the lower half of the pool —
  // profiles that wouldn't appear in a pure top-N result.
  const coreCap    = Math.ceil(limit * 0.75);
  const exploreCap = limit - coreCap;
  const core       = scored.slice(0, coreCap).map(s => s.profile);

  let exploratory: Profile[] = [];
  if (exploreCap > 0 && scored.length > coreCap) {
    const remaining  = scored.slice(coreCap);
    const halfStart  = Math.floor(remaining.length / 2);
    const candidates = remaining.slice(halfStart);
    // Fisher-Yates shuffle for uniform random sampling
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    exploratory = candidates.slice(0, exploreCap).map(s => s.profile);
  }

  return diversifyProfiles([...core, ...exploratory]);
}

// ─── Intent Wheel — Standout scoring ─────────────────────────────────────────
//
// The wheel uses a separate algorithm from Discover.  Its goal: surface the
// strongest, most exciting profiles on Lulou — not just the most popular or
// most boosted ones.
//
// Standout Score = Quality (50 %) + Compatibility (30 %) + Elevate boost
// Diversity is enforced by selectWheelStandouts (not a score component).

/**
 * Compute a Standout Score for the Intent Wheel.
 * Quality (max 50) + Compatibility (max 30) + Elevate boost (0/20/40)
 * Scores are internal — never sent to clients.
 */
function scoreForWheel(
  candidate: Profile,
  userDatingIntent: string | null,
  userConnectionStyle: string | null,
  userSignals: string[],
  memberUserIds: Set<string>,
  now: Date,
): number {
  // ── Quality 50 pts ────────────────────────────────────────────────────────
  const qualVerified = candidate.photoVerified ? 15 : 0;

  // Profile completeness (0–15, 2.5 pts each for 6 sections)
  let qualComplete = 0;
  if ((candidate.signals?.length ?? 0) > 0)                 qualComplete += 2.5;
  if ((candidate.greenFlags?.length ?? 0) > 0)              qualComplete += 2.5;
  if (candidate.datingIntent)                                qualComplete += 2.5;
  if (candidate.connectionStyle)                             qualComplete += 2.5;
  if ((candidate.conversationStarters?.length ?? 0) > 0)    qualComplete += 2.5;
  if (((candidate as any).customStarters?.length ?? 0) > 0) qualComplete += 2.5;

  // Recent activity (0–15)
  let qualRecency = 0;
  if ((candidate as any).lastActive) {
    const ageHours = (now.getTime() - (candidate as any).lastActive.getTime()) / 3_600_000;
    if (ageHours < 24)       qualRecency = 15;
    else if (ageHours < 168) qualRecency = 10;
    else if (ageHours < 720) qualRecency = 5;
  }

  // Content depth (0–5): extra credit for richer prompts
  const qualDepth =
    ((candidate.conversationStarters?.length ?? 0) > 2 ? 2.5 : 0) +
    (((candidate as any).customStarters?.length ?? 0) > 0 ? 2.5 : 0);

  const quality = qualVerified + qualComplete + qualRecency + qualDepth;

  // ── Compatibility 30 pts ──────────────────────────────────────────────────
  const compatIntent =
    userDatingIntent && candidate.datingIntent &&
    userDatingIntent.trim().toLowerCase() === candidate.datingIntent.trim().toLowerCase()
      ? 12 : 0;

  const compatStyle =
    userConnectionStyle && candidate.connectionStyle &&
    userConnectionStyle.trim().toLowerCase() === candidate.connectionStyle.trim().toLowerCase()
      ? 10 : 0;

  // Shared personality signals (0–8 pts, 2 pts each, capped at 4 overlapping signals)
  let compatSignals = 0;
  if (userSignals.length > 0 && (candidate.signals?.length ?? 0) > 0) {
    const userSigSet = new Set(userSignals.map(s => s.toLowerCase()));
    const overlap = (candidate.signals as string[])
      .filter(s => userSigSet.has(s.toLowerCase())).length;
    compatSignals = Math.min(8, overlap * 2);
  }

  const compatibility = compatIntent + compatStyle + compatSignals;

  // ── Boosts ────────────────────────────────────────────────────────────────
  // Elevate is meaningful on the wheel but cannot override a well-matched profile.
  let elevateBoost = 0;
  if (candidate.elevateType && candidate.elevateExpiresAt && candidate.elevateExpiresAt > now) {
    elevateBoost = candidate.elevateType === "super_elevate" ? 40 : 20;
  }

  // Membership: modest wheel visibility boost.
  const memberBoost = memberUserIds.has(candidate.userId) ? 5 : 0;

  return quality + compatibility + elevateBoost + memberBoost;
}

/**
 * Select `limit` diverse standout profiles from a scored pool.
 *
 * Applies a quality floor (≥ 2 completed content sections) then greedily
 * picks for variety: max 2 per (datingIntent × connectionStyle) pair,
 * max 3 per single datingIntent.  Backfills from remaining qualified profiles
 * when diversity constraints leave gaps.
 *
 * Anti-abuse: the quality floor silently excludes bot/spam profiles that have
 * minimal content, regardless of how many opens they farmed.
 */
function selectWheelStandouts(
  candidates: Array<{ profile: Profile; score: number }>,
  limit: number,
): Profile[] {
  // Quality floor: at least 2 completed content sections
  const qualified = candidates.filter(c => {
    const p = c.profile;
    let n = 0;
    if ((p.signals?.length ?? 0) > 0)             n++;
    if ((p.greenFlags?.length ?? 0) > 0)           n++;
    if (p.datingIntent)                             n++;
    if (p.connectionStyle)                          n++;
    if ((p.conversationStarters?.length ?? 0) > 0) n++;
    return n >= 2;
  });

  qualified.sort((a, b) => b.score - a.score);

  const result: Profile[] = [];
  const pairCounts   = new Map<string, number>(); // intent|style → count
  const intentCounts = new Map<string, number>(); // intent       → count

  for (const { profile: p } of qualified) {
    if (result.length >= limit) break;
    const intent = p.datingIntent      ?? "__none__";
    const style  = p.connectionStyle   ?? "__none__";
    const pair   = `${intent}|${style}`;
    if ((pairCounts.get(pair)   ?? 0) >= 2) continue; // max 2 per pair
    if ((intentCounts.get(intent) ?? 0) >= 3) continue; // max 3 per intent
    result.push(p);
    pairCounts.set(pair,   (pairCounts.get(pair)     ?? 0) + 1);
    intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + 1);
  }

  // Backfill from remaining qualified profiles when diversity rules leave gaps
  if (result.length < limit) {
    const seen = new Set(result.map(p => p.userId));
    for (const { profile: p } of qualified) {
      if (result.length >= limit) break;
      if (!seen.has(p.userId)) { result.push(p); seen.add(p.userId); }
    }
  }

  return result;
}

// ── Gender / preference normalisation ────────────────────────────────────────
// Converts free-text variants (male/man/men, female/woman/women) to the
// canonical Zod-enum values used in the `profiles` table so filter lookups
// always hit the right rows even when data comes from seed scripts or
// older clients that used different capitalisations or synonyms.

function normalizeGender(value: string | null | undefined): string {
  if (!value) return "";
  const v = value.toLowerCase().trim();
  if (["male", "man"].includes(v)) return "man";
  if (["female", "woman"].includes(v)) return "woman";
  if (["trans female", "trans woman"].includes(v)) return "trans woman";
  if (["trans male", "trans man"].includes(v)) return "trans man";
  return v;
}

function normalizeDatingPreference(value: string | null | undefined): string {
  if (!value) return "";
  const v = value.toLowerCase().trim();
  if (["men", "man", "male"].includes(v)) return "men";
  if (["women", "woman", "female"].includes(v)) return "women";
  if (["trans women", "trans woman", "trans female"].includes(v)) return "trans women";
  if (["trans men", "trans man", "trans male"].includes(v)) return "trans men";
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────

function getGendersForPreference(preference: string): string[] | null {
  switch (normalizeDatingPreference(preference)) {
    case "women": return ["woman", "trans woman"];
    case "men": return ["man", "trans man"];
    case "non-binary people": return ["non-binary", "genderqueer", "genderfluid", "agender", "two-spirit", "other"];
    case "trans women": return ["trans woman"];
    case "trans men": return ["trans man"];
    case "everyone": return null;
    default: return null;
  }
}

function getPreferencesThatIncludeGender(gender: string): string[] {
  const prefs = ["everyone"];
  switch (normalizeGender(gender)) {
    case "woman": prefs.push("women"); break;
    case "man": prefs.push("men"); break;
    case "trans woman": prefs.push("women", "trans women"); break;
    case "trans man": prefs.push("men", "trans men"); break;
    case "non-binary":
    case "genderqueer":
    case "genderfluid":
    case "agender":
    case "two-spirit":
    case "other":
      prefs.push("non-binary people"); break;
  }
  return prefs;
}

// Minimum WebRTC-connected duration (ms) for a call to consume a slot.
// Calls shorter than this are refunded — the stage is NOT advanced.
const MIN_VALID_CALL_MS = 20_000;

export interface CompleteCallOptions {
  /** Whether WebRTC audio/video actually connected (ICE state reached "connected"). */
  connected?: boolean;
  /** How many milliseconds the WebRTC connection was live. 0 if it never connected. */
  connectedDurationMs?: number;
  /** Diagnostic state name at the time the call ended (e.g. "failed", "ended", "connection_failed"). */
  callState?: string;
}

export interface CompleteCallResult {
  match: Match;
  /** True if the call was long enough to count — stage was advanced. False = slot refunded. */
  counted: boolean;
}

export interface IStorage {
  getProfile(userId: string): Promise<Profile | undefined>;
  getProfileMeta(userId: string): Promise<Profile | undefined>;
  createProfile(data: InsertProfile): Promise<Profile>;
  updateProfile(userId: string, data: Partial<InsertProfile>): Promise<Profile | undefined>;
  getDiscoverProfiles(userId: string, gender: string, preference: string, ageMin?: number, ageMax?: number, locationRadius?: number, userLat?: number | null, userLng?: number | null, userDatingIntent?: string | null, userConnectionStyle?: string | null): Promise<Profile[]>;
  createInteraction(data: InsertInteraction): Promise<Interaction>;
  updateInteractionType(interactionId: string, newType: string): Promise<void>;
  getInteraction(fromUserId: string, toUserId: string): Promise<Interaction | undefined>;
  getMutualOpen(user1Id: string, user2Id: string): Promise<boolean>;
  createMatch(user1Id: string, user2Id: string): Promise<Match>;
  getMatchesForUser(userId: string): Promise<(Match & { profile: Profile; lastMessage: { content: string; senderId: string; createdAt: Date | null } | null })[]>;
  getMatch(matchId: string, userId: string): Promise<(Match & { profile: Profile; messages: Message[] }) | undefined>;
  getMessagesPage(matchId: string, limit: number, before?: string): Promise<{ messages: Message[]; hasMore: boolean }>;
  createMessage(data: InsertMessage): Promise<Message>;
  getUserMessageCount(matchId: string, userId: string): Promise<number>;
  incrementMessageCount(matchId: string, userId: string): Promise<void>;
  startCall(matchId: string, userId: string, isPaidCredit?: boolean): Promise<{ match: Match; status: "created" | "reused" | "blocked" | "self_call" } | undefined>;
  answerCall(matchId: string, userId: string): Promise<Match | undefined>;
  cancelCall(matchId: string, userId: string): Promise<Match | undefined>;
  completeCall(matchId: string, userId: string, options?: CompleteCallOptions): Promise<CompleteCallResult | undefined>;
  setDateChoice(matchId: string, userId: string, choice: 'plan' | 'keep' | null): Promise<Match | undefined>;
  acceptFaceCall(matchId: string, userId: string): Promise<Match | undefined>;
  declineFaceCall(matchId: string, userId: string): Promise<Match | undefined>;
  getProfilePhotos(userId: string): Promise<string[]>;
  getPopularProfiles(limit?: number, preference?: string, gender?: string, userId?: string, locationRadius?: number, userLat?: number | null, userLng?: number | null, ageMin?: number, ageMax?: number, userDatingIntent?: string | null, userConnectionStyle?: string | null, userSignals?: string[]): Promise<Profile[]>;
  getSpinStandouts(userId: string): Promise<string[]>;
  addSpinStandout(userId: string, standoutUserId: string): Promise<void>;
  getSpinsToday(userId: string): Promise<number>;
  getSpinsThisWeek(userId: string): Promise<number>;
  recordSpin(userId: string): Promise<void>;
  getDailyLikeCount(userId: string): Promise<number>;
  getConsecutiveLikeDays(userId: string, goal: number): Promise<number>;
  hasUnusedStreakSpin(userId: string): Promise<boolean>;
  getSpinCredits(userId: string): Promise<number>;
  consumeSpinCredit(userId: string): Promise<boolean>;
  grantSpinCredits(userId: string, qty: number, packType: string, stripeSessionId: string): Promise<void>;
  createSpinRequest(fromUserId: string, toUserId: string, message: string): Promise<SpinRequest>;
  getIncomingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]>;
  getOutgoingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]>;
  respondToSpinRequest(requestId: string, userId: string, accept: boolean): Promise<SpinRequest | undefined>;
  getSpinRequest(id: string): Promise<SpinRequest | undefined>;
  setMeetAvailability(matchId: string, userId: string, availability: string): Promise<Match | undefined>;
  setCallAvailability(matchId: string, userId: string, availableAt: string | null): Promise<Match | undefined>;
  clearAgreedCallAt(matchId: string): Promise<void>;
  exchangeNumber(matchId: string, userId: string): Promise<Match | undefined>;
  removeMatch(matchId: string, userId: string): Promise<boolean>;
  getMatchCount(userId: string): Promise<number>;
  findMatchBetweenUsers(userId1: string, userId2: string): Promise<Match | undefined>;
  getIncomingOpens(userId: string): Promise<(Interaction & { profile: Profile })[]>;
  resetUserTestData(userId: string): Promise<void>;
  activateElevate(userId: string, type: "elevate" | "super_elevate"): Promise<{ success: boolean; error?: string }>;
  addElevateCredits(userId: string, type: "elevate" | "super_elevate", quantity: number): Promise<void>;
  getElevateStatus(userId: string): Promise<{ type: string | null; expiresAt: Date | null; active: boolean; elevateCredits: number; superElevateCredits: number }>;
  getElevateSessionStats(userId: string): Promise<{ views: number; matches: number; startedAt: Date | null; active: boolean; expiresAt: Date | null }>;
  getCallCredits(userId: string): Promise<{ phoneCredits: number; videoCredits: number }>;
  grantCallCredits(userId: string, phone: number, video: number): Promise<void>;
  consumeCallCredit(userId: string, type: "phone" | "video"): Promise<boolean>;
  getSavedWheelProfile(userId: string): Promise<SavedWheelProfile | null>;
  saveWheelProfile(userId: string, savedProfileId: string): Promise<SavedWheelProfile>;
  deleteSavedWheelProfile(userId: string): Promise<void>;
  getLastClose(userId: string): Promise<{ interactionId: string; toUserId: string } | null>;
  deleteLastClose(userId: string, interactionId: string): Promise<boolean>;
  getLastInteraction(userId: string): Promise<{ interactionId: string; toUserId: string; type: string } | null>;
  getMatchBetweenUsers(userId: string, otherUserId: string): Promise<boolean>;
  createWheelSpark(fromUserId: string, toUserId: string): Promise<void>;
  hasWheelSpark(fromUserId: string, toUserId: string): Promise<boolean>;
  getIncomingWheelSparks(userId: string): Promise<(Interaction & { profile: Profile })[]>;
  acceptWheelSpark(fromUserId: string, toUserId: string): Promise<{ matchId: string }>;
  declineWheelSpark(fromUserId: string, toUserId: string): Promise<void>;
  getDatePlanMessages(matchId: string): Promise<Message[]>;
}

/**
 * Haversine great-circle distance between two lat/lng points in miles.
 * Used for in-memory distance filtering after the DB pool is fetched.
 */
function haversineDistanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compute a lat/lng bounding box for a given centre point and radius in miles.
 * Used to pre-filter profiles at DB level BEFORE the exact Haversine check so that
 * the LIMIT clause only ever sees geographically relevant rows.
 *
 * The box is a square approximation — its corners slightly exceed the true radius
 * circle, so the in-memory Haversine pass trims those edges precisely.
 *
 * Performance: with a (latitude, longitude) compound index this becomes a fast
 * range scan even at 100 k+ rows, comparable to a PostGIS ST_DWithin query.
 */
function computeBoundingBox(lat: number, lng: number, radiusMiles: number): {
  minLat: number; maxLat: number; minLng: number; maxLng: number;
} {
  const deltaLat = radiusMiles / 69.0;
  // Longitude degrees per mile shrink near the poles — cos correction.
  const deltaLng = radiusMiles / (69.0 * Math.cos(lat * Math.PI / 180));
  return {
    minLat: lat - deltaLat,
    maxLat: lat + deltaLat,
    minLng: lng - deltaLng,
    maxLng: lng + deltaLng,
  };
}

/**
 * Geocode a free-form location string to lat/lng using OpenStreetMap Nominatim.
 * Called when a user saves a new location — result is stored in profiles.latitude/longitude.
 * Degrades gracefully: returns null on any failure so the profile save is never blocked.
 */
export async function geocodeLocation(locationText: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locationText)}&limit=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "LulouDating/1.0 (app@lulou.dating)" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[GEOCODE] Nominatim returned ${res.status} for "${locationText}"`);
      return null;
    }
    const data: any[] = await res.json();
    if (!data || data.length === 0) {
      console.warn(`[GEOCODE] No results for location: "${locationText}"`);
      return null;
    }
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat, lng };
  } catch (err: any) {
    console.warn(`[GEOCODE] Failed for "${locationText}":`, err?.message ?? err);
    return null;
  }
}

/** Remove HEIC/HEIF data-URLs — most browsers cannot decode them. */
function filterPhotos(raw: string[]): string[] {
  return (raw || []).filter(url => {
    const prefix = url.substring(0, 30).toLowerCase();
    return !prefix.startsWith("data:image/heic") && !prefix.startsWith("data:image/heif");
  });
}

// Profile columns for list views — excludes `photos` (base64, ~900 KB per profile) and
// `elevate_type`/`elevate_expires_at` (handled by user_elevates drizzle table for discover).
// mapProfile handles missing columns gracefully (falls back to null / empty array).
// lat/lng columns are optional — only present after the DB migration is run.
// Set to true by setHasLatLngColumns() called from server startup.
let _hasLatLngColumns = false;
export function setHasLatLngColumns(val: boolean) {
  _hasLatLngColumns = val;
  console.log(`[STORAGE] lat/lng columns ${val ? "AVAILABLE" : "NOT YET MIGRATED"}`);
}
export function getHasLatLngColumns(): boolean { return _hasLatLngColumns; }

// Set to true by setHasCustomQColumn() called from server startup.
// When false, custom_questions is omitted from SELECT lists so existing
// deployments where the column hasn't been added yet don't break.
let _hasCustomQColumn = false;
export function setHasCustomQColumn(val: boolean) {
  _hasCustomQColumn = val;
  if (val) console.log("[STORAGE] custom_questions column AVAILABLE");
}

let _hasViewerQColumn = false;
export function setHasViewerQColumn(val: boolean) {
  _hasViewerQColumn = val;
  if (val) console.log("[STORAGE] viewer_questions column AVAILABLE");
}

let _hasCustomStartersColumn = false;
export function setHasCustomStartersColumn(val: boolean) {
  _hasCustomStartersColumn = val;
  if (val) console.log("[STORAGE] custom_starters column AVAILABLE");
}

let _hasDateOfBirthColumn = false;
export function setHasDateOfBirthColumn(val: boolean) {
  _hasDateOfBirthColumn = val;
  if (val) console.log("[STORAGE] date_of_birth column AVAILABLE");
}

let _hasPronounsColumn = false;
export function setHasPronounsColumn(val: boolean) {
  _hasPronounsColumn = val;
  if (val) console.log("[STORAGE] pronouns column AVAILABLE");
}

let _hasCustomGreenFlagsColumn = false;
export function setHasCustomGreenFlagsColumn(val: boolean) {
  _hasCustomGreenFlagsColumn = val;
  if (val) console.log("[STORAGE] custom_green_flags column AVAILABLE");
}

let _hasCustomSignalsColumn = false;
export function setHasCustomSignalsColumn(val: boolean) {
  _hasCustomSignalsColumn = val;
  if (val) console.log("[STORAGE] custom_signals column AVAILABLE");
}

let _hasLastActiveColumn = false;
export function setHasLastActiveColumn(val: boolean) {
  _hasLastActiveColumn = val;
  if (val) console.log("[STORAGE] last_active column AVAILABLE");
}

let _hasShowLastActiveColumn = false;
export function setHasShowLastActiveColumn(val: boolean) {
  _hasShowLastActiveColumn = val;
  if (val) console.log("[STORAGE] show_last_active column AVAILABLE");
}

let _hasCommentFilterColumn = false;
export function setHasCommentFilterColumn(val: boolean) {
  _hasCommentFilterColumn = val;
  if (val) console.log("[STORAGE] comment_filter column AVAILABLE");
}

let _hasConversationStarterAiColumn = false;
export function setHasConversationStarterAiColumn(val: boolean) {
  _hasConversationStarterAiColumn = val;
  if (val) console.log("[STORAGE] conversation_starter_ai column AVAILABLE");
}

let _hasVoiceTranscriptColumn = false;
export function setHasVoiceTranscriptColumn(val: boolean) {
  _hasVoiceTranscriptColumn = val;
  if (val) console.log("[STORAGE] voice_transcript column AVAILABLE");
}

let _hasIsPausedColumn = false;
export function setHasIsPausedColumn(val: boolean) {
  _hasIsPausedColumn = val;
  console.log(`[STORAGE] is_paused column ${val ? "AVAILABLE" : "NOT YET MIGRATED"}`);
}

// email_verified — true once the user has confirmed their email address.
// Set lazily (fire-and-forget) in the isAuthenticated middleware the first time
// a verified user makes an API call.  Discovery and the Wheel filter this column
// so unverified profiles are never shown to other users.
let _hasEmailVerifiedColumn = false;
export function setHasEmailVerifiedColumn(val: boolean) {
  _hasEmailVerifiedColumn = val;
  if (val) console.log("[STORAGE] email_verified column AVAILABLE");
}
export function getHasEmailVerifiedColumn(): boolean { return _hasEmailVerifiedColumn; }

// Matches & Likes pages don't need coordinates (no distance filter applies there).
// Function (not const) so guard flags are evaluated at call-time, not module-init.
function getMatchProfileCols(): string {
  return [
    "id", "user_id", "first_name", "age", "gender", "dating_preference",
    "location", "height", "signals", "dating_intent", "green_flags",
    "connection_style", "conversation_starters", "questions",
    ...(_hasCustomQColumn ? ["custom_questions"] : []),
    ...(_hasViewerQColumn ? ["viewer_questions"] : []),
    ...(_hasCustomStartersColumn ? ["custom_starters"] : []),
    ...(_hasDateOfBirthColumn ? ["date_of_birth"] : []),
    ...(_hasPronounsColumn ? ["pronouns"] : []),
    ...(_hasCustomGreenFlagsColumn ? ["custom_green_flags"] : []),
    ...(_hasCustomSignalsColumn ? ["custom_signals"] : []),
    "location_radius", "preferred_age_min", "preferred_age_max",
    "email", "phone_number", "photo_verified", "onboarding_complete", "created_at",
    ...(_hasLastActiveColumn ? ["last_active"] : []),
    ...(_hasShowLastActiveColumn ? ["show_last_active"] : []),
  ].join(", ");
}

// Profile columns for Likes page — includes `photos` for LikeCard and ProfileModal.
function getLikesProfileCols(): string {
  return [
    "id", "user_id", "first_name", "age", "gender", "dating_preference",
    "location", "height", "photos", "signals", "dating_intent", "green_flags",
    "connection_style", "conversation_starters", "questions",
    ...(_hasCustomQColumn ? ["custom_questions"] : []),
    ...(_hasViewerQColumn ? ["viewer_questions"] : []),
    ...(_hasCustomStartersColumn ? ["custom_starters"] : []),
    ...(_hasDateOfBirthColumn ? ["date_of_birth"] : []),
    ...(_hasPronounsColumn ? ["pronouns"] : []),
    ...(_hasCustomGreenFlagsColumn ? ["custom_green_flags"] : []),
    ...(_hasCustomSignalsColumn ? ["custom_signals"] : []),
    "location_radius", "preferred_age_min", "preferred_age_max",
    "email", "phone_number", "photo_verified", "onboarding_complete", "created_at",
    ...(_hasLastActiveColumn ? ["last_active"] : []),
    ...(_hasShowLastActiveColumn ? ["show_last_active"] : []),
  ].join(", ");
}

function mapProfile(row: any): Profile {
  return {
    id: row.id,
    userId: row.user_id,
    firstName: row.first_name,
    age: row.age,
    gender: row.gender,
    datingPreference: row.dating_preference,
    location: row.location,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    height: row.height,
    photos: filterPhotos(row.photos),
    signals: row.signals,
    datingIntent: row.dating_intent,
    greenFlags: row.green_flags,
    connectionStyle: row.connection_style,
    conversationStarters: row.conversation_starters,
    questions: row.questions,
    customQuestions: row.custom_questions ?? [],
    viewerQuestions: row.viewer_questions ?? [],
    customStarters: row.custom_starters ?? [],
    dateOfBirth: row.date_of_birth ?? null,
    pronouns: row.pronouns ?? null,
    customGreenFlags: row.custom_green_flags ?? [],
    customSignals: row.custom_signals ?? [],
    locationRadius: row.location_radius,
    preferredAgeMin: row.preferred_age_min,
    preferredAgeMax: row.preferred_age_max,
    email: row.email,
    phoneNumber: row.phone_number,
    photoVerified: row.photo_verified,
    onboardingComplete: row.onboarding_complete,
    isPaused: row.is_paused ?? false,
    elevateType: row.elevate_type ?? null,
    elevateExpiresAt: row.elevate_expires_at ? new Date(row.elevate_expires_at) : null,
    lastActive: _hasLastActiveColumn && row.last_active ? new Date(row.last_active) : null,
    showLastActive: _hasShowLastActiveColumn ? (row.show_last_active ?? true) : true,
    commentFilter: _hasCommentFilterColumn ? (row.comment_filter ?? true) : true,
    conversationStarterAi: _hasConversationStarterAiColumn ? (row.conversation_starter_ai ?? true) : true,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

function mapInteraction(row: any): Interaction {
  return {
    id: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    type: row.type,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

export function mapMatch(row: any): Match {
  return {
    id: row.id,
    user1Id: row.user1_id,
    user2Id: row.user2_id,
    messageCount1: row.message_count_1,
    messageCount2: row.message_count_2,
    callCompleted: row.call_completed,
    callStartedAt: row.call_started_at ? new Date(row.call_started_at) : null,
    callAnswered: row.call_answered,
    callInitiatorId: row.call_initiator_id,
    callStage: row.call_stage,
    callSessionId: row.call_started_at && row.call_initiator_id
      ? `call-${row.id}-${new Date(row.call_started_at).getTime()}`
      : null,
    faceCallUser1Accepted: row.face_call_user1_accepted,
    faceCallUser2Accepted: row.face_call_user2_accepted,
    meetAvailability1: row.meet_availability_1,
    meetAvailability2: row.meet_availability_2,
    callAvail1: row.call_avail_1 ?? null,
    callAvail2: row.call_avail_2 ?? null,
    callAvail1At: row.call_avail_1_at ? new Date(row.call_avail_1_at) : null,
    callAvail2At: row.call_avail_2_at ? new Date(row.call_avail_2_at) : null,
    agreedCallAt: row.agreed_call_at ? new Date(row.agreed_call_at) : null,
    numberExchanged1: row.number_exchanged_1,
    numberExchanged2: row.number_exchanged_2,
    dateChoiceUser1: row.date_choice_user1 ?? null,
    dateChoiceUser2: row.date_choice_user2 ?? null,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

function mapMessage(row: any): Message {
  const rawReaction = row.reaction;
  const reaction = (typeof rawReaction === 'string' && rawReaction.length > 0) ? rawReaction : null;
  return {
    id: row.id,
    matchId: row.match_id,
    senderId: row.sender_id,
    content: row.content,
    reaction,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    voiceTranscript: row.voice_transcript ?? null,
  };
}

function mapSpinRequest(row: any): SpinRequest {
  return {
    id: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    message: row.message,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

function profileToDbRow(data: Partial<InsertProfile> & { latitude?: number | null; longitude?: number | null }): Record<string, any> {
  const row: Record<string, any> = {};
  if (data.userId !== undefined) row.user_id = data.userId;
  if (data.firstName !== undefined) row.first_name = data.firstName;
  if (data.age !== undefined) row.age = data.age;
  if (data.gender !== undefined) row.gender = data.gender;
  if (data.datingPreference !== undefined) row.dating_preference = data.datingPreference;
  if (data.location !== undefined) row.location = data.location;
  if (_hasLatLngColumns && data.latitude !== undefined) row.latitude = data.latitude;
  if (_hasLatLngColumns && data.longitude !== undefined) row.longitude = data.longitude;
  if (data.height !== undefined) row.height = data.height;
  if (data.photos !== undefined) row.photos = data.photos;
  if (data.signals !== undefined) row.signals = data.signals;
  if (data.datingIntent !== undefined) row.dating_intent = data.datingIntent;
  if (data.greenFlags !== undefined) row.green_flags = data.greenFlags;
  if (data.connectionStyle !== undefined) row.connection_style = data.connectionStyle;
  if (data.conversationStarters !== undefined) row.conversation_starters = data.conversationStarters;
  if (data.questions !== undefined) row.questions = data.questions;
  if (_hasCustomQColumn && (data as any).customQuestions !== undefined) row.custom_questions = (data as any).customQuestions;
  if (_hasViewerQColumn && (data as any).viewerQuestions !== undefined) row.viewer_questions = (data as any).viewerQuestions;
  if (_hasCustomStartersColumn && (data as any).customStarters !== undefined) row.custom_starters = (data as any).customStarters;
  if (_hasDateOfBirthColumn && (data as any).dateOfBirth !== undefined) row.date_of_birth = (data as any).dateOfBirth || null;
  if (_hasPronounsColumn && (data as any).pronouns !== undefined) row.pronouns = (data as any).pronouns || null;
  if (_hasCustomGreenFlagsColumn && (data as any).customGreenFlags !== undefined) row.custom_green_flags = (data as any).customGreenFlags;
  if (_hasCustomSignalsColumn && (data as any).customSignals !== undefined) row.custom_signals = (data as any).customSignals;
  if (data.locationRadius !== undefined) row.location_radius = data.locationRadius;
  if (data.preferredAgeMin !== undefined) row.preferred_age_min = data.preferredAgeMin;
  if (data.preferredAgeMax !== undefined) row.preferred_age_max = data.preferredAgeMax;
  if (data.email !== undefined) row.email = data.email;
  if (data.phoneNumber !== undefined) row.phone_number = data.phoneNumber;
  if (data.photoVerified !== undefined) row.photo_verified = data.photoVerified;
  if (data.onboardingComplete !== undefined) row.onboarding_complete = data.onboardingComplete;
  if ((data as any).isPaused !== undefined) row.is_paused = (data as any).isPaused;
  if (_hasShowLastActiveColumn && (data as any).showLastActive !== undefined) row.show_last_active = (data as any).showLastActive;
  if (_hasCommentFilterColumn && (data as any).commentFilter !== undefined) row.comment_filter = (data as any).commentFilter;
  if (_hasConversationStarterAiColumn && (data as any).conversationStarterAi !== undefined) row.conversation_starter_ai = (data as any).conversationStarterAi;
  return row;
}

export class SupabaseStorage implements IStorage {
  private sb: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.sb = client || defaultSupabase;
  }

  async getProfile(userId: string): Promise<Profile | undefined> {
    const { data, error } = await this.sb
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return undefined;
    return mapProfile(data);
  }

  // Lightweight profile fetch — excludes the `photos` column (base64, up to 900 KB).
  // Use this in server-side routes that only need profile metadata (gender, preference, name, etc.).
  // Never return this to the frontend when the profile page needs to show/edit photos.
  async getProfileMeta(userId: string): Promise<Profile | undefined> {
    const { data, error } = await this.sb
      .from("profiles")
      .select(getMatchProfileCols())
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return undefined;
    return mapProfile(data); // photos will be [] since the column wasn't selected
  }

  async createProfile(data: InsertProfile): Promise<Profile> {
    const row = profileToDbRow(data);
    row.user_id = data.userId;
    const { data: result, error } = await this.sb
      .from("profiles")
      .upsert(row, { onConflict: "user_id" })
      .select()
      .single();
    if (error) throw new Error(`Failed to create profile: ${error.message}`);
    return mapProfile(result);
  }

  async updateProfile(userId: string, data: Partial<InsertProfile>): Promise<Profile | undefined> {
    const row = profileToDbRow(data);
    // Always include user_id so PostgREST can detect the ON CONFLICT target.
    row.user_id = userId;

    // When the location text is provided, geocode it and persist coordinates so
    // the distance filter in getDiscoverProfiles / getPopularProfiles can work.
    //
    // IMPORTANT: always null out the existing coordinates FIRST, before geocoding.
    // If geocoding succeeds the new values overwrite them.
    // If geocoding fails the nulls are written, which is correct: stale coordinates
    // from a previous city must NEVER persist after the location text has changed.
    // (The inline geocoder in /api/discover will retry on the next discover call.)
    if (data.location && _hasLatLngColumns) {
      row.latitude  = null;
      row.longitude = null;
      const coords = await geocodeLocation(data.location);
      if (coords) {
        row.latitude  = coords.lat;
        row.longitude = coords.lng;
        console.log(`[GEOCODE] "${data.location}" → lat=${coords.lat.toFixed(4)}, lng=${coords.lng.toFixed(4)}`);
      } else {
        console.warn(`[GEOCODE] geocoding failed for "${data.location}" — coordinates reset to null, inline retry will run on next discover`);
      }
    }
    // Use upsert instead of plain UPDATE so the first-ever save (no existing row)
    // performs an INSERT rather than a no-op UPDATE that returns 0 rows.
    // ON CONFLICT (user_id) DO UPDATE only touches the columns present in `row`,
    // leaving all other columns unchanged for existing rows.
    // All NOT NULL columns in public.profiles have DEFAULT values so a partial
    // INSERT (first save with only some fields) never violates NOT NULL.
    const { data: result, error } = await this.sb
      .from("profiles")
      .upsert(row, { onConflict: "user_id" })
      .select()
      .single();
    if (error) {
      console.error("UPDATE_PROFILE_ERROR", { userId, msg: error.message, code: error.code, details: error.details, hint: error.hint });
      throw new Error(error.message);
    }
    if (!result) return undefined;
    return mapProfile(result);
  }

  // Fetches ONLY the photos column for a single profile. Fast — avoids fetching all other fields.
  // Used by the per-card photo endpoint to prevent statement timeouts from large base64 images.
  // Filters out HEIC data-URLs which most browsers cannot decode.
  // Uses a 6-second abort signal so oversized legacy photos fail fast instead of hanging 17+ seconds.
  async getProfilePhotos(userId: string): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      console.warn("[PHOTOS] Aborting slow photo query for userId:", userId, "(>6s — photos may be oversized, user should re-upload)");
    }, 6000);

    let data: any = null;
    let error: any = null;
    try {
      const result = await (this.sb
        .from("profiles")
        .select("photos")
        .eq("user_id", userId)
        .abortSignal(controller.signal) as any)
        .maybeSingle();
      data  = result.data;
      error = result.error;
    } catch (e: any) {
      error = e;
    } finally {
      clearTimeout(timer);
    }

    if (error) {
      const isAbort = error?.name === "AbortError" || String(error?.message).includes("abort") || error?.code === "57014";
      if (isAbort) {
        console.error("[PHOTOS] Query timed out for userId:", userId, "— photos are too large in DB. User should re-upload via profile editor.");
      } else {
        console.error("[PHOTOS] Query error for userId:", userId, "—", error.message, "(code:", error.code, ")");
      }
      return [];
    }
    if (!data) {
      console.warn("[PHOTOS] No profile row found for userId:", userId);
      return [];
    }
    const raw: string[] = data.photos || [];
    // Filter out HEIC/HEIF data-URLs — most browsers (Chrome, Firefox) cannot decode them.
    // These are leftover from iPhone uploads before the JPEG conversion fix.
    const photos = raw.filter((url) => {
      const lower = url.substring(0, 30).toLowerCase();
      const isHeic = lower.startsWith("data:image/heic") || lower.startsWith("data:image/heif");
      if (isHeic) console.warn("[PHOTOS] Filtered HEIC photo for userId:", userId, "url prefix:", url.substring(0, 35));
      return !isHeic;
    });
    if (raw.length > 0 && photos.length === 0) {
      console.warn("[PHOTOS] All photos for userId:", userId, "were HEIC format — returning empty. User should re-upload photos.");
    } else if (photos.length === 0) {
      console.warn("[PHOTOS] Profile exists but photos array is empty for userId:", userId);
    } else {
      if (IS_DEV) console.log(`[PHOTOS] userId=${userId} returning ${photos.length}/${raw.length} photo(s) (first url length: ${photos[0].length})`);
    }
    return photos;
  }

  /**
   * Builds the unified set of user IDs that the current user must NOT see in
   * Discovery or the Intention Wheel.  Covers every exclusion category:
   *
   *   • profiles already interacted with (opened / closed from any surface)
   *   • active match partners — regardless of how the match was created
   *     (Discovery mutual-open, Intention Wheel direct-match, accepted spin request)
   *   • inbound openers — users who have already liked (opened) the current user
   *     These users are surfaced on the Likes page; showing them again in Discovery
   *     or the Wheel causes the same profile to appear in two places at once and
   *     removes the signal value of the Likes page.
   *
   * Only ACTIVE matches are excluded.  Removed matches (status = "removed")
   * intentionally allow the other user to reappear in both surfaces.
   *
   * All three lookups run in parallel so this method adds ≈0 extra latency.
   */
  /**
   * @param interactionTypesToExclude  When provided, only outbound interactions of these
   *   types count as "already acted on".  Omit (or pass undefined) to exclude ALL
   *   interaction types (Discover behaviour).  Pass ["wheel_connection"] for the
   *   Intention Wheel so that Discover open/close rows never block Wheel candidates.
   */
  private async buildExcludedUserIds(userId: string, interactionTypesToExclude?: string[]): Promise<{
    excludedIds: Set<string>;
    interactedIds: Set<string>;
    activeMatchUserIds: Set<string>;
    inboundOpenerIds: Set<string>;
    blockedUserIds: Set<string>;
  }> {
    // Base outbound-interaction query.  When a type filter is supplied (Wheel path) we
    // only fetch rows of that specific type, keeping Discover history invisible to the Wheel.
    let outboundQuery = this.sb.from("interactions").select("to_user_id").eq("from_user_id", userId);
    if (interactionTypesToExclude && interactionTypesToExclude.length > 0) {
      outboundQuery = (outboundQuery as any).in("type", interactionTypesToExclude);
    }

    const [interactedResult, activeMatchesResult, inboundOpensResult, blocksResult] = await Promise.all([
      // 1. Profiles the current user has already interacted with (type-filtered for Wheel,
      //    all types for Discover).
      outboundQuery,
      // 2. Active match partners (regardless of which side created the match).
      this.sb
        .from("matches")
        .select("user1_id, user2_id")
        .eq("status", "active")
        .or(`user1_id.eq.${userId},user2_id.eq.${userId}`),
      // 3. Users who have sent an inbound open (like) to the current user.
      //    These appear on the Likes page and must NOT also appear in Discovery
      //    or the Intention Wheel — a single profile should only be in one place.
      this.sb
        .from("interactions")
        .select("from_user_id")
        .eq("to_user_id", userId)
        .eq("type", "open"),
      // A block is directional in storage but reciprocal in visibility: neither
      // member can be surfaced to the other in Discover or the Intention Wheel.
      this.sb
        .from("interactions")
        .select("from_user_id, to_user_id")
        .eq("type", "block")
        .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`),
    ]);

    if (interactedResult.error) {
      console.error("[MATCH_FILTER] interactions fetch error:", interactedResult.error.message);
    }
    if (activeMatchesResult.error) {
      console.error("[MATCH_FILTER] active matches fetch error:", activeMatchesResult.error.message);
    }
    if (inboundOpensResult.error) {
      console.error("[MATCH_FILTER] inbound opens fetch error:", inboundOpensResult.error.message);
    }
    if (blocksResult.error) {
      console.error("[MATCH_FILTER] user block fetch error:", blocksResult.error.message);
    }

    // Outbound: profiles this user has already acted on.
    const interactedIds = new Set<string>(
      (interactedResult.data || []).map((r: any) => r.to_user_id).filter(Boolean)
    );

    // Active match partners: extract the OTHER user regardless of user1/user2 column.
    const activeMatchUserIds = new Set<string>();
    for (const row of (activeMatchesResult.data || [])) {
      const otherId = (row.user1_id === userId ? row.user2_id : row.user1_id) as string | null;
      if (otherId) activeMatchUserIds.add(otherId);
    }

    // Inbound openers: users who have liked the current user but not yet matched.
    // Already visible on the Likes page — must not duplicate into Discovery or Wheel.
    const inboundOpenerIds = new Set<string>(
      (inboundOpensResult.data || []).map((r: any) => r.from_user_id).filter(Boolean)
    );

    const blockedUserIds = new Set<string>();
    for (const row of (blocksResult.data || [])) {
      const otherId = row.from_user_id === userId ? row.to_user_id : row.from_user_id;
      if (otherId) blockedUserIds.add(otherId as string);
    }

    const excludedIds = new Set<string>([
      ...interactedIds,
      ...activeMatchUserIds,
      ...inboundOpenerIds,
      ...blockedUserIds,
    ]);

    // ── Blocked contact enforcement ──────────────────────────────────────────────
    try {
      const [blockedList, meResult] = await Promise.all([
        getBlockedContactsForUser(userId),
        this.sb.from("profiles").select("phone_number, email").eq("user_id", userId).maybeSingle(),
      ]);
      const blockedPhones = blockedList.map(c => c.phoneNumber).filter(Boolean);
      const blockedEmails = blockedList.map((c: any) => c.email).filter(Boolean) as string[];
      if (blockedPhones.length > 0 || blockedEmails.length > 0) {
        const filters = [
          ...blockedPhones.map(p => `phone_number.eq.${p}`),
          ...blockedEmails.map(e => `email.eq.${e}`),
        ].join(",");
        const { data: fwdData } = await this.sb.from("profiles").select("user_id").or(filters);
        for (const row of (fwdData || [])) {
          if (row.user_id) excludedIds.add(row.user_id);
        }
      }
      const myPhone: string | null = (meResult as any)?.data?.phone_number ?? null;
      const myEmail: string | null = (meResult as any)?.data?.email ?? null;
      if (myPhone || myEmail) {
        const conditions = [
          ...(myPhone ? [eq(blockedContacts.phoneNumber, myPhone)] : []),
          ...(myEmail ? [eq((blockedContacts as any).email, myEmail)] : []),
        ];
        if (conditions.length > 0) {
          const reverseRows = await db
            .select({ blockerUserId: blockedContacts.userId })
            .from(blockedContacts)
            .where(conditions.length === 1 ? conditions[0] : or(...conditions));
          for (const row of reverseRows) {
            if (row.blockerUserId) excludedIds.add(row.blockerUserId);
          }
        }
      }
    } catch (blockErr) {
      console.error("[MATCH_FILTER] blocked-contact enforcement error:", blockErr);
    }
    // ── End blocked contact enforcement ─────────────────────────────────────────

    console.log("[MATCH_FILTER] currentUserId:", userId.slice(0, 8));
    console.log("[MATCH_FILTER] excluded breakdown:", {
      outbound: interactedIds.size,
      activeMatches: activeMatchUserIds.size,
      inboundLikers: inboundOpenerIds.size,
      userBlocks: blockedUserIds.size,
      total: excludedIds.size,
    });

    return { excludedIds, interactedIds, activeMatchUserIds, inboundOpenerIds, blockedUserIds };
  }

  async getDiscoverProfiles(userId: string, gender: string, preference: string, ageMin: number = 18, ageMax: number = 99, locationRadius: number = 0, userLat: number | null = null, userLng: number | null = null, userDatingIntent: string | null = null, userConnectionStyle: string | null = null): Promise<Profile[]> {
    // Select all columns EXCEPT photos — base64 images in photos make rows huge (100s KB each).
    // Fetching photos for 100 profiles at once transfers 50–100 MB and causes a statement timeout.
    // Photos are fetched individually per-card by the client via GET /api/profiles/:userId.
    // lat/lng only included when the DB migration has been confirmed at startup.
    // Including non-existent columns causes the entire query to fail and return [].
    const POOL_COLS = [
      "id", "user_id", "first_name", "age", "gender", "dating_preference",
      "location", ...(_hasLatLngColumns ? ["latitude", "longitude"] : []), "height",
      "signals", "dating_intent", "green_flags",
      "connection_style", "conversation_starters", "questions",
      ...(_hasCustomQColumn ? ["custom_questions"] : []),
      ...(_hasViewerQColumn ? ["viewer_questions"] : []),
      ...(_hasCustomStartersColumn ? ["custom_starters"] : []),
      ...(_hasDateOfBirthColumn ? ["date_of_birth"] : []),
      ...(_hasPronounsColumn ? ["pronouns"] : []),
      ...(_hasCustomGreenFlagsColumn ? ["custom_green_flags"] : []),
      ...(_hasCustomSignalsColumn ? ["custom_signals"] : []),
      "location_radius", "preferred_age_min", "preferred_age_max",
      "email", "phone_number", "photo_verified", "onboarding_complete", "created_at",
      ...(_hasLastActiveColumn ? ["last_active"] : []),
      ...(_hasShowLastActiveColumn ? ["show_last_active"] : []),
    ].join(", ");

    const effectiveAgeMin = Math.max(18, ageMin);
    const effectiveAgeMax = Math.min(99, ageMax);

    // Base query: exclude own profile, require onboarding complete.
    // Age filter uses OR to treat NULL age as a pass-through (graceful degradation
    // for profiles where age wasn't stored — null age must not block everyone).
    let profilesQuery = this.sb
      .from("profiles")
      .select(POOL_COLS)
      .neq("user_id", userId)
      .eq("onboarding_complete", true)
      .or(`age.is.null,age.gte.${effectiveAgeMin}`)
      .or(`age.is.null,age.lte.${effectiveAgeMax}`);

    // Exclude paused profiles from discovery when column exists.
    if (_hasIsPausedColumn) {
      profilesQuery = (profilesQuery as any).or("is_paused.is.null,is_paused.eq.false");
    }
    // Exclude profiles whose owner has not yet confirmed their email address.
    // The column is set lazily (fire-and-forget) by isAuthenticated the first
    // time a verified user makes an API request, so it self-heals over time.
    if (_hasEmailVerifiedColumn) {
      profilesQuery = (profilesQuery as any).eq("email_verified", true);
    }

    // ── Mutual-compatibility filters ────────────────────────────────────────
    // Both conditions must hold:
    //   1. candidate.gender matches what the current user wants to see
    //   2. candidate.dating_preference includes the current user's gender
    // This ensures discovery is reciprocal — neither party wastes a slot
    // on someone who wouldn't be interested in them.

    const normGender = normalizeGender(gender);
    const normPref   = normalizeDatingPreference(preference);

    // 1. Filter by what the current user wants to see (their preference → target gender).
    //    Skip when preference is unset — show all genders rather than nothing.
    const targetGenders = normPref ? getGendersForPreference(normPref) : null;
    if (targetGenders && targetGenders.length > 0) {
      profilesQuery = profilesQuery.in("gender", targetGenders);
    }

    // 2. Mutual filter: candidate must also be interested in the current user's gender.
    //    Skip when current user's gender is unset — don't collapse pool to "everyone"-only.
    const candidateMustPrefer = normGender ? getPreferencesThatIncludeGender(normGender) : [];
    if (candidateMustPrefer.length > 0) {
      profilesQuery = profilesQuery.in("dating_preference", candidateMustPrefer);
    }

    if (IS_DEV) console.log("[DISCOVER] mutual-compat filters:", {
      userId,
      myGender: gender,
      myGenderNorm: normGender,
      myPreference: preference,
      myPrefNorm: normPref,
      targetGenders: targetGenders ?? "all",
      candidateMustPrefer,
      ageRange: `${effectiveAgeMin}–${effectiveAgeMax}`,
    });

    const t1 = Date.now();
    // Step 1: build unified exclusion set + fetch elevates in parallel.
    // buildExcludedUserIds covers both interaction-based and match-based exclusions so that
    // Discovery uses the same filtering logic as the Intention Wheel.
    const [{ excludedIds, interactedIds, activeMatchUserIds, inboundOpenerIds }, elevates, memberUserIds] = await Promise.all([
      this.buildExcludedUserIds(userId),
      getActiveElevatesMap(),
      getActiveMemberUserIds(),
    ]);
    if (IS_DEV) console.log(`[DISCOVER] exclusions+elevates done in ${Date.now() - t1} ms`);
    if (activeMatchUserIds.size > 0) {
      console.log("[DISCOVERY_FILTER] excluded matched users:", activeMatchUserIds.size);
    }

    // Step 2: apply exclusion at DB level so LIMIT is applied to the correct pool.
    // Cap at 300 entries to stay within PostgREST URL length limits; power users
    // (>300 entries) fall back to a higher in-memory limit with sufficient headroom.
    const useDbExclusion = excludedIds.size <= 300;
    if (useDbExclusion && excludedIds.size > 0) {
      profilesQuery = profilesQuery.not("user_id", "in", `(${[...excludedIds].join(",")})`);
    }

    // Step 3: DB-level bounding box pre-filter.
    // Narrows the initial pool to only profiles within the geographic square before
    // LIMIT is applied.  Without this, with e.g. 10,000 users globally all 100/500
    // slots can be filled by far-away profiles, leaving 0 after the Haversine pass.
    // The box is slightly larger than the circle — Haversine trims the corners in memory.
    // Profiles with null lat/lng are excluded by the range filter (correct: they must be
    // geocoded first via backfill or inline geocoding).
    const useBBox = _hasLatLngColumns && userLat !== null && userLng !== null && locationRadius > 0;
    if (useBBox) {
      const bbox = computeBoundingBox(userLat!, userLng!, locationRadius);
      profilesQuery = (profilesQuery as any)
        .gte("latitude", bbox.minLat)
        .lte("latitude", bbox.maxLat)
        .gte("longitude", bbox.minLng)
        .lte("longitude", bbox.maxLng);
    }

    // When bounding box is active, all returned rows are already nearby so fetch
    // up to 500.  Without bbox the global pool is too large — cap at 100 (DB exclusion)
    // or 500 (in-memory exclusion) as before.
    // ── Pre-query summary log ────────────────────────────────────────────────
    // Emitted on every discover call (not just IS_DEV) so production issues are
    // visible in deployment logs.  Shows every active filter so you can trace
    // exactly why the pool is small without needing to attach a debugger.
    console.log("[POOL_DEBUG] discover filters applied:", {
      userId: userId.slice(0, 8),
      onboarding_complete: true,
      email_verified: _hasEmailVerifiedColumn ? "= true (column present)" : "SKIPPED (column absent)",
      is_paused: _hasIsPausedColumn ? "IS NULL OR false" : "SKIPPED (column absent)",
      gender_target: targetGenders ?? "all (no pref set)",
      candidate_must_prefer: candidateMustPrefer.length > 0 ? candidateMustPrefer : "any (user gender unset)",
      age_range: `${effectiveAgeMin}–${effectiveAgeMax}`,
      exclusions: useDbExclusion
        ? `${excludedIds.size} IDs excluded at DB level`
        : `${excludedIds.size} IDs to be excluded in memory (>300)`,
      bbox: useBBox
        ? `±${locationRadius}mi around (${userLat?.toFixed(3)},${userLng?.toFixed(3)})`
        : "DISABLED (no coords or radius = 0)",
      db_limit: useBBox ? 500 : (useDbExclusion ? 100 : 500),
    });

    const t2 = Date.now();
    const profilesResult = await profilesQuery.limit(useBBox ? 500 : (useDbExclusion ? 100 : 500));
    if (IS_DEV) console.log(`[DISCOVER] profiles query done in ${Date.now() - t2} ms`);

    if (profilesResult.error) {
      console.error("[DISCOVER] profiles fetch error:", profilesResult.error.message, profilesResult.error.code);
      return [];
    }

    const now = new Date();
    const all = (profilesResult.data || []).map(mapProfile);

    console.log(`[POOL_DEBUG] after DB query (onboarding+email_verified+gender+pref+age+bbox+exclusions): ${all.length}`);

    // ── In-memory age verification pass ─────────────────────────────────────
    // Null age passes through — profiles without an age are not excluded.
    // Only exclude when age is a concrete value outside the preferred range.
    let excludedByAge = 0;
    const ageVerified = all.filter(p => {
      const candidateAge = p.age;
      if (candidateAge != null && (candidateAge < effectiveAgeMin || candidateAge > effectiveAgeMax)) {
        excludedByAge++;
        return false;
      }
      return true;
    });
    console.log(`[POOL_DEBUG] after age (discover): ${ageVerified.length} (removed ${excludedByAge})`);

    // DB-exclusion path: returned profiles are already excluded — no second filter needed.
    // Large-exclusion fallback: apply in-memory exclusion on the wider 500-profile batch.
    let excludedByInteraction = 0;
    const baseFiltered = useDbExclusion
      ? ageVerified
      : ageVerified.filter(p => {
          if (!excludedIds.has(p.userId)) return true;
          excludedByInteraction++;
          return false;
        });

    // ── POOL_DEBUG: separate outbound vs inbound exclusion counts ────────────
    {
      const nonInboundExcluded = new Set([...excludedIds].filter(id => !inboundOpenerIds.has(id)));
      const afterLMB = ageVerified.filter(p => !nonInboundExcluded.has(p.userId));
      console.log(`[POOL_DEBUG] after liked/matched/pass/block (discover): ${afterLMB.length} (removed ${ageVerified.length - afterLMB.length})`);
      const afterInbound = afterLMB.filter(p => !inboundOpenerIds.has(p.userId));
      console.log(`[POOL_DEBUG] after inbound likes (discover): ${afterInbound.length} (removed ${afterLMB.length - afterInbound.length})`);
    }

    // ── Distance filter ──────────────────────────────────────────────────────
    // Exact Haversine check in memory (the DB bounding box above already narrowed
    // the pool to a geographic square — this trims the circle corners precisely).
    // Candidates without geocoded coordinates are EXCLUDED when radius filtering is
    // active — prevents unlocated profiles appearing in the wrong city.
    let distanceFiltered = baseFiltered;
    let excludedByDistance = 0;
    let nullCoordCount = 0;
    if (_hasLatLngColumns && userLat !== null && userLng !== null && locationRadius > 0) {
      distanceFiltered = baseFiltered.filter(p => {
        if (p.latitude == null || p.longitude == null) {
          nullCoordCount++;
          return false; // no coords → exclude when radius is set
        }
        const within = haversineDistanceMiles(userLat!, userLng!, p.latitude, p.longitude) <= locationRadius;
        if (!within) excludedByDistance++;
        return within;
      });
    }
    console.log(`[POOL_DEBUG] after distance (discover): ${distanceFiltered.length} (removed ${excludedByDistance}, null-coord excluded: ${nullCoordCount})`);

    // ── Background geocode for null-coord candidates ─────────────────────────
    // If any candidates in the pool had location text but no coordinates they were
    // excluded above.  Trigger async Nominatim geocoding for them (max 5 per request,
    // 1.1 s apart to respect rate limits) so they appear on the next discover call.
    if (nullCoordCount > 0 && _hasLatLngColumns) {
      const needsGeocode = baseFiltered.filter(p => p.latitude == null && p.longitude == null && p.location);
      if (needsGeocode.length > 0) {
        console.log(`[DISCOVER] scheduling background geocode for ${needsGeocode.length} null-coord candidate(s)`);
        const sb = this.sb;
        (async () => {
          for (const p of needsGeocode.slice(0, 5)) {
            if (!p.location) continue;
            try {
              const coords = await geocodeLocation(p.location);
              if (coords) {
                await sb.from("profiles").update({ latitude: coords.lat, longitude: coords.lng }).eq("user_id", p.userId);
                console.log(`[DISCOVER:BGEO] "${p.location}" → ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
              }
            } catch { /* non-blocking */ }
            await new Promise(r => setTimeout(r, 1100));
          }
        })();
      }
    }

    const filtered = mergeElevatesIntoProfiles(distanceFiltered, elevates);

    // Fallback tier 1: both mutual filters applied but pool is still empty.
    // Relax the mutual filter and try again with ONLY the gender-preference filter
    // (candidate.gender matches what user wants) so the discover screen is never
    // completely blank on a small user base.
    if (filtered.length === 0) {
      console.log("[DISCOVER] Mutual-compat pool empty — relaxing to gender-only filter for fallback");
      let fallbackQuery = this.sb
        .from("profiles")
        .select(POOL_COLS)
        .neq("user_id", userId)
        .eq("onboarding_complete", true)
        // Null-safe age filter in fallback too
        .or(`age.is.null,age.gte.${effectiveAgeMin}`)
        .or(`age.is.null,age.lte.${effectiveAgeMax}`);

      if (targetGenders && targetGenders.length > 0) {
        fallbackQuery = fallbackQuery.in("gender", targetGenders);
      }

      // Apply bounding box at DB level in fallback too — same rationale as main pool.
      if (useBBox) {
        const bbox = computeBoundingBox(userLat!, userLng!, locationRadius);
        fallbackQuery = (fallbackQuery as any)
          .gte("latitude", bbox.minLat)
          .lte("latitude", bbox.maxLat)
          .gte("longitude", bbox.minLng)
          .lte("longitude", bbox.maxLng);
      }

      const { data: fallbackData, error: fallbackErr } = await (fallbackQuery as any).limit(useBBox ? 500 : 100);
      if (!fallbackErr && fallbackData && fallbackData.length > 0) {
        const fallbackAll: Profile[] = (fallbackData as any[]).map(mapProfile);
        const fallbackFiltered = fallbackAll.filter((p: Profile) => {
          // Null age passes through in fallback too
          if (p.age != null && (p.age < effectiveAgeMin || p.age > effectiveAgeMax)) return false;
          if (excludedIds.has(p.userId)) return false;
          // ── RADIUS FILTER: apply to fallback pool too ───────────────────────
          // Without this, a Portsmouth user with 25-mile radius who has no nearby
          // mutually-compatible profiles would get Sydney profiles from this
          // fallback — completely bypassing the distance setting.
          if (_hasLatLngColumns && userLat !== null && userLng !== null && locationRadius > 0) {
            if (p.latitude == null || p.longitude == null) return false;
            if (haversineDistanceMiles(userLat, userLng, p.latitude, p.longitude) > locationRadius) return false;
          }
          return true;
        });
        const fallbackWithElevates = mergeElevatesIntoProfiles(fallbackFiltered, elevates);
        const fallbackResult = await rankWithPersonalization(
          fallbackWithElevates, userId, this.sb, userLat, userLng, locationRadius,
          userDatingIntent, userConnectionStyle, memberUserIds, now, 20,
        );
        console.log(`[POOL_DEBUG] final discovery count (gender-only fallback, distance-filtered): ${fallbackResult.length}`);
        return fallbackResult;
      }
    }

    const result = await rankWithPersonalization(
      filtered, userId, this.sb, userLat, userLng, locationRadius,
      userDatingIntent, userConnectionStyle, memberUserIds, now, 20,
    );
    console.log(`[POOL_DEBUG] final discovery count: ${result.length}`);

    // ── Exclusion leak audit ─────────────────────────────────────────────────
    // Sanity check: confirm no excluded user (liked/passed/matched/inbound)
    // leaked into the final result.  Fires a WARNING if one did — that would
    // indicate a bug in the DB exclusion or in-memory fallback path.
    const leaks = result.filter(p => excludedIds.has(p.userId));
    if (leaks.length > 0) {
      console.warn(`[POOL_DEBUG] ⚠️  EXCLUSION LEAK: ${leaks.length} excluded user(s) in final result:`,
        leaks.map(p => `${p.userId.slice(0, 8)}…`).join(", "));
    } else {
      console.log(`[POOL_DEBUG] exclusion leak check: ✓ no excluded users in result`);
    }

    return result;
  }

  async createInteraction(data: InsertInteraction): Promise<Interaction> {
    const { data: result, error } = await this.sb
      .from("interactions")
      .insert({
        from_user_id: data.fromUserId,
        to_user_id: data.toUserId,
        type: data.type,
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to create interaction: ${error.message} (code: ${error.code})`);
    return mapInteraction(result);
  }

  async updateInteractionType(interactionId: string, newType: string): Promise<void> {
    const { error } = await this.sb
      .from("interactions")
      .update({ type: newType })
      .eq("id", interactionId);
    if (error) throw new Error(`Failed to update interaction type: ${error.message}`);
  }

  async getInteraction(fromUserId: string, toUserId: string): Promise<Interaction | undefined> {
    const { data, error } = await this.sb
      .from("interactions")
      .select("id, type, from_user_id, to_user_id, created_at")
      .eq("from_user_id", fromUserId)
      .eq("to_user_id", toUserId)
      .maybeSingle();
    if (error || !data) return undefined;
    return mapInteraction(data);
  }

  async getMutualOpen(user1Id: string, user2Id: string): Promise<boolean> {
    const { data, error } = await this.sb
      .from("interactions")
      .select("id")
      .eq("from_user_id", user2Id)
      .eq("to_user_id", user1Id)
      .eq("type", "open")
      .maybeSingle();
    return !!data && !error;
  }

  async createMatch(user1Id: string, user2Id: string): Promise<Match> {
    const { data: result, error } = await this.sb
      .from("matches")
      .insert({ user1_id: user1Id, user2_id: user2Id })
      .select()
      .single();
    if (error) throw new Error(`Failed to create match: ${error.message}`);
    return mapMatch(result);
  }

  async getMatchesForUser(userId: string): Promise<(Match & { profile: Profile; lastMessage: { content: string; senderId: string; createdAt: Date | null } | null })[]> {
    const t0 = Date.now();

    const { data: userMatches, error } = await this.sb
      .from("matches")
      .select("*")
      .eq("status", "active")
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

    if (error || !userMatches || userMatches.length === 0) {
      console.log("[CHAT] CONNECTIONS_EMPTY", { userId, error: error?.message, ms: Date.now() - t0 });
      return [];
    }

    const matchIds = userMatches.map(row => row.id);

    // Build a deduplicated list of other-user IDs to batch-fetch profiles in ONE query.
    const otherUserIdMap = new Map<string, string>(); // matchId → otherUserId
    for (const row of userMatches) {
      otherUserIdMap.set(row.id, row.user1_id === userId ? row.user2_id : row.user1_id);
    }
    const otherUserIds = [...new Set(otherUserIdMap.values())];

    // Single batch profile query + last-message query in parallel.
    // This replaces the previous N-round-trip pattern (one query per match).
    const [profilesResult, messagesResult] = await Promise.all([
      this.sb
        .from("profiles")
        .select(getMatchProfileCols())
        .in("user_id", otherUserIds),
      this.sb
        .from("messages")
        .select("match_id, content, sender_id, created_at")
        .in("match_id", matchIds)
        .not("content", "like", "__SCHEDULE__%")
        .order("created_at", { ascending: false })
        .limit(500),       // cap: last ~50 messages per match on average
    ]);

    if (IS_DEV) console.log("[CHAT] CONNECTIONS_FETCHED", {
      userId,
      matchCount: userMatches.length,
      profilesFound: profilesResult.data?.length ?? 0,
      profilesError: profilesResult.error?.message,
      messagesError: messagesResult.error?.message,
      msTotal: Date.now() - t0,
    });

    // Build profile lookup: user_id → profile row
    const profileByUserId = new Map<string, any>();
    for (const p of profilesResult.data ?? []) {
      profileByUserId.set((p as any).user_id, p);
    }

    // Build last-message map: messages are already ordered DESC, first per match_id = latest
    const lastMsgMap = new Map<string, { content: string; senderId: string; createdAt: Date | null }>();
    for (const row of messagesResult.data ?? []) {
      if (!lastMsgMap.has(row.match_id)) {
        lastMsgMap.set(row.match_id, {
          content: row.content,
          senderId: row.sender_id,
          createdAt: row.created_at ? new Date(row.created_at) : null,
        });
      }
    }

    const result: (Match & { profile: Profile; lastMessage: { content: string; senderId: string; createdAt: Date | null } | null })[] = [];

    for (const matchRow of userMatches) {
      const otherUserId = otherUserIdMap.get(matchRow.id)!;
      const profileData = profileByUserId.get(otherUserId);
      if (!profileData) {
        console.warn("[CHAT] PROFILE_NOT_FOUND", { matchId: matchRow.id, otherUserId });
        continue;
      }
      result.push({
        ...mapMatch(matchRow),
        profile: mapProfile(profileData),
        lastMessage: lastMsgMap.get(matchRow.id) ?? null,
      });
    }

    result.sort((a, b) => {
      const aTime = a.lastMessage?.createdAt?.getTime() ?? a.createdAt?.getTime() ?? 0;
      const bTime = b.lastMessage?.createdAt?.getTime() ?? b.createdAt?.getTime() ?? 0;
      return bTime - aTime;
    });

    if (IS_DEV) console.log("[CHAT] CONNECTIONS_SORTED", { count: result.length, userId, msTotal: Date.now() - t0 });
    return result;
  }

  async getMatch(matchId: string, userId: string): Promise<(Match & { profile: Profile; messages: Message[] }) | undefined> {
    const t0 = Date.now();
    const { data: matchData, error } = await this.sb
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (error) {
      console.error("GET_MATCH_ERROR", matchId, error.message, error.code);
      return undefined;
    }
    if (!matchData) {
      console.log("GET_MATCH_NO_DATA", matchId, userId);
      return undefined;
    }

    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;

    const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;

    // Fetch profile (no photos) and latest 40 messages in parallel.
    // Limit is 40 for fast mobile load; older messages are paginated via getMessagesPage().
    // Messages fetched DESC so we get the most recent first, then reversed to ASC for chat.
    const MSG_COLS = "id, match_id, sender_id, content, reaction, created_at";
    const t1 = Date.now();
    const [profileResult, msgResult] = await Promise.all([
      this.sb.from("profiles").select(getMatchProfileCols()).eq("user_id", otherUserId).maybeSingle(),
      this.sb.from("messages").select(MSG_COLS).eq("match_id", matchId)
        .order("created_at", { ascending: false }).limit(40),
    ]);
    if (IS_DEV) console.log(`[GET_MATCH] profile+msgs parallel: ${Date.now() - t1}ms | msgs=${msgResult.data?.length ?? 0}`);

    if (profileResult.error) {
      console.error("GET_MATCH_PROFILE_ERROR", { matchId, userId, otherUserId, msg: profileResult.error.message });
      return undefined;
    }
    if (!profileResult.data) {
      console.log("GET_MATCH_PROFILE_NOT_FOUND", { matchId, userId, otherUserId });
      return undefined;
    }

    // Reverse so messages are in ascending (oldest-first) order for the chat view.
    const messages = (msgResult.data || []).reverse().map(mapMessage);

    if (IS_DEV) console.log("[PERF] GET_MATCH_DONE", { matchId, msgCount: messages.length, ms: Date.now() - t0 });
    return {
      ...match,
      profile: mapProfile(profileResult.data),
      messages,
    };
  }

  // Paginated messages — fetches `limit` messages before the `before` ISO cursor.
  // Uses the compound index idx_messages_match_id_created_at for fast lookup.
  async getMessagesPage(
    matchId: string,
    limit: number,
    before?: string,
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    const MSG_COLS = "id, match_id, sender_id, content, reaction, created_at";
    const t0 = Date.now();
    let q = this.sb
      .from("messages")
      .select(MSG_COLS)
      .eq("match_id", matchId)
      .order("created_at", { ascending: false })
      .limit(limit + 1);
    if (before) q = (q as any).lt("created_at", before);
    const { data, error } = await q;
    if (error) throw new Error(`getMessagesPage: ${error.message}`);
    const rows = data ?? [];
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map(mapMessage);
    if (IS_DEV) console.log(`[MSG_PAGE] matchId=${matchId} before=${before?.slice(0,20)} limit=${limit} got=${messages.length} hasMore=${hasMore} ms=${Date.now()-t0}`);
    return { messages, hasMore };
  }

  async createMessage(data: InsertMessage): Promise<Message> {
    if (IS_DEV) console.log("CREATE_MSG", { matchId: data.matchId, senderId: data.senderId, contentLen: data.content?.length });
    const { data: result, error } = await this.sb
      .from("messages")
      .insert({
        match_id: data.matchId,
        sender_id: data.senderId,
        content: data.content,
      })
      .select()
      .single();
    if (error) {
      console.error("CREATE_MSG_ERROR", error.message, error.code, error.details);
      throw new Error(`Failed to create message: ${error.message}`);
    }
    return mapMessage(result);
  }

  async getMessage(messageId: string): Promise<{ data: any; error: any }> {
    return this.sb
      .from("messages")
      .select("*")
      .eq("id", messageId)
      .maybeSingle();
  }

  async getMatchParticipants(matchId: string): Promise<{ user1Id: string; user2Id: string } | null> {
    const { data } = await this.sb
      .from("matches")
      .select("user1_id, user2_id")
      .eq("id", matchId)
      .maybeSingle();
    if (!data) return null;
    return { user1Id: data.user1_id, user2Id: data.user2_id };
  }

  // Lightweight match validation for the message send route.
  // Only fetches the 6 columns needed to validate sender + check stage/limits.
  // Avoids the full getMatch() which fetches profile + 100 messages (~500ms wasted).
  async getMatchMeta(matchId: string, userId: string): Promise<{
    user1Id: string; user2Id: string;
    callStage: number;
    messageCount1: number; messageCount2: number;
    callAvail1: string | null; callAvail2: string | null;
    callAvail1At: string | null; callAvail2At: string | null;
    agreedCallAt: string | null;
  } | null> {
    // NOTE: call_avail_1 / call_avail_2 (legacy TEXT columns) were never applied
    // to Supabase — only to Neon.  Selecting them causes a PostgREST column-not-found
    // error → null → 404 on every message POST.  They are replaced by the *_at columns
    // (call_avail_1_at / call_avail_2_at) which DO exist in Supabase.
    const { data, error } = await this.sb
      .from("matches")
      .select("id, user1_id, user2_id, call_stage, message_count_1, message_count_2, call_avail_1_at, call_avail_2_at, agreed_call_at")
      .eq("id", matchId)
      .eq("status", "active")
      .maybeSingle();
    if (error || !data) return null;
    if (data.user1_id !== userId && data.user2_id !== userId) return null;
    return {
      user1Id: data.user1_id,
      user2Id: data.user2_id,
      callStage: data.call_stage || 0,
      messageCount1: data.message_count_1 || 0,
      messageCount2: data.message_count_2 || 0,
      callAvail1: null,   // legacy TEXT col absent from Supabase; use callAvail1At
      callAvail2: null,   // legacy TEXT col absent from Supabase; use callAvail2At
      callAvail1At: data.call_avail_1_at ?? null,
      callAvail2At: data.call_avail_2_at ?? null,
      agreedCallAt: data.agreed_call_at ?? null,
    };
  }

  async reactToMessage(messageId: string, reaction: string | null): Promise<Message> {
    const { data: result, error } = await this.sb
      .from("messages")
      .update({ reaction })
      .eq("id", messageId)
      .select()
      .single();
    if (error) {
      console.error("REACT_MSG_ERROR", error.message, error.code);
      throw new Error(`Failed to react to message: ${error.message}`);
    }
    return mapMessage(result);
  }

  async getUserMessageCount(matchId: string, userId: string): Promise<number> {
    // Read the per-stage DB counter (message_count_1/2) — the same value the client displays.
    // This counter is:
    //   • incremented by incrementMessageCount() for every text message sent
    //   • NOT incremented for system messages (__SCHEDULE__, __VOICE__, __PHONE__)
    //   • reset to 0 by completeCall() after each voice/video call
    //
    // Previously this used a raw SELECT COUNT(*) from the messages table, which counted
    // ALL message rows (including system messages and previous-stage messages that still
    // exist after a call). That caused the server to block 10 messages into stage 1
    // (15 old stage-0 rows + 10 new = 25 limit) while the client showed "25 left".
    const { data, error } = await this.sb
      .from("matches")
      .select("id, user1_id, message_count_1, message_count_2")
      .eq("id", matchId)
      .maybeSingle();
    if (error || !data) return 0;
    return data.user1_id === userId ? (data.message_count_1 || 0) : (data.message_count_2 || 0);
  }

  async incrementMessageCount(matchId: string, userId: string): Promise<void> {
    const { data: matchData, error: fetchError } = await this.sb
      .from("matches")
      .select("id, user1_id, user2_id, message_count_1, message_count_2")
      .eq("id", matchId)
      .maybeSingle();
    if (fetchError) {
      console.error("INCREMENT_MSG_COUNT_FETCH_ERROR", { matchId, userId, error: fetchError.message, code: fetchError.code });
      return;
    }
    if (!matchData) return;
    const match = mapMatch(matchData);

    if (match.user1Id === userId) {
      const { error } = await this.sb
        .from("matches")
        .update({ message_count_1: (match.messageCount1 || 0) + 1 })
        .eq("id", matchId);
      if (error) console.error("INCREMENT_MSG_COUNT_UPDATE_ERROR", { matchId, userId, field: "message_count_1", error: error.message, code: error.code });
    } else {
      const { error } = await this.sb
        .from("matches")
        .update({ message_count_2: (match.messageCount2 || 0) + 1 })
        .eq("id", matchId);
      if (error) console.error("INCREMENT_MSG_COUNT_UPDATE_ERROR", { matchId, userId, field: "message_count_2", error: error.message, code: error.code });
    }
  }

  async startCall(matchId: string, userId: string, isPaidCredit?: boolean): Promise<{ match: Match; status: "created" | "reused" | "blocked" | "self_call" } | undefined> {
    console.log("[startCall] CALL_SESSION_CHECKED", { matchId, userId });
    const { data: matchData, error: readError } = await this.sb
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (readError) {
      console.error("[startCall] CALL_START_ERROR DB read failed:", { message: readError.message, code: readError.code, details: readError.details, hint: readError.hint, matchId, userId });
      throw new Error(`DB read failed: ${readError.message} (code: ${readError.code})`);
    }
    if (!matchData) {
      console.log("[startCall] Match not found in DB:", matchId);
      return undefined;
    }
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) {
      console.log("[startCall] User not in match:", { userId, user1Id: match.user1Id, user2Id: match.user2Id });
      return undefined;
    }
    // Self-call guard: the callee must be a different account than the caller.
    // This blocks degenerate matches (user1Id === user2Id) and any scenario
    // where the same account appears on both sides of the match row.
    const calleeId = match.user1Id === userId ? match.user2Id : match.user1Id;
    if (calleeId === userId) {
      console.warn("[startCall] SELF_CALL_BLOCKED — caller and callee are the same account", { matchId, userId });
      return { match, status: "self_call" };
    }
    const stage = match.callStage || 0;
    if (!isPaidCredit) {
      // Guided progression stage gates — only enforced for free/earned calls.
      if (stage >= 4) {
        console.log("[startCall] All call stages completed:", { matchId, callStage: stage });
        return undefined;
      }
      if (stage === 2) {
        console.log("[startCall] Stage 2 is post-second-call messaging — no calls allowed:", { matchId, stage });
        return undefined;
      }
      if (stage === 3 && !(match.faceCallUser1Accepted && match.faceCallUser2Accepted)) {
        console.log("[startCall] Face call not mutually accepted:", { matchId, stage, fc1: match.faceCallUser1Accepted, fc2: match.faceCallUser2Accepted });
        return undefined;
      }
    } else {
      console.log("[startCall] PAID_CREDIT_CALL — bypassing stage gates", { matchId, stage, userId });
    }

    if (match.callStartedAt && match.callInitiatorId) {
      const callAge = Date.now() - new Date(match.callStartedAt).getTime();
      const STALE_RINGING_MS = 2 * 60 * 1000;
      const STALE_ANSWERED_MS = 5 * 60 * 1000;
      const isStale = (!match.callAnswered && callAge > STALE_RINGING_MS) || (match.callAnswered && callAge > STALE_ANSWERED_MS);

      if (isStale) {
        console.log("[startCall] STALE_CALL_CLEARED", { matchId, callAge, answered: match.callAnswered, oldInitiator: match.callInitiatorId });
        const { data: cleared, error: clearError } = await this.sb
          .from("matches")
          .update({ call_started_at: null, call_initiator_id: null, call_answered: false, call_completed: false })
          .eq("id", matchId)
          .select()
          .maybeSingle();
        if (clearError) {
          console.error("[startCall] CALL_START_ERROR stale clear DB error:", { matchId, message: clearError.message, code: clearError.code, details: clearError.details, hint: clearError.hint });
          throw new Error(`Failed to clear stale call: ${clearError.message} (code: ${clearError.code})`);
        }
        if (!cleared) {
          console.error("[startCall] CALL_START_ERROR stale clear returned 0 rows (RLS or missing match):", { matchId, userId });
          throw new Error("Failed to clear stale call session — database permission denied or match not found");
        }
        console.log("[startCall] STALE_CALL_CLEAR_OK", { matchId, callSessionId: null });
      } else {
        if (match.callInitiatorId === userId) {
          console.log("[startCall] CALL_SESSION_REUSED", { matchId, existingInitiator: match.callInitiatorId, callSessionId: match.callSessionId });
          return { match, status: "reused" };
        }
        console.log("[startCall] DUPLICATE_CALL_BLOCKED", { matchId, existingInitiator: match.callInitiatorId, blockedCaller: userId, callSessionId: match.callSessionId });
        return { match, status: "blocked" };
      }
    }

    const { data: updated, error } = await this.sb
      .from("matches")
      .update({
        call_started_at: new Date().toISOString(),
        call_initiator_id: userId,
        call_answered: false,
        call_completed: false,
      })
      .eq("id", matchId)
      .is("call_started_at", null)
      .select()
      .maybeSingle();

    if (error) {
      console.error("[startCall] CALL_START_ERROR DB update error:", { matchId, message: error.message, code: error.code, details: error.details, hint: error.hint, userId });
      throw new Error(`Call setup failed: ${error.message} (code: ${error.code})`);
    }

    if (!updated) {
      const { data: recheck, error: recheckError } = await this.sb.from("matches").select("*").eq("id", matchId).maybeSingle();
      if (recheckError) {
        console.error("[startCall] CALL_START_ERROR recheck DB error:", { matchId, message: recheckError.message, code: recheckError.code });
        throw new Error(`Call setup failed during recheck: ${recheckError.message}`);
      }
      if (recheck) {
        const recheckMatch = mapMatch(recheck);
        if (recheckMatch.callStartedAt && recheckMatch.callInitiatorId) {
          console.log("[startCall] DUPLICATE_CALL_BLOCKED (race)", { matchId, existingInitiator: recheckMatch.callInitiatorId, blockedCaller: userId });
          return { match: recheckMatch, status: "blocked" };
        }
        console.error("[startCall] CALL_START_ERROR update returned 0 rows but no active call found (RLS policy blocking update?):", { matchId, userId, callStartedAt: recheckMatch.callStartedAt });
        throw new Error("Call setup failed: database did not update the call state (possible permission issue)");
      }
      console.error("[startCall] CALL_START_ERROR recheck returned null:", { matchId, userId });
      throw new Error("Call setup failed: match disappeared during call setup");
    }

    const result = mapMatch(updated);
    console.log("[startCall] CALL_SESSION_CREATED", { matchId, callSessionId: result.callSessionId, userId });
    return { match: result, status: "created" };
  }

  async answerCall(matchId: string, userId: string): Promise<Match | undefined> {
    console.log("[answerCall] Reading match", { matchId, userId });
    const { data: matchData, error: readError } = await this.sb
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (readError) {
      console.error("[answerCall] DB read error:", { message: readError.message, code: readError.code, details: readError.details, hint: readError.hint, matchId, userId });
      throw new Error(`Call answer failed: cannot read match state (${readError.message}, code: ${readError.code})`);
    }
    if (!matchData) {
      console.log("[answerCall] Match not found:", matchId);
      return undefined;
    }
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) {
      console.log("[answerCall] User not in match:", { userId, user1Id: match.user1Id, user2Id: match.user2Id });
      return undefined;
    }
    if (match.callInitiatorId === userId) {
      console.log("[answerCall] Cannot answer own call:", { matchId, userId });
      return undefined;
    }
    if (!match.callStartedAt || !match.callInitiatorId) {
      console.log("[answerCall] No active call to answer:", { matchId, callStartedAt: match.callStartedAt, callInitiatorId: match.callInitiatorId });
      return undefined;
    }

    const { data: updated, error } = await this.sb
      .from("matches")
      .update({
        call_answered: true,
      })
      .eq("id", matchId)
      .select()
      .maybeSingle();
    if (error) {
      console.error("[answerCall] DB update error:", { message: error.message, code: error.code, details: error.details, hint: error.hint, matchId, userId });
      throw new Error(`Call answer failed: cannot update call state (${error.message}, code: ${error.code})`);
    }
    if (!updated) {
      console.error("[answerCall] DB update returned 0 rows (RLS policy blocking update?):", { matchId, userId });
      throw new Error("Call answer failed: database did not accept the answer (possible permission issue)");
    }
    console.log("[answerCall] CALL_SESSION_JOINED", { matchId, callSessionId: match.callSessionId, userId });
    return mapMatch(updated);
  }

  async cancelCall(matchId: string, userId: string): Promise<Match | undefined> {
    console.log("[cancelCall] CANCEL_CALL_START", { matchId, userId });

    let matchData: any;
    try {
      const { data, error: readError } = await this.sb
        .from("matches")
        .select("*")
        .eq("id", matchId)
        .maybeSingle();
      if (readError) {
        console.error("[cancelCall] CANCEL_CALL_ERROR DB_READ_FAILED", { matchId, userId, error: readError.message, code: readError.code, details: readError.details });
        throw new Error(`DB read failed: ${readError.message}`);
      }
      matchData = data;
    } catch (err: any) {
      if (err.message?.startsWith("DB read failed")) throw err;
      console.error("[cancelCall] CANCEL_CALL_ERROR DB_READ_EXCEPTION", { matchId, userId, error: err.message, stack: err.stack });
      throw new Error(`DB read exception: ${err.message}`);
    }

    if (!matchData) {
      console.log("[cancelCall] CANCEL_CALL_ERROR MATCH_NOT_FOUND", { matchId, userId });
      return undefined;
    }

    console.log("[cancelCall] CANCEL_CALL_MATCH_READ", { matchId, user1Id: matchData.user1_id, user2Id: matchData.user2_id, callStartedAt: matchData.call_started_at, callInitiatorId: matchData.call_initiator_id });
    const match = mapMatch(matchData);

    if (match.user1Id !== userId && match.user2Id !== userId) {
      console.log("[cancelCall] CANCEL_CALL_ERROR USER_NOT_IN_MATCH", { matchId, user1Id: match.user1Id, user2Id: match.user2Id, userId });
      return undefined;
    }

    let updated: any;
    try {
      const { data, error } = await this.sb
        .from("matches")
        .update({
          call_started_at: null,
          call_initiator_id: null,
          call_answered: false,
          call_completed: false,
        })
        .eq("id", matchId)
        .select()
        .single();
      if (error) {
        console.warn("[cancelCall] DB_UPDATE_FAILED (will use pre-read data)", { matchId, userId, error: error.message, code: error.code });
      } else {
        updated = data;
      }
    } catch (err: any) {
      console.warn("[cancelCall] DB_UPDATE_EXCEPTION (will use pre-read data)", { matchId, userId, error: err.message });
    }

    if (updated) {
      console.log("[cancelCall] CANCEL_CALL_SUCCESS", { matchId, userId, source: "db_update" });
      return mapMatch(updated);
    }

    console.log("[cancelCall] CANCEL_CALL_SUCCESS", { matchId, userId, source: "pre_read_fallback" });
    match.callStartedAt = null;
    match.callInitiatorId = null;
    match.callAnswered = false;
    match.callCompleted = false;
    return match;
  }

  async completeCall(matchId: string, userId: string, options?: CompleteCallOptions): Promise<CompleteCallResult | undefined> {
    const { data: matchData, error: readError } = await this.sb
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (readError) {
      console.error("[completeCall] DB read error:", { matchId, userId, message: readError.message, code: readError.code });
      throw new Error(`completeCall read failed: ${readError.message} (code: ${readError.code})`);
    }
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;

    // Idempotency guard: if the call is already cleared, nothing to do
    if (!match.callStartedAt && !match.callAnswered && !match.callInitiatorId) {
      console.log("[completeCall] Already cleared — returning current state (idempotent)", { matchId, userId });
      return { match, counted: false };
    }

    if (!match.callAnswered) {
      // Call was never answered — just clear it, no stage advance
      const { data: updated, error: clearError } = await this.sb
        .from("matches")
        .update({
          call_started_at: null,
          call_initiator_id: null,
          call_answered: false,
          call_completed: false,
        })
        .eq("id", matchId)
        .select()
        .maybeSingle();
      if (clearError) {
        console.error("[completeCall] DB clear error (unanswered):", { matchId, userId, message: clearError.message, code: clearError.code });
        throw new Error(`completeCall clear failed: ${clearError.message} (code: ${clearError.code})`);
      }
      console.log("[completeCall] CALL_STATE:accepted→cleared (never connected, no stage advance)", { matchId, userId });
      return { match: updated ? mapMatch(updated) : match, counted: false };
    }

    // ──────────────────────────────────────────────────────────────
    // Call was answered. Determine whether it counts as a used slot.
    //
    // A call COUNTS only if WebRTC actually connected AND stayed live
    // for at least MIN_VALID_CALL_MS. Anything shorter (connection
    // failure, immediate drop, network error) is a refund — we clear
    // the call fields but do NOT advance the stage.
    // ──────────────────────────────────────────────────────────────
    const connected = options?.connected !== false; // default true (backward-compat for callers without WebRTC context)
    const connectedDurationMs = options?.connectedDurationMs ?? (connected ? MIN_VALID_CALL_MS : 0);
    const callState = options?.callState ?? "ended";
    const callCounts = connected && connectedDurationMs >= MIN_VALID_CALL_MS;

    console.log("[completeCall] CALL_COMPLETION_EVALUATION", {
      matchId, userId, callState,
      connected, connectedDurationMs, MIN_VALID_CALL_MS, callCounts,
    });

    if (!callCounts) {
      // Not enough live connection — clear without advancing stage (refund)
      const reason = !connected ? "no_webrtc_connection" : `below_minimum_duration(${connectedDurationMs}ms<${MIN_VALID_CALL_MS}ms)`;
      console.log("[completeCall] CALL_STATE:accepted→cleared SLOT_REFUNDED", { matchId, userId, reason, callState });
      const { data: updated, error: clearError } = await this.sb
        .from("matches")
        .update({
          call_started_at: null,
          call_initiator_id: null,
          call_answered: false,
          call_completed: false,
        })
        .eq("id", matchId)
        .select()
        .maybeSingle();
      if (clearError) {
        console.error("[completeCall] DB clear error (not counted):", { matchId, userId, message: clearError.message });
        throw new Error(`completeCall clear failed: ${clearError.message} (code: ${clearError.code})`);
      }
      return { match: updated ? mapMatch(updated) : match, counted: false };
    }

    // Call counts — advance the stage
    const currentStage = match.callStage || 0;
    if (currentStage >= 4) {
      console.log("[completeCall] All stages already completed", { matchId, userId, currentStage });
      return { match, counted: false };
    }
    if (currentStage === 2) {
      // Stage 2 is the post-second-call messaging phase — no calls happen here.
      console.log("[completeCall] Unexpected completeCall at messaging stage 2, ignoring", { matchId, userId });
      return { match, counted: false };
    }
    const nextStage = Math.min(currentStage + 1, 4);

    const stageUpdate: Record<string, any> = {
      call_completed: false,
      call_started_at: null,
      call_initiator_id: null,
      call_answered: false,
      call_stage: nextStage,
      date_choice_user1: null,
      date_choice_user2: null,
    };

    if (currentStage === 0) {
      stageUpdate.message_count_1 = 0;
      stageUpdate.message_count_2 = 0;
      console.log("[CONNECTION_STAGE] FIRST_CALL_ENDED", { matchId, userId, newStage: nextStage, connectedDurationMs });
      console.log("[CONNECTION_STAGE] CONNECTION_STAGE_CHANGED", { matchId, from: "first_call", to: "post_call_messaging", nextStage });
    } else if (currentStage === 1) {
      // Reset per-user counters so stage 2 starts at 0/0 (20-message allowance).
      stageUpdate.message_count_1 = 0;
      stageUpdate.message_count_2 = 0;
      console.log("[CONNECTION_STAGE] SECOND_CALL_ENDED", { matchId, userId, newStage: nextStage, connectedDurationMs });
      console.log("[CONNECTION_STAGE] CONNECTION_STAGE_CHANGED", { matchId, from: "second_call", to: "post_second_call_messaging", nextStage });
    } else if (currentStage === 3) {
      console.log("[CONNECTION_STAGE] FACE_CALL_ENDED", { matchId, userId, newStage: nextStage, connectedDurationMs });
      console.log("[CONNECTION_STAGE] CONNECTION_STAGE_CHANGED", { matchId, from: "face_call", to: "all_done", nextStage });
    }

    const { data: updated, error: updateError } = await this.sb
      .from("matches")
      .update(stageUpdate)
      .eq("id", matchId)
      .select()
      .maybeSingle();
    if (updateError) {
      console.error("[completeCall] DB update error:", { matchId, userId, message: updateError.message, code: updateError.code, details: updateError.details });
      throw new Error(`completeCall update failed: ${updateError.message} (code: ${updateError.code})`);
    }
    console.log("[completeCall] CALL_STATE:connected→ended STAGE_ADVANCED", { matchId, userId, newStage: nextStage, connectedDurationMs });
    return { match: updated ? mapMatch(updated) : match, counted: true };
  }

  async setDateChoice(matchId: string, userId: string, choice: 'plan' | 'keep' | null): Promise<Match | undefined> {
    const { data: matchData } = await this.sb
      .from("matches")
      .select("id,user1_id,user2_id")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const isUser1 = matchData.user1_id === userId;
    const col = isUser1 ? "date_choice_user1" : "date_choice_user2";
    const { data: updated, error } = await this.sb
      .from("matches")
      .update({ [col]: choice })
      .eq("id", matchId)
      .select()
      .maybeSingle();
    if (error) {
      console.error("[setDateChoice] DB error:", error.message);
      return undefined;
    }
    return updated ? mapMatch(updated) : undefined;
  }

  async acceptFaceCall(matchId: string, userId: string): Promise<Match | undefined> {
    const { data: matchData } = await this.sb
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) !== 3) return undefined;

    const updates: Record<string, any> = {};
    if (match.user1Id === userId) {
      updates.face_call_user1_accepted = true;
    } else {
      updates.face_call_user2_accepted = true;
    }

    const { data: updated } = await this.sb
      .from("matches")
      .update(updates)
      .eq("id", matchId)
      .select()
      .single();
    return updated ? mapMatch(updated) : undefined;
  }

  async declineFaceCall(matchId: string, userId: string): Promise<Match | undefined> {
    const { data: matchData } = await this.sb
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) !== 3) return undefined;

    const { data: updated } = await this.sb
      .from("matches")
      .update({
        call_stage: 4,
        face_call_user1_accepted: false,
        face_call_user2_accepted: false,
      })
      .eq("id", matchId)
      .select()
      .single();
    return updated ? mapMatch(updated) : undefined;
  }

  async getPopularProfiles(limit: number = 10, preference?: string, gender?: string, userId?: string, locationRadius?: number, userLat?: number | null, userLng?: number | null, ageMin: number = 18, ageMax: number = 99, userDatingIntent: string | null = null, userConnectionStyle: string | null = null, userSignals: string[] = []): Promise<Profile[]> {
    // Photos excluded from this query — same reasoning as getDiscoverProfiles.
    // Intent page lazy-loads photos per wheel item via GET /api/profiles/:userId/photos.
    // lat/lng only included when DB migration is confirmed (same guard as POOL_COLS).
    const WHEEL_COLS = [
      "id", "user_id", "first_name", "age", "gender", "dating_preference",
      "location", ...(_hasLatLngColumns ? ["latitude", "longitude"] : []), "height",
      "signals", "dating_intent", "green_flags",
      "connection_style", "conversation_starters", "questions",
      ...(_hasCustomQColumn ? ["custom_questions"] : []),
      ...(_hasViewerQColumn ? ["viewer_questions"] : []),
      ...(_hasCustomStartersColumn ? ["custom_starters"] : []),
      ...(_hasDateOfBirthColumn ? ["date_of_birth"] : []),
      ...(_hasPronounsColumn ? ["pronouns"] : []),
      ...(_hasCustomGreenFlagsColumn ? ["custom_green_flags"] : []),
      ...(_hasCustomSignalsColumn ? ["custom_signals"] : []),
      "location_radius", "preferred_age_min", "preferred_age_max",
      "email", "phone_number", "photo_verified", "onboarding_complete", "created_at",
      ...(_hasLastActiveColumn ? ["last_active"] : []),
    ].join(", ");

    // Clamp age range to valid bounds — identical to getDiscoverProfiles.
    const effectiveAgeMin = Math.max(18, ageMin);
    const effectiveAgeMax = Math.min(99, ageMax);

    // Pre-compute mutual-compat filter values — identical to getDiscoverProfiles.
    // Skip each filter when the corresponding field is unset so the pool is never
    // collapsed to an empty-or-"everyone"-only set when the profile is incomplete.
    const normGender = normalizeGender(gender);
    const normPref   = normalizeDatingPreference(preference);
    const targetGenders       = normPref ? getGendersForPreference(normPref) : null;
    const candidateMustPrefer = normGender ? getPreferencesThatIncludeGender(normGender) : [];

    console.log("[WHEEL] mutual-compat + age filters:", {
      userId: userId ?? "(none)",
      myGender: gender ?? "(none)",
      myGenderNorm: normGender,
      myPreference: preference ?? "(none)",
      myPrefNorm: normPref,
      targetGenders: targetGenders ?? "all",
      candidateMustPrefer: candidateMustPrefer.length ? candidateMustPrefer : "any",
      ageRange: `${effectiveAgeMin}–${effectiveAgeMax}`,
    });

    // Helper: apply mutual-compat + age filters to a Supabase query builder.
    // Age uses null-safe OR so profiles without an age are never blocked (same as Discovery).
    const applyFilters = (q: any): any => {
      if (targetGenders && targetGenders.length > 0) q = q.in("gender", targetGenders);
      if (candidateMustPrefer.length > 0) q = q.in("dating_preference", candidateMustPrefer);
      // Null-safe age filter — null age passes through (graceful degradation).
      q = q.or(`age.is.null,age.gte.${effectiveAgeMin}`);
      q = q.or(`age.is.null,age.lte.${effectiveAgeMax}`);
      return q;
    };

    // Build exclusion set (wheel-acted + active matches) and fetch popularity data in parallel.
    // IMPORTANT: pass ["wheel_connection"] so only profiles explicitly acted on through the
    // Intention Wheel are excluded.  Discover open/close rows must NOT exclude Wheel candidates
    // — the two surfaces are independent (see: wheel-discover-isolation).
    const twPopT0 = Date.now();
    const emptyExclusion = { excludedIds: new Set<string>(), interactedIds: new Set<string>(), activeMatchUserIds: new Set<string>(), inboundOpenerIds: new Set<string>() };
    const [exclusionResult, popularRowsResult] = await Promise.all([
      userId ? this.buildExcludedUserIds(userId, ["wheel_connection"]) : Promise.resolve(emptyExclusion),
      this.sb.from("interactions").select("to_user_id").eq("type", "open").limit(2000),
    ]);
    console.log(`[WHEEL] exclusions+popularity queries done in ${Date.now() - twPopT0} ms`);

    const { excludedIds, activeMatchUserIds, interactedIds, inboundOpenerIds } = exclusionResult;
    // Same 300-cap as Discovery: apply exclusion at DB level when set is small enough.
    const useDbExclusion = excludedIds.size <= 300;
    console.log("[WHEEL_FILTER] exclusion breakdown (wheel-only history — Discover history excluded):", {
      wheelActed: interactedIds.size,
      activeMatches: activeMatchUserIds.size,
      inboundLikers: inboundOpenerIds.size,
      total: excludedIds.size,
      useDbExclusion,
    });

    const popularRows = popularRowsResult.data;

    const countMap = new Map<string, number>();
    for (const row of popularRows || []) {
      countMap.set(row.to_user_id, (countMap.get(row.to_user_id) || 0) + 1);
    }
    const sortedIds = [...countMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit * 3) // fetch more to account for interaction exclusions
      .map(([id]) => id);

    console.log("[WHEEL] interactions pool:", popularRows?.length ?? 0, "| popular ids:", sortedIds.length);

    let allProfiles: Profile[] = [];

    if (sortedIds.length > 0) {
      // Apply age + mutual-compat filters, plus DB-level exclusion of already-interacted
      // profiles (same 300-cap as Discovery).  Without this, the popular query fills
      // allProfiles with up to `limit` excluded users, preventing the fill query from
      // ever running and leaving the wheel with 0–1 eligible profiles.
      let query = this.sb
        .from("profiles")
        .select(WHEEL_COLS)
        .eq("onboarding_complete", true)
        .in("user_id", sortedIds);

      // Exclude paused accounts — parity with getDiscoverProfiles.
      if (_hasIsPausedColumn) {
        query = (query as any).or("is_paused.is.null,is_paused.eq.false");
      }

      if (useDbExclusion && excludedIds.size > 0) {
        query = query.not("user_id", "in", `(${[...excludedIds].join(",")})`);
      }

      query = applyFilters(query);
      if (_hasEmailVerifiedColumn) {
        query = (query as any).eq("email_verified", true);
      }

      const { data, error } = await query;
      if (error) console.error("[WHEEL] popular query error:", error.message);
      allProfiles = (data || []).map(mapProfile);

      const orderMap = new Map(sortedIds.map((id, i) => [id, i]));
      allProfiles.sort((a, b) => (orderMap.get(a.userId) ?? 99) - (orderMap.get(b.userId) ?? 99));
    }

    console.log(`[WHEEL_FILTER] after popularity DB query: ${allProfiles.length} candidates`);

    // Fill remaining slots from any eligible profile (most recently joined first).
    if (allProfiles.length < limit) {
      const existingIds = allProfiles.map(r => r.userId);
      let query = this.sb
        .from("profiles")
        .select(WHEEL_COLS)
        .eq("onboarding_complete", true)
        .order("created_at", { ascending: false });

      // Exclude paused accounts — parity with getDiscoverProfiles.
      if (_hasIsPausedColumn) {
        query = (query as any).or("is_paused.is.null,is_paused.eq.false");
      }

      if (_hasEmailVerifiedColumn) {
        query = (query as any).eq("email_verified", true);
      }

      // Combine already-fetched profiles, own profile, and (when within the URL-safe cap)
      // the full interaction-exclusion set — mirrors Discovery's DB-level exclusion.
      // This ensures fill doesn't waste its DB limit on profiles that will be removed
      // in the in-memory step.
      const fillExcludeSet = new Set([
        ...existingIds,
        ...(userId ? [userId] : []),
        ...(useDbExclusion ? [...excludedIds] : []),
      ]);
      if (fillExcludeSet.size > 0 && fillExcludeSet.size <= 400) {
        query = query.not("user_id", "in", `(${[...fillExcludeSet].join(",")})`);
      } else if (existingIds.length > 0 || userId) {
        // Fallback: at minimum exclude already-fetched + own profile
        const minExclude = userId ? [...existingIds, userId] : existingIds;
        if (minExclude.length > 0) {
          query = query.not("user_id", "in", `(${minExclude.join(",")})`);
        }
      }

      query = applyFilters(query);

      // Bounding box on fill query — same rationale as Discovery.
      // Without this, all fill slots could be filled by far-away profiles and
      // the in-memory distance filter would empty the wheel for small user bases.
      const wheelUseBBox = _hasLatLngColumns && userLat != null && userLng != null && locationRadius && locationRadius > 0;
      if (wheelUseBBox) {
        const bbox = computeBoundingBox(userLat!, userLng!, locationRadius!);
        query = (query as any)
          .gte("latitude", bbox.minLat)
          .lte("latitude", bbox.maxLat)
          .gte("longitude", bbox.minLng)
          .lte("longitude", bbox.maxLng);
      }

      const { data: extra, error: fillError } = await (query as any).limit(wheelUseBBox ? limit * 15 : limit * 3);
      if (fillError) console.error("[WHEEL] fill query error:", fillError.message);
      allProfiles.push(...(extra || []).map(mapProfile));
    }

    console.log(`[POOL_DEBUG] total profiles (wheel): ${allProfiles.length}`);

    // ── In-memory age verification ───────────────────────────────────────────
    // Mirrors getDiscoverProfiles: null age passes through; only exclude concrete out-of-range ages.
    let wheelExcludedByAge = 0;
    const ageVerified = allProfiles.filter(p => {
      if (p.age != null && (p.age < effectiveAgeMin || p.age > effectiveAgeMax)) {
        wheelExcludedByAge++;
        return false;
      }
      return true;
    });
    console.log(`[POOL_DEBUG] after age (wheel): ${ageVerified.length} (removed ${wheelExcludedByAge})`);

    // ── POOL_DEBUG: separate outbound vs inbound exclusion counts ────────────
    // Also emit per-candidate reasons so you can see in production logs exactly
    // which profile was removed and why when the wheel shows 0 results.
    {
      const nonInboundExcluded = new Set([...excludedIds].filter(id => !inboundOpenerIds.has(id)));
      let removedByLMB = 0, removedByInbound = 0;
      for (const p of ageVerified) {
        if (nonInboundExcluded.has(p.userId)) {
          removedByLMB++;
          const reason = activeMatchUserIds.has(p.userId) ? "active_match"
                       : interactedIds.has(p.userId)     ? "already_interacted"
                       :                                    "blocked";
          console.log(`[WHEEL_EXCL] ${p.firstName ?? p.userId.slice(0,8)}… excluded reason=${reason}`);
        } else if (inboundOpenerIds.has(p.userId)) {
          removedByInbound++;
          console.log(`[WHEEL_EXCL] ${p.firstName ?? p.userId.slice(0,8)}… excluded reason=inbound_liker (visible on Likes page)`);
        }
      }
      console.log(`[POOL_DEBUG] after liked/matched/pass/block (wheel): ${ageVerified.length - removedByLMB} (removed ${removedByLMB})`);
      console.log(`[POOL_DEBUG] after inbound likes (wheel): ${ageVerified.length - removedByLMB - removedByInbound} (removed ${removedByInbound})`);
    }

    // ── Exclude interacted / matched / inbound-liked profiles (safety pass) ──
    // DB-level exclusion above handles most of this; in-memory pass catches any
    // edge cases (e.g. large exclusion set > 300 that bypassed DB filter).
    let wheelExcludedByInteraction = 0;
    const interactionFiltered = ageVerified.filter(p => {
      if (p.userId === userId) return false; // safety: never show own profile
      if (excludedIds.has(p.userId)) {
        wheelExcludedByInteraction++;
        return false;
      }
      return true;
    });
    if (wheelExcludedByInteraction > 0) {
      console.log(`[POOL_DEBUG] in-memory interaction safety removed: ${wheelExcludedByInteraction}`);
    }

    // ── Distance filter ──────────────────────────────────────────────────────
    // Mirrors getDiscoverProfiles: null coords excluded when radius is set.
    let wheelExcludedByDistance = 0;
    let distanceFiltered = interactionFiltered;
    const distanceActive = _hasLatLngColumns && userLat != null && userLng != null && locationRadius && locationRadius > 0;
    if (distanceActive) {
      distanceFiltered = interactionFiltered.filter(p => {
        if (p.latitude == null || p.longitude == null) {
          wheelExcludedByDistance++;
          console.log(`[WHEEL_EXCL] ${p.firstName ?? p.userId.slice(0,8)}… excluded reason=no_coords (distance filter active radius=${locationRadius}mi)`);
          return false;
        }
        const dist = haversineDistanceMiles(userLat!, userLng!, p.latitude, p.longitude);
        const within = dist <= locationRadius!;
        if (!within) {
          wheelExcludedByDistance++;
          console.log(`[WHEEL_EXCL] ${p.firstName ?? p.userId.slice(0,8)}… excluded reason=distance dist=${dist.toFixed(0)}mi > radius=${locationRadius}mi`);
        }
        return within;
      });
    }
    console.log(`[POOL_DEBUG] after distance (wheel): ${distanceFiltered.length} (removed ${wheelExcludedByDistance})`);

    // ── Last-resort fallback ─────────────────────────────────────────────────
    // FIX: use the same gender-only relaxation as getDiscoverProfiles instead of a
    // completely unconstrained query that showed profiles outside the user's preference.
    if (distanceFiltered.length === 0) {
      console.log("[WHEEL] pool empty after all filters — relaxing to gender-only fallback (mirrors Discovery)");
      let fallbackQuery = this.sb
        .from("profiles")
        .select(WHEEL_COLS)
        .eq("onboarding_complete", true)
        .or(`age.is.null,age.gte.${effectiveAgeMin}`)
        .or(`age.is.null,age.lte.${effectiveAgeMax}`)
        .order("created_at", { ascending: false })
        .limit(limit * 3);

      // Exclude paused accounts — parity with getDiscoverProfiles.
      if (_hasIsPausedColumn) {
        fallbackQuery = (fallbackQuery as any).or("is_paused.is.null,is_paused.eq.false");
      }

      // Keep gender filter; relax the mutual-compat (dating_preference) filter.
      if (targetGenders && targetGenders.length > 0) {
        fallbackQuery = fallbackQuery.in("gender", targetGenders);
      }

      const { data: fallback, error: fallbackErr } = await fallbackQuery;
      if (fallbackErr) console.error("[WHEEL] fallback query error:", fallbackErr.message);
      const fallbackMapped = (fallback || []).map(mapProfile).filter(p => {
        if (p.userId === userId || excludedIds.has(p.userId)) return false;
        // ── RADIUS FILTER: apply to wheel fallback pool too ─────────────────
        // Same bug as Discovery: without this a Portsmouth user with 25-mile
        // radius gets Sydney profiles from the fallback.
        if (_hasLatLngColumns && userLat != null && userLng != null && locationRadius && locationRadius > 0) {
          if (p.latitude == null || p.longitude == null) return false;
          if (haversineDistanceMiles(userLat, userLng, p.latitude, p.longitude) > locationRadius) return false;
        }
        return true;
      });
      distanceFiltered = fallbackMapped;
      console.log(`[POOL_DEBUG] final wheel count (gender-only fallback, distance-filtered): ${distanceFiltered.length}`);
    }

    // Score each candidate with the Standout algorithm (quality 50 % + compatibility 30 %),
    // then select a diverse top set.  Elevate/Super Elevate provide meaningful boosts
    // but cannot override a well-matched, high-quality profile.
    const elevates = await getActiveElevatesMap();
    const now = new Date();
    const memberUserIds = await getActiveMemberUserIds();
    const elevatedProfiles = mergeElevatesIntoProfiles(distanceFiltered, elevates);
    const scored = elevatedProfiles.map(p => ({
      profile: p,
      score: scoreForWheel(p, userDatingIntent, userConnectionStyle, userSignals, memberUserIds, now),
    }));
    if (IS_DEV) {
      const sorted = [...scored].sort((a, b) => b.score - a.score);
      sorted.slice(0, 5).forEach(({ profile: p, score: s }) => {
        console.log(`[WHEEL_SCORE] ${(p as any).firstName ?? p.userId.slice(0, 8)} | standout=${s.toFixed(1)}`);
      });
    }
    const wheelResult = selectWheelStandouts(scored, elevatedProfiles.length);
    console.log(`[POOL_DEBUG] final wheel count (before route slice): ${wheelResult.length}`);
    return wheelResult;
  }

  async getSpinStandouts(userId: string): Promise<string[]> {
    const { data } = await this.sb
      .from("spin_standouts")
      .select("standout_user_id")
      .eq("user_id", userId);
    return (data || []).map(r => r.standout_user_id);
  }

  async addSpinStandout(userId: string, standoutUserId: string): Promise<void> {
    await this.sb
      .from("spin_standouts")
      .insert({ user_id: userId, standout_user_id: standoutUserId });
  }

  async getSpinsToday(userId: string): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    const { count } = await this.sb
      .from("spin_usage")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("spin_date", today);
    return count || 0;
  }

  async getSpinsThisWeek(userId: string): Promise<number> {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
    const weekStart = monday.toISOString().slice(0, 10);

    const { count } = await this.sb
      .from("spin_usage")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("spin_date", weekStart);
    return count || 0;
  }

  async recordSpin(userId: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    await this.sb
      .from("spin_usage")
      .insert({ user_id: userId, spin_date: today });
  }

  async getSpinCredits(userId: string): Promise<number> {
    const [row] = await db
      .select({ balance: sparkBalances.balance })
      .from(sparkBalances)
      .where(eq(sparkBalances.userId, userId));
    return row?.balance ?? 0;
  }

  async consumeSpinCredit(userId: string): Promise<boolean> {
    // Atomic UPDATE so two concurrent requests cannot both decrement the
    // same balance. The WHERE balance > 0 guard is evaluated and the update
    // applied in a single statement; rowCount tells us if a row was changed.
    const result = await db.execute(sql`
      UPDATE spark_balances
      SET balance = balance - 1, updated_at = NOW()
      WHERE user_id = ${userId} AND balance > 0
      RETURNING balance
    `);
    return (result.rowCount ?? 0) > 0;
  }

  async grantSpinCredits(userId: string, qty: number, packType: string, stripeSessionId: string): Promise<void> {
    await db.transaction(async (tx) => {
      // Upsert: create row with qty, or increment existing balance.
      await tx
        .insert(sparkBalances)
        .values({ userId, balance: qty })
        .onConflictDoUpdate({
          target: sparkBalances.userId,
          set: {
            balance: sql`spark_balances.balance + ${qty}`,
            updatedAt: new Date(),
          },
        });
      // Audit record — stripeSessionId is UNIQUE so duplicate webhooks are
      // no-ops (the processedStripeSessions idempotency table is still the
      // primary guard, but this gives a purchase history too).
      await tx.insert(sparkPurchases).values({ userId, packType, quantity: qty, stripeSessionId }).onConflictDoNothing();
    });
  }

  async getDailyLikeCount(userId: string): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    const startOfDay = `${today}T00:00:00.000Z`;
    const endOfDay = `${today}T23:59:59.999Z`;

    const { count } = await this.sb
      .from("interactions")
      .select("*", { count: "exact", head: true })
      .eq("from_user_id", userId)
      .eq("type", "open")
      .gte("created_at", startOfDay)
      .lte("created_at", endOfDay);
    return count || 0;
  }

  async getConsecutiveLikeDays(userId: string, goal: number): Promise<number> {
    // Single query: fetch all opens in the last 7 days, process dates in JS
    const today = new Date();
    const cutoff = new Date(today);
    cutoff.setDate(today.getDate() - 6);

    const { data } = await this.sb
      .from("interactions")
      .select("created_at")
      .eq("from_user_id", userId)
      .eq("type", "open")
      .gte("created_at", `${cutoff.toISOString().slice(0, 10)}T00:00:00.000Z`);

    // Count likes per calendar day (UTC)
    const likesByDay = new Map<string, number>();
    for (const row of data || []) {
      const dateStr = new Date(row.created_at).toISOString().slice(0, 10);
      likesByDay.set(dateStr, (likesByDay.get(dateStr) || 0) + 1);
    }

    let bestStreak = 0;
    for (let startOffset = 0; startOffset <= 1; startOffset++) {
      let streak = 0;
      for (let i = 0; i < 3; i++) {
        const checkDate = new Date(today);
        checkDate.setDate(today.getDate() - startOffset - i);
        const dateStr = checkDate.toISOString().slice(0, 10);
        if ((likesByDay.get(dateStr) || 0) >= goal) {
          streak++;
        } else {
          break;
        }
      }
      bestStreak = Math.max(bestStreak, streak);
    }
    return bestStreak;
  }

  async hasUnusedStreakSpin(userId: string): Promise<boolean> {
    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(today.getDate() - 3);
    const cutoffDate = threeDaysAgo.toISOString().slice(0, 10);

    const { count } = await this.sb
      .from("spin_usage")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("spin_date", cutoffDate);
    return (count || 0) === 0;
  }

  async createSpinRequest(fromUserId: string, toUserId: string, message: string): Promise<SpinRequest> {
    const { data: result, error } = await this.sb
      .from("spin_requests")
      .insert({
        from_user_id: fromUserId,
        to_user_id: toUserId,
        message,
        status: "pending",
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to create spin request: ${error.message}`);
    return mapSpinRequest(result);
  }


  async getIncomingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]> {
    const { data: requests } = await this.sb
      .from("spin_requests")
      .select("*")
      .eq("to_user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (!requests || requests.length === 0) return [];

    const fromIds = [...new Set(requests.map(r => r.from_user_id))];
    const { data: profileRows } = await this.sb
      .from("profiles")
      .select(getMatchProfileCols())
      .in("user_id", fromIds);

    const profileMap = new Map<string, any>((profileRows ?? []).map(p => [(p as any).user_id, p]));
    const result: (SpinRequest & { profile: Profile })[] = [];
    for (const req of requests) {
      const p = profileMap.get(req.from_user_id);
      if (p) result.push({ ...mapSpinRequest(req), profile: mapProfile(p) });
    }
    return result;
  }

  async getOutgoingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]> {
    const { data: requests } = await this.sb
      .from("spin_requests")
      .select("*")
      .eq("from_user_id", userId)
      .order("created_at", { ascending: false });

    if (!requests || requests.length === 0) return [];

    const toIds = [...new Set(requests.map(r => r.to_user_id))];
    const { data: profileRows } = await this.sb
      .from("profiles")
      .select(getMatchProfileCols())
      .in("user_id", toIds);

    const profileMap = new Map<string, any>((profileRows ?? []).map(p => [(p as any).user_id, p]));
    const result: (SpinRequest & { profile: Profile })[] = [];
    for (const req of requests) {
      const p = profileMap.get(req.to_user_id);
      if (p) result.push({ ...mapSpinRequest(req), profile: mapProfile(p) });
    }
    return result;
  }

  async respondToSpinRequest(requestId: string, userId: string, accept: boolean): Promise<SpinRequest | undefined> {
    const { data: reqData } = await this.sb
      .from("spin_requests")
      .select("*")
      .eq("id", requestId)
      .eq("to_user_id", userId)
      .maybeSingle();
    if (!reqData || reqData.status !== "pending") return undefined;

    const newStatus = accept ? "accepted" : "declined";
    const { data: updated } = await this.sb
      .from("spin_requests")
      .update({ status: newStatus })
      .eq("id", requestId)
      .select()
      .single();
    return updated ? mapSpinRequest(updated) : undefined;
  }

  async getSpinRequest(id: string): Promise<SpinRequest | undefined> {
    const { data } = await this.sb
      .from("spin_requests")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    return data ? mapSpinRequest(data) : undefined;
  }

  async setCallAvailability(matchId: string, userId: string, availableAt: string | null): Promise<Match | undefined> {
    // ── Step 1: Validate without reading availability (avoids stale-read race) ──
    const { data: matchData } = await this.sb
      .from("matches")
      .select("id, user1_id, user2_id, call_stage")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    if (matchData.user1_id !== userId && matchData.user2_id !== userId) return undefined;
    if ((matchData.call_stage || 0) !== 0) return undefined;

    const isUser1 = matchData.user1_id === userId;

    // ── Step 2: Write ONLY this user's own availability timestamp atomically ──
    // Separating this write from the agreed_call_at computation means that when
    // both users write concurrently, each write commits independently before the
    // agreement is calculated — agreed_call_at is never based on a stale read.
    const ownUpdate: Record<string, any> = {};
    if (availableAt === null) {
      if (isUser1) { ownUpdate.call_avail_1 = null; ownUpdate.call_avail_1_at = null; }
      else         { ownUpdate.call_avail_2 = null; ownUpdate.call_avail_2_at = null; }
    } else {
      const newTs = new Date(availableAt);
      if (isUser1) { ownUpdate.call_avail_1 = availableAt; ownUpdate.call_avail_1_at = newTs.toISOString(); }
      else         { ownUpdate.call_avail_2 = availableAt; ownUpdate.call_avail_2_at = newTs.toISOString(); }
    }
    const { error: ownWriteErr } = await this.sb.from("matches").update(ownUpdate).eq("id", matchId);
    if (ownWriteErr) throw new Error(`setCallAvailability own-write error: ${ownWriteErr.message}`);

    // ── Step 3: Re-read BOTH timestamps from the now-committed row ──
    // Any concurrent write by the partner will already be committed at this
    // point, so agreed_call_at is computed from the latest persisted values.
    const { data: fresh } = await this.sb
      .from("matches")
      .select("*, call_avail_1_at, call_avail_2_at")
      .eq("id", matchId)
      .single();
    if (!fresh) return undefined;

    // ── Step 4: Compute agreed_call_at from fresh committed values ──
    const COMPAT_TOLERANCE_MIN = 10;
    const agreeUpdate: Record<string, any> = {};
    if (availableAt === null) {
      // User cleared availability — no agreement possible
      agreeUpdate.agreed_call_at = null;
    } else {
      const myTs     = new Date(availableAt);
      const otherRaw = isUser1 ? fresh.call_avail_2_at : fresh.call_avail_1_at;
      if (otherRaw) {
        const otherTs = new Date(otherRaw);
        const diffMin = Math.abs(myTs.getTime() - otherTs.getTime()) / 60_000;
        agreeUpdate.agreed_call_at = diffMin <= COMPAT_TOLERANCE_MIN
          ? new Date(Math.max(myTs.getTime(), otherTs.getTime())).toISOString()
          : null;
      } else {
        agreeUpdate.agreed_call_at = null;
      }
    }

    // ── Step 5: Write agreed_call_at ──
    const { data: updated } = await this.sb
      .from("matches")
      .update(agreeUpdate)
      .eq("id", matchId)
      .select()
      .single();
    return updated ? mapMatch(updated) : undefined;
  }

  async clearAgreedCallAt(matchId: string): Promise<void> {
    await this.sb
      .from("matches")
      .update({ agreed_call_at: null })
      .eq("id", matchId);
  }

  async setMeetAvailability(matchId: string, userId: string, availability: string): Promise<Match | undefined> {
    const { data: matchData } = await this.sb
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) < 1) return undefined;

    const updates: Record<string, any> = {};
    if (match.user1Id === userId) {
      updates.meet_availability_1 = availability;
    } else {
      updates.meet_availability_2 = availability;
    }

    const { data: updated } = await this.sb
      .from("matches")
      .update(updates)
      .eq("id", matchId)
      .select()
      .single();
    return updated ? mapMatch(updated) : undefined;
  }

  async exchangeNumber(matchId: string, userId: string): Promise<Match | undefined> {
    const { data: matchData } = await this.sb
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) < 1) return undefined;
    if (!match.meetAvailability1 || !match.meetAvailability2) return undefined;

    const mySlots: string[] = JSON.parse(match.user1Id === userId ? match.meetAvailability1 : match.meetAvailability2);
    const theirSlots: string[] = JSON.parse(match.user1Id === userId ? match.meetAvailability2 : match.meetAvailability1);
    const hasMatchingSlots = mySlots.some(s => theirSlots.includes(s));
    if (!hasMatchingSlots) return undefined;

    const updates: Record<string, any> = {};
    if (match.user1Id === userId) {
      updates.number_exchanged_1 = true;
    } else {
      updates.number_exchanged_2 = true;
    }

    const { data: updated } = await this.sb
      .from("matches")
      .update(updates)
      .eq("id", matchId)
      .select()
      .single();
    return updated ? mapMatch(updated) : undefined;
  }

  async removeMatch(matchId: string, userId: string): Promise<boolean> {
    const { data: matchData } = await this.sb
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return false;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return false;

    await this.sb
      .from("matches")
      .update({ status: "removed" })
      .eq("id", matchId);
    return true;
  }

  async getMatchCount(userId: string): Promise<number> {
    const { count } = await this.sb
      .from("matches")
      .select("*", { count: "exact", head: true })
      .eq("status", "active")
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);
    return count || 0;
  }

  async findMatchBetweenUsers(userId1: string, userId2: string): Promise<Match | undefined> {
    const { data, error } = await this.sb
      .from("matches")
      .select("id, user1_id, user2_id, call_stage, status, created_at")
      .eq("status", "active")
      .or(`and(user1_id.eq.${userId1},user2_id.eq.${userId2}),and(user1_id.eq.${userId2},user2_id.eq.${userId1})`)
      .maybeSingle();
    if (error || !data) return undefined;
    return mapMatch(data);
  }

  async getIncomingOpens(userId: string): Promise<(Interaction & { profile: Profile })[]> {
    // All four queries run in parallel: three exclusion lookups AND the main
    // incoming-opens query simultaneously.  Exclusion filtering is done in
    // JavaScript after all results arrive, removing one sequential Supabase
    // round-trip (~150–300 ms) versus the old sequential pattern:
    //   [3 parallel exclusion queries] → opens query → profiles batch
    //
    // EXCLUSION RULE: only exclude senders that the recipient has already
    // "opened" (liked back) — those either matched already or will the
    // moment the sender's open is processed.  Senders the recipient merely
    // "closed" (passed in Discover) must still appear here because they
    // have since expressed interest and the recipient may want to reconsider.
    // Previously this query fetched ALL outgoing interactions regardless of
    // type, which caused every "close" to permanently hide that sender from
    // the Likes page — even after the sender liked back.  Fixed: .eq("type","open").
    const [myOpensResult, matchResult1, matchResult2, opensResult, blocksResult] = await Promise.all([
      this.sb
        .from("interactions")
        .select("to_user_id")
        .eq("from_user_id", userId)
        .eq("type", "open"),               // ← was missing; "close" no longer silences likes
      this.sb.from("matches").select("user1_id").eq("user2_id", userId).eq("status", "active"),
      this.sb.from("matches").select("user2_id").eq("user1_id", userId).eq("status", "active"),
      this.sb
        .from("interactions")
        .select("id, type, from_user_id, to_user_id, created_at")
        .eq("to_user_id", userId)
        .eq("type", "open")
        .order("created_at", { ascending: false })
        .limit(100), // slightly above the final 50 to absorb JS-side exclusions
      this.sb
        .from("interactions")
        .select("from_user_id, to_user_id")
        .eq("type", "block")
        .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`),
    ]);

    const excludeIds = new Set<string>([
      ...(myOpensResult.data || []).map((r: any) => r.to_user_id as string),
      ...(matchResult1.data || []).map((r: any) => r.user1_id as string),
      ...(matchResult2.data || []).map((r: any) => r.user2_id as string),
      ...(blocksResult.data || []).map((r: any) =>
        (r.from_user_id === userId ? r.to_user_id : r.from_user_id) as string
      ),
    ]);

    const allIncoming = opensResult.data || [];
    const incomingOpens = allIncoming
      .filter((o: any) => {
        const excluded = excludeIds.has(o.from_user_id);
        if (excluded) {
          console.log(
            `[INCOMING_LIKES] filtered sender=${o.from_user_id.slice(0,8)}… reason=` +
            (matchResult1.data?.some((r: any) => r.user1_id === o.from_user_id) ||
             matchResult2.data?.some((r: any) => r.user2_id === o.from_user_id)
              ? "already_matched"
              : "recipient_already_opened_sender")
          );
        }
        return !excluded;
      })
      .slice(0, 50);

    console.log(
      `[INCOMING_LIKES] recipientId=${userId.slice(0,8)}… ` +
      `rawRows=${allIncoming.length} excluded=${allIncoming.length - incomingOpens.length} ` +
      `returned=${incomingOpens.length}`
    );

    if (incomingOpens.length === 0) return [];

    // Batch-fetch profiles — photos are stripped (MATCH_PROFILE_COLS) and
    // lazy-loaded per card so this response never carries large base64 images.
    const fromUserIds = incomingOpens.map((o: any) => o.from_user_id);
    const { data: profileRows } = await this.sb
      .from("profiles")
      .select(getMatchProfileCols())
      .in("user_id", fromUserIds);

    const profileMap = new Map<string, any>();
    for (const row of profileRows ?? []) {
      profileMap.set((row as any).user_id, row);
    }

    const result = incomingOpens
      .map((open: any) => {
        const profileData = profileMap.get(open.from_user_id);
        if (!profileData) {
          console.log(`[INCOMING_LIKES] no profile for sender=${open.from_user_id.slice(0,8)}… — omitted`);
        }
        return profileData ? { ...mapInteraction(open), profile: mapProfile(profileData) } : null;
      })
      .filter(Boolean) as (Interaction & { profile: Profile })[];

    console.log(`[INCOMING_LIKES] final after profile join=${result.length}`);
    return result;
  }

  async createWheelSpark(fromUserId: string, toUserId: string): Promise<void> {
    const { data: existing } = await this.sb
      .from("interactions")
      .select("id")
      .eq("from_user_id", fromUserId)
      .eq("to_user_id", toUserId)
      .eq("type", "wheel_connection")
      .maybeSingle();
    if (existing) return;
    await this.sb.from("interactions").insert({
      from_user_id: fromUserId,
      to_user_id: toUserId,
      type: "wheel_connection",
    });
  }

  async hasWheelSpark(fromUserId: string, toUserId: string): Promise<boolean> {
    const { data } = await this.sb
      .from("interactions")
      .select("id")
      .eq("from_user_id", fromUserId)
      .eq("to_user_id", toUserId)
      .eq("type", "wheel_connection")
      .maybeSingle();
    return !!data;
  }

  async getIncomingWheelSparks(userId: string): Promise<(Interaction & { profile: Profile })[]> {
    const [myInteractionsResult, matchResult1, matchResult2, sparksResult] = await Promise.all([
      this.sb.from("interactions").select("to_user_id").eq("from_user_id", userId),
      this.sb.from("matches").select("user1_id").eq("user2_id", userId).eq("status", "active"),
      this.sb.from("matches").select("user2_id").eq("user1_id", userId).eq("status", "active"),
      this.sb
        .from("interactions")
        .select("id, type, from_user_id, to_user_id, created_at")
        .eq("to_user_id", userId)
        .eq("type", "wheel_connection")
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

    const excludeIds = new Set<string>([
      ...(myInteractionsResult.data || []).map((r: any) => r.to_user_id as string),
      ...(matchResult1.data || []).map((r: any) => r.user1_id as string),
      ...(matchResult2.data || []).map((r: any) => r.user2_id as string),
    ]);

    const incomingSparks = (sparksResult.data || []).filter(
      (o: any) => !excludeIds.has(o.from_user_id),
    );

    if (incomingSparks.length === 0) return [];

    const fromUserIds = incomingSparks.map((o: any) => o.from_user_id);
    const { data: profileRows } = await this.sb
      .from("profiles")
      .select(getMatchProfileCols())
      .in("user_id", fromUserIds);

    const profileMap = new Map<string, any>();
    for (const row of profileRows ?? []) {
      profileMap.set((row as any).user_id, row);
    }

    return incomingSparks
      .map((spark: any) => {
        const profileData = profileMap.get(spark.from_user_id);
        return profileData
          ? { ...mapInteraction(spark), profile: mapProfile(profileData) }
          : null;
      })
      .filter(Boolean) as (Interaction & { profile: Profile })[];
  }

  async acceptWheelSpark(fromUserId: string, toUserId: string): Promise<{ matchId: string }> {
    const { data: spark } = await this.sb
      .from("interactions")
      .select("id")
      .eq("from_user_id", fromUserId)
      .eq("to_user_id", toUserId)
      .eq("type", "wheel_connection")
      .maybeSingle();

    if (!spark) throw new Error("Spark not found");

    const existing = await this.findMatchBetweenUsers(fromUserId, toUserId);
    if (existing) {
      await this.sb
        .from("interactions")
        .delete()
        .eq("from_user_id", fromUserId)
        .eq("to_user_id", toUserId)
        .eq("type", "wheel_connection");
      return { matchId: existing.id };
    }

    const match = await this.createMatch(fromUserId, toUserId);

    await this.sb
      .from("interactions")
      .delete()
      .eq("from_user_id", fromUserId)
      .eq("to_user_id", toUserId)
      .eq("type", "wheel_connection");

    return { matchId: match.id };
  }

  async declineWheelSpark(fromUserId: string, toUserId: string): Promise<void> {
    await this.sb
      .from("interactions")
      .delete()
      .eq("from_user_id", fromUserId)
      .eq("to_user_id", toUserId)
      .eq("type", "wheel_connection");
  }

  async getDatePlanMessages(matchId: string): Promise<Message[]> {
    const MSG_COLS = "id, match_id, sender_id, content, reaction, created_at";
    const { data, error } = await this.sb
      .from("messages")
      .select(MSG_COLS)
      .eq("match_id", matchId)
      .like("content", "__DATE_%")
      .order("created_at", { ascending: true });
    if (error) throw new Error(`getDatePlanMessages: ${error.message}`);
    return (data ?? []).map(mapMessage);
  }

  async resetUserTestData(userId: string): Promise<void> {
    const { data: m1 } = await this.sb.from("matches").select("id").eq("user1_id", userId);
    const { data: m2 } = await this.sb.from("matches").select("id").eq("user2_id", userId);
    const matchIds = [...(m1 || []), ...(m2 || [])].map(r => r.id);

    if (matchIds.length > 0) {
      await this.sb.from("messages").delete().in("match_id", matchIds);
    }

    await this.sb.from("matches").delete().or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

    await this.sb.from("interactions").delete().or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);

    await this.sb.from("spin_standouts").delete().eq("user_id", userId);

    await this.sb.from("spin_usage").delete().eq("user_id", userId);

    await this.sb.from("spin_requests").delete().or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);
  }

  async addElevateCredits(userId: string, type: "elevate" | "super_elevate", quantity: number): Promise<void> {
    const isSuper = type === "super_elevate";
    const past = new Date(0);
    try {
      await db
        .insert(userElevates)
        .values({
          userId,
          elevateType: "elevate",
          expiresAt: past,
          elevateCredits: isSuper ? 0 : quantity,
          superElevateCredits: isSuper ? quantity : 0,
        })
        .onConflictDoUpdate({
          target: userElevates.userId,
          set: isSuper
            ? { superElevateCredits: sql`user_elevates.super_elevate_credits + ${quantity}` }
            : { elevateCredits: sql`user_elevates.elevate_credits + ${quantity}` },
        });
    } catch (err) {
      console.error("[ELEVATE] addElevateCredits failed:", err);
    }
  }

  async activateElevate(userId: string, type: "elevate" | "super_elevate"): Promise<{ success: boolean; error?: string }> {
    const isSuper = type === "super_elevate";
    const durationMs = isSuper ? 60 * 60 * 1000 : 30 * 60 * 1000;
    const expiresAt = new Date(Date.now() + durationMs);

    const rows = await db.select().from(userElevates).where(eq(userElevates.userId, userId));
    const row = rows[0];
    const credits = row ? (isSuper ? row.superElevateCredits : row.elevateCredits) : 0;

    if (credits <= 0) {
      return { success: false, error: "No credits available. Purchase a boost first." };
    }

    const activatedAt = new Date();
    try {
      await db
        .update(userElevates)
        .set(isSuper
          ? { elevateType: type, expiresAt, activatedAt, superElevateCredits: sql`GREATEST(super_elevate_credits - 1, 0)` }
          : { elevateType: type, expiresAt, activatedAt, elevateCredits: sql`GREATEST(elevate_credits - 1, 0)` }
        )
        .where(eq(userElevates.userId, userId));
    } catch (err) {
      console.error("[ELEVATE] activateElevate failed:", err);
      return { success: false, error: "Database error" };
    }

    return { success: true };
  }

  async getElevateStatus(userId: string): Promise<{ type: string | null; expiresAt: Date | null; active: boolean; elevateCredits: number; superElevateCredits: number }> {
    const now = new Date();
    const rows = await db.select().from(userElevates).where(eq(userElevates.userId, userId));
    if (rows.length === 0) return { type: null, expiresAt: null, active: false, elevateCredits: 0, superElevateCredits: 0 };
    const row = rows[0];
    const active = row.expiresAt > now;
    return {
      type: active ? row.elevateType : null,
      expiresAt: row.expiresAt,
      active,
      elevateCredits: row.elevateCredits,
      superElevateCredits: row.superElevateCredits,
    };
  }

  async getElevateSessionStats(userId: string): Promise<{ views: number; matches: number; startedAt: Date | null; active: boolean; expiresAt: Date | null }> {
    const now = new Date();
    const rows = await db.select().from(userElevates).where(eq(userElevates.userId, userId));
    if (rows.length === 0) return { views: 0, matches: 0, startedAt: null, active: false, expiresAt: null };
    const row = rows[0];
    const active = row.expiresAt > now;

    // Use activatedAt for accurate session window; fall back to (expiresAt - duration)
    let startedAt: Date;
    if (row.activatedAt) {
      startedAt = row.activatedAt;
    } else {
      const durationMs = row.elevateType === "super_elevate" ? 60 * 60 * 1000 : 30 * 60 * 1000;
      startedAt = new Date(row.expiresAt.getTime() - durationMs);
    }

    if (!active) {
      return { views: 0, matches: 0, startedAt, active: false, expiresAt: row.expiresAt };
    }

    const [viewsResult, matchesResult] = await Promise.all([
      this.sb
        .from("interactions")
        .select("id", { count: "exact", head: true })
        .eq("to_user_id", userId)
        .eq("type", "open")
        .gte("created_at", startedAt.toISOString()),
      this.sb
        .from("matches")
        .select("id", { count: "exact", head: true })
        .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
        .gte("created_at", startedAt.toISOString()),
    ]);

    return {
      views: viewsResult.count ?? 0,
      matches: matchesResult.count ?? 0,
      startedAt,
      active,
      expiresAt: row.expiresAt,
    };
  }

  // ── Call Credits (local Drizzle DB) ─────────────────────────────────────────

  async getCallCredits(userId: string): Promise<{ phoneCredits: number; videoCredits: number }> {
    const rows = await db.select().from(callCredits).where(eq(callCredits.userId, userId)).limit(1);
    if (!rows[0]) return { phoneCredits: 0, videoCredits: 0 };
    return { phoneCredits: rows[0].phoneCredits, videoCredits: rows[0].videoCredits };
  }

  async grantCallCredits(userId: string, phone: number, video: number): Promise<void> {
    await db
      .insert(callCredits)
      .values({ userId, phoneCredits: phone, videoCredits: video })
      .onConflictDoUpdate({
        target: callCredits.userId,
        set: {
          phoneCredits: sql`${callCredits.phoneCredits} + ${phone}`,
          videoCredits: sql`${callCredits.videoCredits} + ${video}`,
          updatedAt: sql`now()`,
        },
      });
  }

  async consumeCallCredit(userId: string, type: "phone" | "video"): Promise<boolean> {
    const credits = await this.getCallCredits(userId);
    if (type === "phone" && credits.phoneCredits <= 0) return false;
    if (type === "video" && credits.videoCredits <= 0) return false;
    await db
      .insert(callCredits)
      .values({ userId, phoneCredits: type === "phone" ? -1 : 0, videoCredits: type === "video" ? -1 : 0 })
      .onConflictDoUpdate({
        target: callCredits.userId,
        set: {
          phoneCredits: type === "phone"
            ? sql`GREATEST(${callCredits.phoneCredits} - 1, 0)`
            : callCredits.phoneCredits,
          videoCredits: type === "video"
            ? sql`GREATEST(${callCredits.videoCredits} - 1, 0)`
            : callCredits.videoCredits,
          updatedAt: sql`now()`,
        },
      });
    return true;
  }

  // ── Saved Wheel Profiles (local Drizzle DB) ──────────────────────────────────

  async getSavedWheelProfile(userId: string): Promise<SavedWheelProfile | null> {
    const rows = await db.select().from(savedWheelProfiles).where(eq(savedWheelProfiles.userId, userId)).limit(1);
    if (!rows[0]) return null;
    if (rows[0].expiresAt && rows[0].expiresAt < new Date()) {
      await db.delete(savedWheelProfiles).where(eq(savedWheelProfiles.userId, userId));
      return null;
    }
    return rows[0];
  }

  async saveWheelProfile(userId: string, savedProfileId: string): Promise<SavedWheelProfile> {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const rows = await db
      .insert(savedWheelProfiles)
      .values({ userId, savedProfileId, expiresAt })
      .onConflictDoUpdate({
        target: savedWheelProfiles.userId,
        set: { savedProfileId, savedAt: sql`now()`, expiresAt },
      })
      .returning();
    return rows[0];
  }

  async deleteSavedWheelProfile(userId: string): Promise<void> {
    await db.delete(savedWheelProfiles).where(eq(savedWheelProfiles.userId, userId));
  }

  // ── Discovery Undo (Supabase interactions) ──────────────────────────────────

  async getLastClose(userId: string): Promise<{ interactionId: string; toUserId: string } | null> {
    const { data, error } = await this.sb
      .from("interactions")
      .select("id, to_user_id")
      .eq("from_user_id", userId)
      .eq("type", "close")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    return { interactionId: data[0].id as string, toUserId: data[0].to_user_id as string };
  }

  async deleteLastClose(userId: string, interactionId: string): Promise<boolean> {
    // .select("id") causes Supabase to return the deleted rows.
    // Without it, data is null for both a successful delete AND a no-op delete
    // (row already gone), making it impossible to distinguish the two.
    const { data, error } = await this.sb
      .from("interactions")
      .delete()
      .eq("id", interactionId)
      .eq("from_user_id", userId)
      .select("id");
    if (error) return false;
    // Returns true ONLY if a row was actually removed.
    // Previously this returned !error, which is true even for a 0-row delete,
    // causing the caller to consume an undo credit when nothing was undone.
    return (data?.length ?? 0) > 0;
  }

  async getLastInteraction(userId: string): Promise<{ interactionId: string; toUserId: string; type: string } | null> {
    const { data, error } = await this.sb
      .from("interactions")
      .select("id, to_user_id, type")
      .eq("from_user_id", userId)
      .in("type", ["open", "close"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    return { interactionId: data[0].id as string, toUserId: data[0].to_user_id as string, type: data[0].type as string };
  }

  async getMatchBetweenUsers(userId: string, otherUserId: string): Promise<boolean> {
    const { data, error } = await this.sb
      .from("matches")
      .select("id")
      .or(`and(user1_id.eq.${userId},user2_id.eq.${otherUserId}),and(user1_id.eq.${otherUserId},user2_id.eq.${userId})`)
      .limit(1);
    if (error || !data) return false;
    return data.length > 0;
  }
}

export const storage = new SupabaseStorage();

// ── Blocked contacts helpers (local Drizzle DB) ───────────────────────────────
export async function getBlockedContactsForUser(userId: string): Promise<BlockedContact[]> {
  return db.select().from(blockedContacts).where(eq(blockedContacts.userId, userId));
}

export async function addBlockedContactForUser(
  userId: string,
  name: string,
  phoneNumber: string,
  email?: string,
): Promise<BlockedContact> {
  const [row] = await db
    .insert(blockedContacts)
    .values({ userId, name: name || "", phoneNumber: phoneNumber || "", email: email || null })
    .returning();
  return row;
}

export async function removeBlockedContactForUser(
  userId: string,
  contactId: string,
): Promise<void> {
  await db
    .delete(blockedContacts)
    .where(and(eq(blockedContacts.id, contactId), eq(blockedContacts.userId, userId)));
}

// ── Badge count helpers (local Drizzle DB) ────────────────────────────────────
// Tracks per-match unread counts for the iOS Home Screen badge.
// Server increments when a push is sent; client decrements when chat is opened.

/**
 * Increment the badge count for (userId, matchId) by 1.
 * Returns the new *total* unread count across all matches for this user.
 */
export async function incrementMatchBadge(userId: string, matchId: string): Promise<number> {
  await db.execute(sql`
    INSERT INTO user_match_badge_counts (user_id, match_id, count)
    VALUES (${userId}, ${matchId}, 1)
    ON CONFLICT (user_id, match_id) DO UPDATE
      SET count = user_match_badge_counts.count + 1
  `);
  return getTotalBadge(userId);
}

/**
 * Zero out the badge count for (userId, matchId) — user read this chat.
 * Returns the new *total* unread count across all remaining matches.
 */
export async function resetMatchBadge(userId: string, matchId: string): Promise<number> {
  await db.execute(sql`
    DELETE FROM user_match_badge_counts
    WHERE user_id = ${userId} AND match_id = ${matchId}
  `);
  return getTotalBadge(userId);
}

/**
 * Return the total unread count for a user across all matches.
 */
export async function getTotalBadge(userId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(count), 0)::int AS total
    FROM user_match_badge_counts
    WHERE user_id = ${userId}
  `);
  return (result.rows[0] as any)?.total ?? 0;
}

/**
 * Return per-match unread counts for a user — used to restore badge state after
 * an app restart.  Returns a Record<matchId, count> for all matches with count > 0.
 */
export async function getAllMatchBadgeCounts(userId: string): Promise<Record<string, number>> {
  const result = await db.execute(sql`
    SELECT match_id, count
    FROM user_match_badge_counts
    WHERE user_id = ${userId} AND count > 0
  `);
  const counts: Record<string, number> = {};
  for (const row of result.rows as any[]) {
    counts[String(row.match_id)] = Number(row.count);
  }
  return counts;
}
