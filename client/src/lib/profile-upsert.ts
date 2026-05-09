import { supabase } from "./supabase";
import { API_BASE } from "./queryClient";

const FIELD_MAP: Record<string, string> = {
  firstName: "first_name",
  age: "age",
  gender: "gender",
  datingPreference: "dating_preference",
  location: "location",
  height: "height",
  photos: "photos",
  signals: "signals",
  datingIntent: "dating_intent",
  greenFlags: "green_flags",
  connectionStyle: "connection_style",
  conversationStarters: "conversation_starters",
  questions: "questions",
  locationRadius: "location_radius",
  preferredAgeMin: "preferred_age_min",
  preferredAgeMax: "preferred_age_max",
  email: "email",
  phoneNumber: "phone_number",
  photoVerified: "photo_verified",
  onboardingComplete: "onboarding_complete",
};

function toDbFields(fields: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const dbKey = FIELD_MAP[key];
    if (dbKey) row[dbKey] = value;
  }
  return row;
}

// ── Error sanitisation ────────────────────────────────────────────────────────

/** Strip HTML tags and HTML entities so raw CDN/Cloudflare 520 pages are never shown. */
function stripHtml(msg: string): string {
  return msg
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Returns a clean, user-friendly error string safe to show in the UI.
 *
 * Strips HTML tags (Cloudflare/CDN 520 error pages) and replaces 5xx status
 * prefixes with a generic "try again" message so users never see raw server
 * internals or HTML in a toast notification.
 */
export function cleanErrorMessage(err: unknown): string {
  const raw: string = (err as any)?.message ?? String(err ?? "");
  if (!raw) return "Profile couldn't be saved right now. Please try again.";
  const stripped = stripHtml(raw);
  // Generic user-facing message for any 5xx / network-layer error.
  if (/^5\d\d[: ]/.test(stripped) || /\b(520|502|503|504)\b/.test(stripped)) {
    return "Profile couldn't be saved right now. Please try again.";
  }
  return stripped || "Profile couldn't be saved right now. Please try again.";
}

// ── Retry logic ───────────────────────────────────────────────────────────────

/**
 * Returns true for transient errors that are safe to retry:
 *   - TypeError from fetch() — network unreachable, DNS failure, CORS
 *   - Messages that contain a 5xx status code (including Cloudflare 520)
 *   - "network", "timeout", "connection", "failed to fetch" keywords
 *
 * Returns false for 4xx errors (validation, auth) — those should never retry.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const msg: string = ((err as any)?.message ?? "").toLowerCase();
  if (/^4\d\d[: ]/.test(msg)) return false;
  return /\b(520|5\d\d|network|timeout|connection|failed to fetch)\b/.test(msg);
}

// Two retries: 1 s then 2 s before giving up (covers transient Cloudflare blips).
const RETRY_DELAYS_MS = [1_000, 2_000] as const;

/**
 * Run `fn` up to (1 + RETRY_DELAYS_MS.length) times, retrying only on
 * transient errors.  Non-retryable errors (4xx, session errors) are re-thrown
 * immediately without waiting.
 */
export async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      console.warn("[PROFILE_SAVE] RETRY", {
        attempt,
        maxRetries: RETRY_DELAYS_MS.length,
        label,
        delayMs: delay,
      });
      await new Promise<void>(resolve => setTimeout(resolve, delay));
    }
    try {
      const result = await fn();
      if (attempt > 0) {
        console.log("[PROFILE_SAVE] RETRY_SUCCESS", { attempt, label });
      }
      return result;
    } catch (err: unknown) {
      lastErr = err;
      const canRetry = attempt < RETRY_DELAYS_MS.length && isRetryable(err);
      console.warn("[PROFILE_SAVE] ATTEMPT_FAILED", {
        attempt: attempt + 1,
        label,
        willRetry: canRetry,
        rawError: (err as any)?.message,
      });
      if (!canRetry) break;
    }
  }
  throw lastErr;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upsert the current user's profile row in Supabase.
 *
 * Automatically retries up to 2 times on transient network/5xx errors (1 s + 2 s
 * backoff).  Throws with a clean, HTML-free message on final failure so callers
 * can safely display it in a toast without sanitising the string themselves.
 */
export async function upsertProfile(fields: Record<string, unknown>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Session expired. Please sign in again.");
  }

  const dbFields = toDbFields(fields);
  const payload = { ...dbFields, user_id: user.id };
  const fieldKeys = Object.keys(dbFields);

  console.log("[PROFILE_SAVE] START", { userId: user.id, fieldKeys });

  try {
    const result = await withRetry(async () => {
      const { data, error } = await supabase
        .from("profiles")
        .upsert(payload, { onConflict: "user_id" })
        .select()
        .single();

      if (error) {
        // Wrap as a standard Error so isRetryable() can inspect the message.
        throw new Error(error.message ?? "Supabase upsert failed");
      }
      return data;
    }, `upsertProfile(${fieldKeys.join(",")})`);

    console.log("[PROFILE_SAVE] SUCCESS", { userId: user.id, fieldKeys });
    return result;
  } catch (err: unknown) {
    const reason = cleanErrorMessage(err);
    const httpStatus = /^(\d{3})[: ]/.exec((err as any)?.message ?? "")?.[1] ?? null;
    console.error("[PROFILE_SAVE] FAILURE", {
      userId: user.id,
      fieldKeys,
      httpStatus,
      rawError: (err as any)?.message,
      cleanedError: reason,
    });
    // Rethrow with a sanitised message so every onError handler downstream
    // can safely pass `err.message` straight to a toast.
    throw new Error(reason);
  }
}

export async function initProfileOnLogin(accessToken: string) {
  const { data: { user }, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !user) {
    console.warn("PROFILE_INIT_SKIPPED: getUser() returned no valid user", userError?.message);
    return;
  }

  console.log("PROFILE_INIT_CALLING_SERVER for user:", user.id);

  const { requireApiBase } = await import("./queryClient");
  requireApiBase("/api/auth/init");

  const res = await fetch(API_BASE + "/api/auth/init", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    credentials: "include",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let msg = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.message) msg = parsed.message;
    } catch {}
    console.error("PROFILE_INIT_SERVER_ERROR", res.status, msg);
    throw new Error(msg);
  }

  console.log("PROFILE_INIT_SERVER_SUCCESS for user:", user.id);
}
