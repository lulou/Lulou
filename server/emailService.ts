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
  replyTo?: string;
}

export async function sendEmail(opts: SendEmailOpts): Promise<boolean> {
  const client = getClient();

  if (!client) {
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

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await client.emails.send({
        from:     FROM,
        to:       opts.to,
        subject:  opts.subject,
        html:     opts.html,
        replyTo:  opts.replyTo ?? FROM_ADDRESS,
      });

      const msgId = (result as any)?.data?.id ?? (result as any)?.id ?? "(no-id)";
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
      const isLast = attempt === MAX_RETRIES;
      if (isLast) {
        console.error(`[EMAIL] FAILED type=${opts.type} to=${opts.to} after ${attempt} attempts: ${lastError}`);
      } else {
        console.warn(`[EMAIL] RETRY attempt=${attempt}/${MAX_RETRIES} type=${opts.type} to=${opts.to}: ${lastError}`);
        await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt - 1)));
      }
    }
  }

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
