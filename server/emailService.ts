/**
 * emailService.ts
 *
 * Thin wrapper around Resend for all Lulou transactional emails.
 *
 * Behaviour:
 *   • Gracefully no-ops when RESEND_API_KEY is absent (logs a warning, never throws).
 *   • Retries up to MAX_RETRIES times with exponential back-off on transient errors.
 *   • Appends every send attempt to a capped in-memory ring buffer for admin diagnostics.
 *   • Every sent email is also logged to stdout so server logs provide a complete audit trail.
 */

import { Resend } from "resend";

// ── Configuration ─────────────────────────────────────────────────────────────

const RESEND_API_KEY   = process.env.RESEND_API_KEY ?? "";
const FROM_NAME        = process.env.EMAIL_FROM_NAME ?? "Lulou";
const FROM_ADDRESS     = process.env.EMAIL_FROM_ADDRESS ?? "support@lulou.app";
export const FROM      = `${FROM_NAME} <${FROM_ADDRESS}>`;
const MAX_RETRIES      = 3;
const RETRY_BASE_MS    = 800;
const EMAIL_LOG_MAX    = 200;

// Startup check — logged once at module load so Railway/Railway logs confirm
// whether the key is present before the first email is attempted.
if (RESEND_API_KEY) {
  console.log(`[EMAIL] Resend configured — FROM="${FROM}" key present`);
} else {
  console.error(
    '[EMAIL] CRITICAL: RESEND_API_KEY is not set. ' +
    'ALL transactional emails (including refund confirmations) will be silently skipped. ' +
    'Set RESEND_API_KEY in Railway environment variables to enable email delivery.'
  );
}

// ── In-memory audit log ───────────────────────────────────────────────────────

export interface EmailLogEntry {
  ts:       string;
  to:       string;
  subject:  string;
  type:     string;
  success:  boolean;
  msgId?:   string;
  error?:   string;
  attempts: number;
}

const _log: EmailLogEntry[] = [];

export function getEmailLog(): EmailLogEntry[] {
  return [..._log].reverse();
}

function _appendLog(entry: EmailLogEntry) {
  _log.push(entry);
  if (_log.length > EMAIL_LOG_MAX) _log.shift();
}

// ── Resend client (lazy, singleton) ──────────────────────────────────────────

let _client: Resend | null = null;

function getClient(): Resend | null {
  if (!RESEND_API_KEY) return null;
  if (!_client) _client = new Resend(RESEND_API_KEY);
  return _client;
}

// ── Core send function ────────────────────────────────────────────────────────

export interface SendEmailOpts {
  to:      string;
  subject: string;
  html:    string;
  type:    string;
  from?:   string;
  replyTo?: string;
  onFailure?: (failure: EmailFailure) => void;
}

export interface EmailFailure {
  category: string;
  providerHttpStatus?: number;
}

export async function sendEmail(opts: SendEmailOpts): Promise<boolean> {
  const client = getClient();

  if (!client) {
    opts.onFailure?.({ category: "RESEND_NOT_CONFIGURED" });
    console.warn(
      `[EMAIL] SKIPPED — RESEND_API_KEY not set. ` +
      `Would have sent "${opts.subject}" to ${opts.to} (type=${opts.type}). ` +
      `Set RESEND_API_KEY in Replit Secrets to enable transactional emails.`
    );
    _appendLog({
      ts: new Date().toISOString(),
      to: opts.to,
      subject: opts.subject,
      type: opts.type,
      success: false,
      error: "RESEND_API_KEY not configured",
      attempts: 0,
    });
    return false;
  }

  let lastError: string | undefined;
  let lastFailure: EmailFailure | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    lastFailure = undefined;
    try {
      const result = await client.emails.send({
        from:     opts.from ?? FROM,
        to:       opts.to,
        subject:  opts.subject,
        html:     opts.html,
        replyTo:  opts.replyTo ?? FROM_ADDRESS,
      });

      const resultError = (result as any)?.error;
      if (resultError) {
        const name = String(resultError.name || "REJECTED").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 48);
        const status = Number(resultError.statusCode);
        lastFailure = { category: `RESEND_${name}`, ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { providerHttpStatus: status } : {}) };
        throw new Error(`${resultError.name || "ResendError"} (HTTP ${resultError.statusCode || "unknown"}): ${resultError.message || "Resend rejected email"}`);
      }
      const msgId = (result as any)?.data?.id ?? (result as any)?.id;
      if (!msgId) { lastFailure = { category: "RESEND_INVALID_RESPONSE" }; throw new Error("Resend did not confirm acceptance"); }
      console.log(`[EMAIL] SENT type=${opts.type} to=${opts.to} msgId=${msgId} attempt=${attempt}`);
      _appendLog({
        ts: new Date().toISOString(),
        to: opts.to,
        subject: opts.subject,
        type: opts.type,
        success: true,
        msgId,
        attempts: attempt,
      });
      return true;

    } catch (err: any) {
      lastError = err?.message ?? "Unknown error";
      if (!lastFailure) lastFailure = { category: err?.name === "AbortError" ? "RESEND_TIMEOUT" : "RESEND_NETWORK_OR_RUNTIME" };
      const isLast = attempt === MAX_RETRIES;
      if (isLast) {
        console.error(`[EMAIL] FAILED type=${opts.type} to=${opts.to} after ${attempt} attempts: ${lastError}`);
      } else {
        console.warn(`[EMAIL] RETRY attempt=${attempt}/${MAX_RETRIES} type=${opts.type} to=${opts.to}: ${lastError}`);
        await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt - 1)));
      }
    }
  }

  opts.onFailure?.(lastFailure ?? { category: "RESEND_UNKNOWN" });
  _appendLog({
    ts: new Date().toISOString(),
    to: opts.to,
    subject: opts.subject,
    type: opts.type,
    success: false,
    error: lastError,
    attempts: MAX_RETRIES,
  });
  return false;
}
