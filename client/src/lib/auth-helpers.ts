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
// Production: https://www.luloudating.com/auth/callback
// Development: the local dev server origin  (never user-supplied)
const PRODUCTION_CALLBACK = "https://www.luloudating.com/auth/callback";

export function getApprovedCallbackUrl(): string {
  if (import.meta.env.PROD) return PRODUCTION_CALLBACK;
  return `${window.location.origin}/auth/callback`;
}

// ── Resend verification email ─────────────────────────────────────────────────
// Calls supabase.auth.resend() with the fixed callback URL.
// Returns a normalised result the caller can act on without raw Supabase errors.

export type VerificationDeliveryFailureKind =
  | "rate_limited"
  | "smtp_failure"
  | "invalid_email"
  | "auth_user_creation_failure"
  | "confirmation_send_failure"
  | "redirect_configuration"
  | "provider_error"
  | "unknown";

export interface VerificationDeliveryFailure {
  kind: VerificationDeliveryFailureKind;
  status: number | null;
  code: string | null;
  safeDetail: string;
  userMessage: string;
}

type VerificationDeliveryPhase = "signup" | "resend";

function safeErrorDetail(error: unknown): string {
  const raw = String((error as any)?.message ?? "No error detail returned");
  return raw
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[token redacted]")
    .replace(/([?&](?:token|token_hash|access_token|refresh_token|code)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 300);
}

export function classifyVerificationDeliveryError(
  error: unknown,
  phase: VerificationDeliveryPhase,
): VerificationDeliveryFailure {
  const rawCode = String((error as any)?.code ?? (error as any)?.error_code ?? "");
  const code = rawCode.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || null;
  const rawStatus = Number((error as any)?.status);
  const status = Number.isFinite(rawStatus) ? rawStatus : null;
  const safeDetail = safeErrorDetail(error);
  const searchable = `${code ?? ""} ${safeDetail}`.toLowerCase();

  let kind: VerificationDeliveryFailureKind;
  if (
    status === 429 ||
    /rate.?limit|too.?many|over_email_send_rate_limit|email_send_rate/.test(searchable)
  ) {
    kind = "rate_limited";
  } else if (
    /invalid.?email|email_address_invalid|unable to validate email|malformed email/.test(searchable)
  ) {
    kind = "invalid_email";
  } else if (
    /redirect|redirect_to|site.?url|uri.?allow|not.?allowed.?url/.test(searchable)
  ) {
    kind = "redirect_configuration";
  } else if (
    phase === "signup" &&
    /database error saving new user|user.?creation|failed to create user|signup disabled/.test(searchable)
  ) {
    kind = "auth_user_creation_failure";
  } else if (
    /smtp|mail.?server|mailer|sender|from.?address|resend|email.?provider/.test(searchable)
  ) {
    kind = "smtp_failure";
  } else if (
    phase === "resend" &&
    (/confirmation|verification|send.?email/.test(searchable) || status === 400 || status === 422)
  ) {
    kind = "confirmation_send_failure";
  } else if (
    (status !== null && status >= 500) ||
    /provider|upstream|service unavailable|bad gateway|gateway timeout/.test(searchable)
  ) {
    kind = "provider_error";
  } else {
    kind = "unknown";
  }

  const userMessages: Record<VerificationDeliveryFailureKind, string> = {
    rate_limited: "We recently sent a verification email. Please check your inbox or wait before trying again.",
    smtp_failure: "The email provider could not send the verification email. Please try again shortly.",
    invalid_email: "This email address could not receive a verification email. Check it and try again.",
    auth_user_creation_failure: "Your account could not be created. Please try signing up again.",
    confirmation_send_failure: "Supabase could not send the confirmation email. Please try again shortly.",
    redirect_configuration: "The verification link configuration is invalid. Please contact support.",
    provider_error: "The email service is temporarily unavailable. Please try again shortly.",
    unknown: "We couldn't send the verification email right now. Please try again shortly.",
  };

  return { kind, status, code, safeDetail, userMessage: userMessages[kind] };
}

export type ResendResult =
  | { ok: true }
  | {
      ok: false;
      rateLimit: boolean;
      message: string;
      failure: VerificationDeliveryFailure;
    };

export async function sendVerificationResend(email: string): Promise<ResendResult> {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: getApprovedCallbackUrl() },
  });

  if (!error) return { ok: true };

  const failure = classifyVerificationDeliveryError(error, "resend");

  return {
    ok: false,
    rateLimit: failure.kind === "rate_limited",
    message: failure.userMessage,
    failure,
  };
}
