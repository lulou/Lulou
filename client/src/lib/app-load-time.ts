/**
 * Captured once at module load — before React, before Supabase, before any
 * component mounts. Used to distinguish calls that started before the current
 * browser session (stale DB state) from calls that are genuinely new.
 *
 * Exported as a shared constant so both App.tsx and use-call-signaling.ts
 * reference the same timestamp, avoiding two separate Date.now() captures that
 * could differ by several milliseconds.
 */
export const APP_LOAD_TIME = Date.now();

/**
 * Hard startup audio suppression window.
 *
 * No ringtone or ringback may play for the first 5 seconds after the module
 * loads.  This eliminates a class of race conditions where:
 *   - cached /api/matches data arrives before the network response,
 *   - the startup sweep marks itself complete too early,
 *   - a stale call:ring rering arms a session and writes callStartedAt=NOW
 *     via the optimistic patch, bypassing the APP_LOAD_TIME guard, and
 *   - the ring fires on the user's first gesture through the audio warm-up path.
 *
 * After STARTUP_SILENCE_UNTIL has passed, only rerings that arrived after
 * APP_LOAD_TIME (and survived all other guards) can start audio.
 *
 * Callers that start a call MANUALLY (startCall mutation success) bypass this
 * window via the armed-session + sweep guards already in place — they arm the
 * session themselves from within the gesture context and do not go through the
 * suppression path.
 */
export const STARTUP_SILENCE_UNTIL = APP_LOAD_TIME + 5_000;
