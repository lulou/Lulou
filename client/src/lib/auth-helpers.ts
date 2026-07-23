/**
 * auth-helpers.ts
 *
 * Shared authentication helpers used by landing.tsx and App.tsx.
 *
 * SECURITY:
 *   getApprovedCallbackUrl() returns a FIXED application-controlled URL.
 *   It never reads from form input, request body, query parameters,
 *   Origin headers, or any user-controlled state.
 *
 *   The Supabase dashboard must have this URL in its "Allowed redirect URLs"
 *   allow-list — Supabase rejects redirects to unlisted hosts regardless.
 */

import { supabase } from "@/lib/supabase";

// ── Approved callback URL ─────────────────────────────────────────────────────
// Production: https://luloudating.com/auth/callback
// Development: the local dev server origin  (never user-supplied)
const PRODUCTION_CALLBACK = "https://luloudating.com/auth/callback";

export function getApprovedCallbackUrl(): string {
  if (import.meta.env.PROD) return PRODUCTION_CALLBACK;
  return `${window.location.origin}/auth/callback`;
}

// ── Resend verification email ─────────────────────────────────────────────────
// Calls supabase.auth.resend() with the fixed callback URL.
// Returns a normalised result the caller can act on without raw Supabase errors.

export type ResendResult =
  | { ok: true }
  | { ok: false; rateLimit: boolean; message: string };

export async function sendVerificationResend(email: string): Promise<ResendResult> {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: getApprovedCallbackUrl() },
  });

  if (!error) return { ok: true };

  const raw: string = error.message ?? "";
  const isRateLimit = /rate.?limit|too.?many|over_email/i.test(raw);

  const message = isRateLimit
    ? "We recently sent a verification email. Please check your inbox or try again shortly."
    : "We couldn't send the verification email right now. Please try again shortly.";

  return { ok: false, rateLimit: isRateLimit, message };
}
