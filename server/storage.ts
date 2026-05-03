import {
  type Profile, type InsertProfile,
  type Interaction, type InsertInteraction,
  type Match, type Message, type InsertMessage,
  type SpinRequest,
  userElevates,
} from "@shared/schema";
import { supabase as defaultSupabase } from "./supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "./db";
import { eq, gt, sql } from "drizzle-orm";

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
  getDiscoverProfiles(userId: string, gender: string, preference: string, ageMin?: number, ageMax?: number): Promise<Profile[]>;
  createInteraction(data: InsertInteraction): Promise<Interaction>;
  getInteraction(fromUserId: string, toUserId: string): Promise<Interaction | undefined>;
  getMutualOpen(user1Id: string, user2Id: string): Promise<boolean>;
  createMatch(user1Id: string, user2Id: string): Promise<Match>;
  getMatchesForUser(userId: string): Promise<(Match & { profile: Profile; lastMessage: { content: string; senderId: string; createdAt: Date | null } | null })[]>;
  getMatch(matchId: string, userId: string): Promise<(Match & { profile: Profile; messages: Message[] }) | undefined>;
  getMessagesPage(matchId: string, limit: number, before?: string): Promise<{ messages: Message[]; hasMore: boolean }>;
  createMessage(data: InsertMessage): Promise<Message>;
  getUserMessageCount(matchId: string, userId: string): Promise<number>;
  incrementMessageCount(matchId: string, userId: string): Promise<void>;
  startCall(matchId: string, userId: string): Promise<{ match: Match; status: "created" | "reused" | "blocked" } | undefined>;
  answerCall(matchId: string, userId: string): Promise<Match | undefined>;
  cancelCall(matchId: string, userId: string): Promise<Match | undefined>;
  completeCall(matchId: string, userId: string, options?: CompleteCallOptions): Promise<CompleteCallResult | undefined>;
  acceptFaceCall(matchId: string, userId: string): Promise<Match | undefined>;
  declineFaceCall(matchId: string, userId: string): Promise<Match | undefined>;
  getProfilePhotos(userId: string): Promise<string[]>;
  getPopularProfiles(limit?: number, preference?: string, gender?: string, userId?: string): Promise<Profile[]>;
  getSpinStandouts(userId: string): Promise<string[]>;
  addSpinStandout(userId: string, standoutUserId: string): Promise<void>;
  getSpinsToday(userId: string): Promise<number>;
  getSpinsThisWeek(userId: string): Promise<number>;
  recordSpin(userId: string): Promise<void>;
  getDailyLikeCount(userId: string): Promise<number>;
  getConsecutiveLikeDays(userId: string, goal: number): Promise<number>;
  hasUnusedStreakSpin(userId: string): Promise<boolean>;
  createSpinRequest(fromUserId: string, toUserId: string, message: string): Promise<SpinRequest>;
  getIncomingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]>;
  getOutgoingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]>;
  respondToSpinRequest(requestId: string, userId: string, accept: boolean): Promise<SpinRequest | undefined>;
  getSpinRequest(id: string): Promise<SpinRequest | undefined>;
  setMeetAvailability(matchId: string, userId: string, availability: string): Promise<Match | undefined>;
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
const MATCH_PROFILE_COLS = [
  "id", "user_id", "first_name", "age", "gender", "dating_preference",
  "location", "height", "signals", "dating_intent", "green_flags",
  "connection_style", "conversation_starters", "questions",
  "location_radius", "preferred_age_min", "preferred_age_max",
  "email", "phone_number", "photo_verified", "onboarding_complete", "created_at",
].join(", ");

// Profile columns for Likes page — same as MATCH_PROFILE_COLS but includes `photos`
// so the LikeCard and full-screen ProfileModal can show images.
// Excludes `elevate_type`/`elevate_expires_at` (not needed on Likes page).
const LIKES_PROFILE_COLS = [
  "id", "user_id", "first_name", "age", "gender", "dating_preference",
  "location", "height", "photos", "signals", "dating_intent", "green_flags",
  "connection_style", "conversation_starters", "questions",
  "location_radius", "preferred_age_min", "preferred_age_max",
  "email", "phone_number", "photo_verified", "onboarding_complete", "created_at",
].join(", ");

function mapProfile(row: any): Profile {
  return {
    id: row.id,
    userId: row.user_id,
    firstName: row.first_name,
    age: row.age,
    gender: row.gender,
    datingPreference: row.dating_preference,
    location: row.location,
    height: row.height,
    photos: filterPhotos(row.photos),
    signals: row.signals,
    datingIntent: row.dating_intent,
    greenFlags: row.green_flags,
    connectionStyle: row.connection_style,
    conversationStarters: row.conversation_starters,
    questions: row.questions,
    locationRadius: row.location_radius,
    preferredAgeMin: row.preferred_age_min,
    preferredAgeMax: row.preferred_age_max,
    email: row.email,
    phoneNumber: row.phone_number,
    photoVerified: row.photo_verified,
    onboardingComplete: row.onboarding_complete,
    elevateType: row.elevate_type ?? null,
    elevateExpiresAt: row.elevate_expires_at ? new Date(row.elevate_expires_at) : null,
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
    numberExchanged1: row.number_exchanged_1,
    numberExchanged2: row.number_exchanged_2,
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

function profileToDbRow(data: Partial<InsertProfile>): Record<string, any> {
  const row: Record<string, any> = {};
  if (data.userId !== undefined) row.user_id = data.userId;
  if (data.firstName !== undefined) row.first_name = data.firstName;
  if (data.age !== undefined) row.age = data.age;
  if (data.gender !== undefined) row.gender = data.gender;
  if (data.datingPreference !== undefined) row.dating_preference = data.datingPreference;
  if (data.location !== undefined) row.location = data.location;
  if (data.height !== undefined) row.height = data.height;
  if (data.photos !== undefined) row.photos = data.photos;
  if (data.signals !== undefined) row.signals = data.signals;
  if (data.datingIntent !== undefined) row.dating_intent = data.datingIntent;
  if (data.greenFlags !== undefined) row.green_flags = data.greenFlags;
  if (data.connectionStyle !== undefined) row.connection_style = data.connectionStyle;
  if (data.conversationStarters !== undefined) row.conversation_starters = data.conversationStarters;
  if (data.questions !== undefined) row.questions = data.questions;
  if (data.locationRadius !== undefined) row.location_radius = data.locationRadius;
  if (data.preferredAgeMin !== undefined) row.preferred_age_min = data.preferredAgeMin;
  if (data.preferredAgeMax !== undefined) row.preferred_age_max = data.preferredAgeMax;
  if (data.email !== undefined) row.email = data.email;
  if (data.phoneNumber !== undefined) row.phone_number = data.phoneNumber;
  if (data.photoVerified !== undefined) row.photo_verified = data.photoVerified;
  if (data.onboardingComplete !== undefined) row.onboarding_complete = data.onboardingComplete;
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
      .select(MATCH_PROFILE_COLS)
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

  async getDiscoverProfiles(userId: string, gender: string, preference: string, ageMin: number = 18, ageMax: number = 99): Promise<Profile[]> {
    const isDev = process.env.NODE_ENV === "development";

    // Select all columns EXCEPT photos — base64 images in photos make rows huge (100s KB each).
    // Fetching photos for 100 profiles at once transfers 50–100 MB and causes a statement timeout.
    // Photos are fetched individually per-card by the client via GET /api/profiles/:userId.
    const POOL_COLS = [
      "id", "user_id", "first_name", "age", "gender", "dating_preference",
      "location", "height", "signals", "dating_intent", "green_flags",
      "connection_style", "conversation_starters", "questions",
      "location_radius", "preferred_age_min", "preferred_age_max",
      "email", "phone_number", "photo_verified", "onboarding_complete", "created_at",
    ].join(", ");

    // Base query: exclude own profile, require onboarding complete
    let profilesQuery = this.sb
      .from("profiles")
      .select(POOL_COLS)
      .neq("user_id", userId)
      .eq("onboarding_complete", true);

    // ── Mutual-compatibility filters ────────────────────────────────────────
    // Both conditions must hold:
    //   1. candidate.gender matches what the current user wants to see
    //   2. candidate.dating_preference includes the current user's gender
    // This ensures discovery is reciprocal — neither party wastes a slot
    // on someone who wouldn't be interested in them.

    const normGender = normalizeGender(gender);
    const normPref   = normalizeDatingPreference(preference);

    // 1. Filter by what the current user wants to see (their preference → target gender)
    const targetGenders = getGendersForPreference(normPref);
    if (targetGenders && targetGenders.length > 0) {
      profilesQuery = profilesQuery.in("gender", targetGenders);
    }

    // 2. Mutual filter: candidate must also be interested in the current user's gender
    const candidateMustPrefer = getPreferencesThatIncludeGender(normGender);
    if (candidateMustPrefer.length > 0) {
      profilesQuery = profilesQuery.in("dating_preference", candidateMustPrefer);
    }

    // Age filter: only apply when the user has explicitly narrowed the range.
    // Use very wide defaults (18-99) so new users with no preference set see everyone.
    const effectiveAgeMin = Math.max(18, ageMin);
    const effectiveAgeMax = Math.min(99, ageMax);
    const hasNarrowAgeRange = effectiveAgeMin > 18 || effectiveAgeMax < 99;
    if (!isDev && hasNarrowAgeRange) {
      profilesQuery = profilesQuery.gte("age", effectiveAgeMin).lte("age", effectiveAgeMax);
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
    // Run all three queries in parallel — elevates used to be sequential after profiles/interactions
    const [interactedResult, profilesResult, elevates] = await Promise.all([
      this.sb.from("interactions").select("to_user_id").eq("from_user_id", userId),
      profilesQuery.limit(100),
      getActiveElevatesMap(),
    ]);
    if (IS_DEV) console.log(`[DISCOVER] parallel queries done in ${Date.now() - t1} ms`);

    if (interactedResult.error) {
      console.error("[DISCOVER] interactions fetch error:", interactedResult.error.message);
    }
    if (profilesResult.error) {
      console.error("[DISCOVER] profiles fetch error:", profilesResult.error.message, profilesResult.error.code);
      return [];
    }

    const interactedIds = new Set<string>(
      (interactedResult.data || []).map((r: any) => r.to_user_id).filter(Boolean)
    );

    const now = new Date();
    const all = (profilesResult.data || []).map(mapProfile);
    // Exclude only profiles the user has already interacted with (skipped/opened).
    // Own profile is already excluded by the .neq("user_id", userId) DB filter.
    const baseFiltered = all.filter(p => {
      if (interactedIds.has(p.userId)) {
        if (IS_DEV) console.log(`[DISCOVER] EXCLUDED userId=${p.userId} (${p.firstName}) — already interacted`);
        return false;
      }
      return true;
    });

    const filtered = mergeElevatesIntoProfiles(baseFiltered, elevates);

    if (IS_DEV) {
      const superCount = filtered.filter(p => p.elevateType === "super_elevate" && p.elevateExpiresAt && p.elevateExpiresAt > now).length;
      const elevCount  = filtered.filter(p => p.elevateType === "elevate" && p.elevateExpiresAt && p.elevateExpiresAt > now).length;
      console.log(
        "[DISCOVER] DB pool:", all.length,
        "| after interaction exclusion:", baseFiltered.length,
        "| after elevate merge:", filtered.length,
        "| super:", superCount, "elevate:", elevCount,
        "| interactedIds count:", interactedIds.size,
      );
    }

    // Fallback tier 1: both mutual filters applied but pool is still empty.
    // Relax the mutual filter and try again with ONLY the gender-preference filter
    // (candidate.gender matches what user wants) so the discover screen is never
    // completely blank on a small user base.  The mutual filter remains the primary
    // path — this only kicks in when there are genuinely no mutually-compatible profiles.
    if (filtered.length === 0) {
      console.log("[DISCOVER] Mutual-compat pool empty — relaxing to gender-only filter for fallback");
      let fallbackQuery = this.sb
        .from("profiles")
        .select(POOL_COLS)
        .neq("user_id", userId)
        .eq("onboarding_complete", true)
        .limit(100);

      if (targetGenders && targetGenders.length > 0) {
        fallbackQuery = fallbackQuery.in("gender", targetGenders);
      }

      const { data: fallbackData, error: fallbackErr } = await fallbackQuery;
      if (!fallbackErr && fallbackData && fallbackData.length > 0) {
        const fallbackAll = fallbackData.map(mapProfile);
        const fallbackFiltered = fallbackAll.filter(p => !interactedIds.has(p.userId));
        const fallbackWithElevates = mergeElevatesIntoProfiles(fallbackFiltered, elevates);
        if (IS_DEV) console.log("[DISCOVER] Gender-only fallback pool:", fallbackWithElevates.length, "profiles");
        return weightedSample(fallbackWithElevates, 20, now);
      }
    }

    return weightedSample(filtered, 20, now);
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
        .select(MATCH_PROFILE_COLS)
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
      profileByUserId.set(p.user_id, p);
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
    const MATCH_COLS = "id,user1_id,user2_id,message_count_1,message_count_2,call_completed,call_started_at,call_answered,call_initiator_id,call_stage,face_call_user1_accepted,face_call_user2_accepted,meet_availability_1,meet_availability_2,number_exchanged_1,number_exchanged_2,status,created_at";
    const { data: matchData, error } = await this.sb
      .from("matches")
      .select(MATCH_COLS)
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
      this.sb.from("profiles").select(MATCH_PROFILE_COLS).eq("user_id", otherUserId).maybeSingle(),
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
  } | null> {
    const { data, error } = await this.sb
      .from("matches")
      .select("id, user1_id, user2_id, call_stage, message_count_1, message_count_2")
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
    const { count, error } = await this.sb
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("match_id", matchId)
      .eq("sender_id", userId);
    return count || 0;
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

  async startCall(matchId: string, userId: string): Promise<{ match: Match; status: "created" | "reused" | "blocked" } | undefined> {
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
    const stage = match.callStage || 0;
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

  async getPopularProfiles(limit: number = 10, preference?: string, gender?: string, userId?: string): Promise<Profile[]> {
    // Photos excluded from this query — same reasoning as getDiscoverProfiles.
    // Intent page lazy-loads photos per wheel item via GET /api/profiles/:userId/photos.
    const WHEEL_COLS = [
      "id", "user_id", "first_name", "age", "gender", "dating_preference",
      "location", "height", "signals", "dating_intent", "green_flags",
      "connection_style", "conversation_starters", "questions",
      "location_radius", "preferred_age_min", "preferred_age_max",
      "email", "phone_number", "photo_verified", "onboarding_complete", "created_at",
    ].join(", ");

    // Pre-compute mutual-compat filter values (same logic as getDiscoverProfiles)
    const normGender = normalizeGender(gender);
    const normPref   = normalizeDatingPreference(preference);
    const targetGenders       = getGendersForPreference(normPref);
    const candidateMustPrefer = gender ? getPreferencesThatIncludeGender(normGender) : [];

    console.log("[WHEEL] mutual-compat filters:", {
      userId: userId ?? "(none)",
      myGender: gender ?? "(none)",
      myGenderNorm: normGender,
      myPreference: preference ?? "(none)",
      myPrefNorm: normPref,
      targetGenders: targetGenders ?? "all",
      candidateMustPrefer: candidateMustPrefer.length ? candidateMustPrefer : "any",
    });

    // Helper: apply both mutual-compat filters to a Supabase query builder
    const applyFilters = (q: any): any => {
      if (targetGenders && targetGenders.length > 0) q = q.in("gender", targetGenders);
      if (candidateMustPrefer.length > 0) q = q.in("dating_preference", candidateMustPrefer);
      return q;
    };

    // Run user's-own-interactions and global popularity interactions in parallel.
    // Previously sequential: first user interactions, then popularity count — this adds ~200ms.
    const twPopT0 = Date.now();
    const [userInteractedResult, popularRowsResult] = await Promise.all([
      userId
        ? this.sb.from("interactions").select("to_user_id").eq("from_user_id", userId)
        : Promise.resolve({ data: [] as { to_user_id: string }[], error: null }),
      this.sb.from("interactions").select("to_user_id").eq("type", "open").limit(2000),
    ]);
    console.log(`[WHEEL] parallel interaction queries done in ${Date.now() - twPopT0} ms`);

    let interactedIds = new Set<string>();
    if (userInteractedResult.error) {
      console.error("[WHEEL] interactions fetch error:", (userInteractedResult as any).error?.message);
    } else {
      interactedIds = new Set((userInteractedResult.data || []).map((r: any) => r.to_user_id).filter(Boolean));
      console.log("[WHEEL] interacted profile count:", interactedIds.size);
    }

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
      let query = this.sb
        .from("profiles")
        .select(WHEEL_COLS)
        .eq("onboarding_complete", true)
        .in("user_id", sortedIds);

      // Apply mutual-compatibility filters (both gender + preference)
      query = applyFilters(query);

      const { data, error } = await query;
      if (error) console.error("[WHEEL] popular query error:", error.message);
      allProfiles = (data || []).map(mapProfile);

      const orderMap = new Map(sortedIds.map((id, i) => [id, i]));
      allProfiles.sort((a, b) => (orderMap.get(a.userId) ?? 99) - (orderMap.get(b.userId) ?? 99));
    }

    // Fill remaining slots from any eligible profile (most recently joined first).
    // Fetch limit*3 to ensure enough remain after interaction filtering below.
    if (allProfiles.length < limit) {
      const existingIds = allProfiles.map(r => r.userId);
      let query = this.sb
        .from("profiles")
        .select(WHEEL_COLS)
        .eq("onboarding_complete", true)
        .order("created_at", { ascending: false })
        .limit(limit * 3);

      if (existingIds.length > 0) {
        query = query.not("user_id", "in", `(${existingIds.join(",")})`);
      }

      // Apply mutual-compatibility filters (both gender + preference)
      query = applyFilters(query);

      const { data: extra, error: fallbackError } = await query;
      if (fallbackError) console.error("[WHEEL] fallback query error:", fallbackError.message);
      allProfiles.push(...(extra || []).map(mapProfile));
    }

    console.log("[WHEEL] total profiles before interaction filter:", allProfiles.length, "| preference:", preference ?? "any", "| gender:", gender ?? "any");

    // Exclude profiles the current user has already interacted with.
    // This makes the wheel consistent with Discover — the user won't see people
    // they've already liked or closed anywhere else in the app.
    if (userId && interactedIds.size > 0) {
      const beforeCount = allProfiles.length;
      allProfiles = allProfiles.filter(p => {
        if (interactedIds.has(p.userId)) {
          console.log(`[WHEEL] EXCLUDED userId=${p.userId} (${p.firstName}) — already interacted`);
          return false;
        }
        return true;
      });
      console.log(`[WHEEL] after interaction exclusion: ${allProfiles.length} (removed ${beforeCount - allProfiles.length})`);
    }

    // If still empty after interaction filter, show anyone with onboarding complete (no gender filter).
    // This last-resort fallback shows any uninteracted user to prevent a completely empty wheel.
    if (allProfiles.length === 0) {
      console.log("[WHEEL] no profiles after all filters — falling back to any non-interacted completed profile");
      const { data: fallback } = await this.sb
        .from("profiles")
        .select(WHEEL_COLS)
        .eq("onboarding_complete", true)
        .order("created_at", { ascending: false })
        .limit(limit * 3);
      const fallbackMapped = (fallback || []).map(mapProfile).filter(p =>
        p.userId !== userId && !interactedIds.has(p.userId)
      );
      allProfiles = fallbackMapped;
      console.log("[WHEEL] fallback pool after interaction filter:", allProfiles.length);
    }

    // Merge live elevate status from local DB, then weighted sample
    const elevates = await getActiveElevatesMap();
    const now = new Date();
    const elevatedProfiles = mergeElevatesIntoProfiles(allProfiles, elevates);
    console.log("[WHEEL] final pool returned:", elevatedProfiles.length);
    return weightedSample(elevatedProfiles, elevatedProfiles.length, now);
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
      .select(MATCH_PROFILE_COLS)
      .in("user_id", fromIds);

    const profileMap = new Map<string, any>((profileRows ?? []).map(p => [p.user_id, p]));
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
      .select(MATCH_PROFILE_COLS)
      .in("user_id", toIds);

    const profileMap = new Map<string, any>((profileRows ?? []).map(p => [p.user_id, p]));
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

  async setMeetAvailability(matchId: string, userId: string, availability: string): Promise<Match | undefined> {
    const { data: matchData } = await this.sb
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) < 4) return undefined;

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
    if ((match.callStage || 0) < 4) return undefined;
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
    const t0 = Date.now();
    // Run all pre-filter queries in parallel
    const [interactedResult, matchResult1, matchResult2] = await Promise.all([
      this.sb.from("interactions").select("to_user_id").eq("from_user_id", userId),
      this.sb.from("matches").select("user1_id").eq("user2_id", userId).eq("status", "active"),
      this.sb.from("matches").select("user2_id").eq("user1_id", userId).eq("status", "active"),
    ]);
    console.log(`[LIKES] pre_filter_parallel: ${Date.now() - t0} ms`);

    const interactedBackIds = (interactedResult.data || []).map((r: any) => r.to_user_id);
    const matchedIds = [
      ...(matchResult1.data || []).map((r: any) => r.user1_id),
      ...(matchResult2.data || []).map((r: any) => r.user2_id),
    ];

    const excludeIds = [...new Set([...interactedBackIds, ...matchedIds])];

    let query = this.sb
      .from("interactions")
      .select("id, type, from_user_id, to_user_id, created_at")
      .eq("to_user_id", userId)
      .eq("type", "open")
      .order("created_at", { ascending: false })
      .limit(50);

    if (excludeIds.length > 0) {
      query = query.not("from_user_id", "in", `(${excludeIds.join(",")})`);
    }

    const t1 = Date.now();
    const { data: incomingOpens } = await query;
    console.log(`[LIKES] incoming_opens_query: ${Date.now() - t1} ms | found: ${incomingOpens?.length ?? 0}`);
    if (!incomingOpens || incomingOpens.length === 0) return [];

    // Batch-fetch profiles — photos are stripped here (MATCH_PROFILE_COLS) and
    // lazy-loaded per card via GET /api/profiles/:userId/photos so that one
    // /api/who-liked-you call never carries 50 × 150 KB of base64 image strings.
    const fromUserIds = incomingOpens.map((o: any) => o.from_user_id);
    const t2 = Date.now();
    const { data: profileRows } = await this.sb
      .from("profiles")
      .select(MATCH_PROFILE_COLS)
      .in("user_id", fromUserIds);
    console.log(`[LIKES] profiles_batch: ${Date.now() - t2} ms | profiles: ${profileRows?.length ?? 0} | total: ${Date.now() - t0} ms`);

    const profileMap = new Map<string, any>();
    for (const row of profileRows ?? []) {
      profileMap.set(row.user_id, row);
    }

    return incomingOpens
      .map((open: any) => {
        const profileData = profileMap.get(open.from_user_id);
        return profileData ? { ...mapInteraction(open), profile: mapProfile(profileData) } : null;
      })
      .filter(Boolean) as (Interaction & { profile: Profile })[];
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
          ? { elevateType: type, expiresAt, activatedAt, superElevateCredits: sql`super_elevate_credits - 1` }
          : { elevateType: type, expiresAt, activatedAt, elevateCredits: sql`elevate_credits - 1` }
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
}

export const storage = new SupabaseStorage();
