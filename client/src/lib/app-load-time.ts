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
