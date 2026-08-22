import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { WebhookHandlers } from "./webhookHandlers";
import helmet from "helmet";
import { generalLimiter, authLimiter } from "./limiters";

const app = express();
const httpServer = createServer(app);

// ── Trust Railway's reverse proxy so req.ip / rate-limiter keying is correct ─
app.set("trust proxy", 1);

// ── Top-of-stack request logger (fires before ALL other middleware) ───────────
// Lets Railway deployment logs confirm whether requests reach Express at all.
// Logs: METHOD /path timestamp
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path} ${new Date().toISOString()}`);
  next();
});

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// ── Stripe webhook MUST be registered before express.json() ─────────────────
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).json({ error: "Missing stripe-signature" });
    }
    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      // Log the raw event type before signature verification so we can see
      // every delivery attempt even if verification fails.
      let rawEventType = "(unparsed)";
      try { rawEventType = JSON.parse((req.body as Buffer).toString()).type ?? "(no type)"; } catch {}
      console.log(`[WEBHOOK] RECEIVED — type=${rawEventType} sig=…${sig.slice(-8)}`);
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      console.log(`[WEBHOOK] PROCESSED_OK — type=${rawEventType}`);
      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error("Stripe webhook error:", error.message);
      res.status(400).json({ error: "Webhook processing error" });
    }
  }
);

// ── Security headers via Helmet ───────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
        connectSrc: ["'self'", "https:", "wss:"],
        fontSrc: ["'self'", "data:", "https:"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    // CORP: same-origin (helmet default) can block cross-origin fetch reads even
    // when CORS is configured correctly. Disable it on the API server so the
    // Vercel frontend can read responses; CORS headers handle access control.
    crossOriginResourcePolicy: false,
  }),
);

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Tier 1 — general reads on all /api routes (2000 req/15 min/IP).
//   Covers page load bursts (~20 req), polling (3 chats × 10 s = 270/15 min),
//   and dev refreshes without triggering false-positive 429s.
// Tier 4 — auth endpoints only (20 req/15 min/IP) — brute-force guard.
//   Applied here for /api/auth/init (signup/login bootstrap).
//   Tiers 2/3/5 (writes, calls, payments) are applied inline per-route
//   in routes.ts so they never catch polling/read traffic.
app.use("/api", generalLimiter);
app.use("/api/auth/session-check", authLimiter);

app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "2mb" }));

// ── CORS ─────────────────────────────────────────────────────────────────────
// Two-layer allowlist:
//   1. Explicit origins — exact strings (production custom domain + known URLs).
//   2. Pattern-based — dev hosts (Replit, Vercel preview, localhost).
//
// FRONTEND_URL and ALLOWED_ORIGINS env vars are both consumed so Railway /
// Replit secrets control the live list without code changes.

// Layer 1: explicit production origins (exact match, case-insensitive compare)
const _corsExplicitOrigins = new Set<string>([
  "https://www.luloudating.com",
  "https://luloudating.com",
  "https://lulouapp.vercel.app",
  // Env-driven: FRONTEND_URL (single origin) and ALLOWED_ORIGINS (CSV list)
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL.trim()] : []),
  ...(process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : []),
]);

// Layer 2: pattern-based dev/preview origins
const _corsPatterns: RegExp[] = [
  /\.replit\.app$/,
  /\.replit\.dev$/,
  /\.vercel\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
];

function isCorsAllowed(origin: string): boolean {
  if (_corsExplicitOrigins.has(origin)) return true;
  return _corsPatterns.some((p) => p.test(origin));
}

// Log the active explicit allowlist once at startup for Railway diagnostics.
console.log(`[CORS] Explicit origin allowlist: ${[..._corsExplicitOrigins].join(", ") || "(empty)"}`);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Always set Vary: Origin so CDNs/proxies never serve a cached response
  // with the wrong (or missing) Access-Control-Allow-Origin header.
  res.setHeader("Vary", "Origin");

  if (origin) {
    if (isCorsAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Voice-Mime");
      res.setHeader("Access-Control-Expose-Headers", "X-Empty-Reason, X-Feed-Radius-Miles");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");

      // Diagnostic: log every OPTIONS preflight for /api/profile so CORS flow
      // is traceable in Railway logs without noise on normal requests.
      if (req.method === "OPTIONS" && req.path === "/api/profile") {
        console.log(`[CORS] OPTIONS /api/profile origin=${origin} → allowed, ACAO=${origin}`);
      }
    } else {
      // Rejected — log so Railway logs show exactly which origin was blocked.
      console.warn(`[CORS] REJECTED origin=${origin} method=${req.method} path=${req.path}`);
    }
  }

  // Respond to all preflight requests immediately (with or without CORS headers
  // — the browser will block if headers are absent, which is the correct behaviour
  // for disallowed origins).
  if (req.method === "OPTIONS") return res.status(204).end();

  next();
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

// ── Background: ensure local Neon tables exist ───────────────────────────────
// Run AFTER listen() so the DB connection setup never delays port binding.
// On cold Railway starts Neon's first TCP+SSL handshake can take 5-30 s;
// awaiting it before listen() causes Railway's health probe to see
// "connection refused" and report the deployment as failed.
// Tables already exist on subsequent restarts so this DDL is near-instant then.
async function initLocalDb() {
  // Import once at function scope so both try blocks can share the pool.
  const { pool: localPool } = await import("./db");
  try {
    await localPool.query(`
      CREATE TABLE IF NOT EXISTS user_benefits (
        id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     VARCHAR NOT NULL,
        type        TEXT NOT NULL,
        activated_match_id VARCHAR,
        created_at  TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_user_benefits_user ON user_benefits(user_id);

      CREATE TABLE IF NOT EXISTS user_elevates (
        id                    VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id               VARCHAR NOT NULL UNIQUE,
        elevate_type          TEXT NOT NULL DEFAULT 'elevate',
        expires_at            TIMESTAMP NOT NULL DEFAULT NOW(),
        activated_at          TIMESTAMP,
        elevate_credits       INTEGER NOT NULL DEFAULT 0,
        super_elevate_credits INTEGER NOT NULL DEFAULT 0,
        created_at            TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_user_elevates_user ON user_elevates(user_id);

      CREATE TABLE IF NOT EXISTS call_credits (
        id             VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        VARCHAR NOT NULL UNIQUE,
        phone_credits  INTEGER NOT NULL DEFAULT 0,
        video_credits  INTEGER NOT NULL DEFAULT 0,
        updated_at     TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_call_credits_user ON call_credits(user_id);

      CREATE TABLE IF NOT EXISTS saved_wheel_profiles (
        id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          VARCHAR NOT NULL UNIQUE,
        saved_profile_id VARCHAR NOT NULL,
        saved_at         TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at       TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_saved_wheel_user ON saved_wheel_profiles(user_id);

      CREATE TABLE IF NOT EXISTS active_sessions (
        id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      TEXT NOT NULL UNIQUE,
        session_id   TEXT NOT NULL,
        device_id    TEXT NOT NULL DEFAULT '',
        user_agent   TEXT NOT NULL DEFAULT '',
        created_at   TIMESTAMP DEFAULT NOW(),
        last_seen_at TIMESTAMP DEFAULT NOW(),
        expires_at   TIMESTAMP NOT NULL
      );
      -- Guard columns added in the single-session-enforcement update.
      -- ADD COLUMN IF NOT EXISTS is idempotent — safe on every startup.
      ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS revoked_at    TIMESTAMPTZ;
      ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS revoked_reason TEXT;
      CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_sessions(user_id);

      CREATE TABLE IF NOT EXISTS membership_subscriptions (
        user_id                VARCHAR PRIMARY KEY,
        stripe_customer_id     VARCHAR NOT NULL,
        stripe_subscription_id VARCHAR NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'active',
        current_period_end     TIMESTAMP,
        created_at             TIMESTAMP DEFAULT NOW(),
        updated_at             TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_membership_subs_customer ON membership_subscriptions(stripe_customer_id);

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       TEXT NOT NULL,
        endpoint      TEXT NOT NULL UNIQUE,
        p256dh        TEXT NOT NULL,
        auth          TEXT NOT NULL,
        user_agent    TEXT DEFAULT '',
        fail_count    INTEGER DEFAULT 0,
        created_at    TIMESTAMP DEFAULT NOW(),
        last_used_at  TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

      CREATE TABLE IF NOT EXISTS notification_preferences (
        user_id        TEXT PRIMARY KEY,
        new_like       BOOLEAN DEFAULT TRUE,
        new_match      BOOLEAN DEFAULT TRUE,
        new_message    BOOLEAN DEFAULT TRUE,
        incoming_call  BOOLEAN DEFAULT TRUE,
        missed_call    BOOLEAN DEFAULT TRUE,
        halo           BOOLEAN DEFAULT TRUE,
        elevate        BOOLEAN DEFAULT TRUE,
        payment        BOOLEAN DEFAULT TRUE,
        safety         BOOLEAN DEFAULT TRUE,
        updated_at     TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_payment_simulations (
        id                  VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        sim_session_id      VARCHAR NOT NULL UNIQUE,
        admin_user_id       VARCHAR NOT NULL,
        target_user_id      VARCHAR NOT NULL,
        item_id             TEXT,
        pack_id             TEXT,
        product_name        TEXT NOT NULL,
        amount_cents        INTEGER NOT NULL DEFAULT 0,
        currency            TEXT NOT NULL DEFAULT 'aud',
        status              TEXT NOT NULL DEFAULT 'granted',
        refund_sim_id       VARCHAR,
        grant_result        TEXT,
        purchase_email_sent BOOLEAN DEFAULT FALSE,
        refund_email_sent   BOOLEAN DEFAULT FALSE,
        error_log           TEXT,
        created_at          TIMESTAMP DEFAULT NOW(),
        refunded_at         TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_admin_sim_target ON admin_payment_simulations(target_user_id);
      CREATE INDEX IF NOT EXISTS idx_admin_sim_admin  ON admin_payment_simulations(admin_user_id);

      CREATE TABLE IF NOT EXISTS date_plan_reminders_sent (
        match_id      VARCHAR NOT NULL,
        reminder_type TEXT NOT NULL,
        sent_at       TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (match_id, reminder_type)
      );

      CREATE TABLE IF NOT EXISTS active_chat_sessions (
        user_id      TEXT PRIMARY KEY,
        match_id     TEXT NOT NULL,
        last_seen_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS refund_records (
        id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          VARCHAR NOT NULL,
        refund_id        VARCHAR NOT NULL UNIQUE,
        amount_cents     INTEGER NOT NULL,
        currency         TEXT NOT NULL DEFAULT 'aud',
        amount_formatted TEXT NOT NULL,
        product_name     TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'completed',
        read_at          TIMESTAMP,
        created_at       TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_refund_records_user ON refund_records(user_id);

      CREATE TABLE IF NOT EXISTS voice_note_unlocks (
        match_id    TEXT PRIMARY KEY,
        unlocked_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS voice_note_popup_seen (
        match_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        seen_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (match_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_vnps_user ON voice_note_popup_seen(user_id);

      CREATE TABLE IF NOT EXISTS first_call_prompt_seen (
        match_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        seen_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (match_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_fcps_user ON first_call_prompt_seen(user_id);

      CREATE TABLE IF NOT EXISTS connection_dna_responses (
        user_id       VARCHAR NOT NULL,
        question_id   TEXT    NOT NULL,
        answer_index  INTEGER NOT NULL,
        updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, question_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dna_responses_user ON connection_dna_responses(user_id);

      CREATE TABLE IF NOT EXISTS connection_dna_profiles (
        user_id      VARCHAR   PRIMARY KEY,
        dimensions   TEXT,
        version      TEXT      NOT NULL DEFAULT 'dna_v1',
        completed_at TIMESTAMP,
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS match_compatibility (
        user_a_id        VARCHAR NOT NULL,
        user_b_id        VARCHAR NOT NULL,
        total_score      INTEGER NOT NULL,
        component_scores TEXT,
        reason_keys      TEXT,
        reason_texts     TEXT,
        is_variety_pick  BOOLEAN NOT NULL DEFAULT FALSE,
        version          TEXT    NOT NULL DEFAULT 'dna_v1',
        calculated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_a_id, user_b_id)
      );
      CREATE INDEX IF NOT EXISTS idx_compat_a ON match_compatibility(user_a_id);
      CREATE INDEX IF NOT EXISTS idx_compat_b ON match_compatibility(user_b_id);

      CREATE TABLE IF NOT EXISTS interaction_signals (
        id             VARCHAR   PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id        VARCHAR   NOT NULL,
        target_user_id VARCHAR   NOT NULL,
        match_id       VARCHAR,
        event_type     TEXT      NOT NULL,
        event_weight   INTEGER   NOT NULL DEFAULT 1,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_signals_user   ON interaction_signals(user_id);
      CREATE INDEX IF NOT EXISTS idx_signals_target ON interaction_signals(target_user_id);

      CREATE TABLE IF NOT EXISTS private_connection_feedback (
        id              VARCHAR   PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id         VARCHAR   NOT NULL,
        match_id        VARCHAR   NOT NULL,
        selected_reason TEXT      NOT NULL,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_user  ON private_connection_feedback(user_id);
      CREATE INDEX IF NOT EXISTS idx_feedback_match ON private_connection_feedback(match_id);

      -- user_settings: secondary safety check only.
      -- Primary migration: supabase/migrations/add_user_settings_table.sql
      -- push_account_enabled NOT NULL matches amend_push_not_null.sql
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id              UUID        PRIMARY KEY,
        preferred_language   TEXT        NOT NULL DEFAULT 'English',
        preferred_units      TEXT        NOT NULL DEFAULT 'miles',
        audio_transcripts    BOOLEAN     NOT NULL DEFAULT true,
        push_account_enabled BOOLEAN     NOT NULL DEFAULT false,
       onboarding_tutorial_completed BOOLEAN NOT NULL DEFAULT false,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("[STARTUP] Local DB tables verified/created: user_benefits, user_elevates, call_credits, saved_wheel_profiles, active_sessions, membership_subscriptions, push_subscriptions, notification_preferences, admin_payment_simulations, date_plan_reminders_sent, active_chat_sessions, refund_records, voice_note_unlocks, voice_note_popup_seen, first_call_prompt_seen, connection_dna_responses, connection_dna_profiles, match_compatibility, interaction_signals, private_connection_feedback, user_settings");
  } catch (err: any) {
    console.error("[STARTUP] Local DB table migration failed:", err?.message);
  }

  // Existing accounts should never be unexpectedly dropped into a new-user
  // tutorial. Rows that pre-date the field are marked complete exactly once;
  // future rows receive the schema default (false).
  try {
    await localPool.query(`
      ALTER TABLE user_settings
        ADD COLUMN IF NOT EXISTS onboarding_tutorial_completed BOOLEAN;
      UPDATE user_settings
        SET onboarding_tutorial_completed = true
        WHERE onboarding_tutorial_completed IS NULL;
      ALTER TABLE user_settings
        ALTER COLUMN onboarding_tutorial_completed SET DEFAULT false;
      ALTER TABLE user_settings
        ALTER COLUMN onboarding_tutorial_completed SET NOT NULL;

      CREATE TABLE IF NOT EXISTS profile_photo_reactions (
        id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id         VARCHAR NOT NULL,
        profile_user_id VARCHAR NOT NULL,
        photo_url       TEXT NOT NULL,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT profile_photo_reactions_unique
          UNIQUE (user_id, profile_user_id, photo_url)
      );
      CREATE INDEX IF NOT EXISTS idx_photo_reactions_user
        ON profile_photo_reactions(user_id);

      CREATE TABLE IF NOT EXISTS profile_prompt_replies (
        id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id         VARCHAR NOT NULL,
        profile_user_id VARCHAR NOT NULL,
        prompt_text     TEXT NOT NULL,
        reply_text      TEXT NOT NULL,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT profile_prompt_replies_unique
          UNIQUE (user_id, profile_user_id, prompt_text)
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_replies_user_profile
        ON profile_prompt_replies(user_id, profile_user_id);
    `);
    console.log("[STARTUP] tutorial and photo-reaction persistence verified");
  } catch (err: any) {
    console.error("[STARTUP] tutorial/photo-reaction migration failed:", err?.message);
  }

  // ── Guard: ensure active_sessions has the single-session-enforcement columns ──
  // Runs as a SEPARATE pool.query() so it cannot be skipped by a failure earlier
  // in the large multi-statement CREATE TABLE block above.  Without these two
  // columns session-bootstrap throws "column does not exist" and returns 500,
  // blocking every user from entering the app.
  try {
    await localPool.query(`
      ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS revoked_at    TIMESTAMPTZ;
      ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS revoked_reason TEXT;
    `);
    console.log("[STARTUP] active_sessions guard columns ensured (revoked_at, revoked_reason)");
  } catch (guardErr: any) {
    console.error("[STARTUP] active_sessions guard columns failed:", guardErr?.message, guardErr?.code);
  }

  // ── Column audit: print every active_sessions column from this process's DB ──
  // Verifies that the DDL above ran against the SAME database that session-bootstrap
  // uses.  Appears in Railway startup logs — safe (no row data, no credentials).
  try {
    const { rows } = await localPool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'active_sessions'
      ORDER BY ordinal_position;
    `);
    const cols = rows.map(r => r.column_name);
    console.log("[STARTUP] active_sessions column list:", cols.join(", "));
    const hasRevoked = cols.includes("revoked_at") && cols.includes("revoked_reason");
    console.log("[STARTUP] active_sessions revoked columns present:", hasRevoked);
  } catch (auditErr: any) {
    console.error("[STARTUP] active_sessions column audit failed:", auditErr?.message);
  }
}

// ── Background: push subscription maintenance ─────────────────────────────────
// Also runs AFTER listen() — one-time nuclear cleanup + fail-count pruning.
async function initPushCleanup() {
  // Clean up any push subscriptions that repeatedly failed (failCount >= 5).
  try {
    const { cleanupFailedSubscriptions } = await import("./pushService");
    await cleanupFailedSubscriptions();
  } catch { /* non-critical */ }

  // ── One-time push subscription nuclear cleanup ───────────────────────────
  // Root-cause fix for the self-notification production bug:
  // The old onConflictDoUpdate({ set: { userId } }) in POST /api/push/subscribe
  // silently reassigned push endpoints to different users on the same device.
  // This resulted in stale rows where push_subscriptions.user_id != the actual
  // device owner, causing sends to recipientId to deliver to the sender's device.
  //
  // This block runs EXACTLY ONCE (guarded by push_cleanup_runs sentinel table).
  // After deletion, every device auto-re-registers its subscription under the
  // correct logged-in userId on the next app load (via AppContent useEffect).
  try {
    const { pool: pushPool } = await import("./db");
    await pushPool.query(`CREATE TABLE IF NOT EXISTS push_cleanup_runs (version INTEGER PRIMARY KEY, ran_at TIMESTAMP DEFAULT NOW())`);
    const guard = await pushPool.query(`SELECT 1 FROM push_cleanup_runs WHERE version = 1`);
    if ((guard.rowCount ?? 0) === 0) {
      const { rows } = await pushPool.query(
        `SELECT id, user_id, endpoint, user_agent, fail_count, created_at, last_used_at FROM push_subscriptions ORDER BY created_at DESC`
      );
      console.log(`[PUSH_AUDIT] STARTUP nuclear cleanup — found ${rows.length} stale subscription(s):`);
      for (const row of rows) {
        console.log(
          `[PUSH_AUDIT]   id=${String(row.id).slice(0,8)} ` +
          `userId=${String(row.user_id).slice(0,8)} ` +
          `endpoint=…${String(row.endpoint).slice(-20)} ` +
          `ua="${String(row.user_agent || "").slice(0, 60)}" ` +
          `failCount=${row.fail_count} ` +
          `createdAt=${row.created_at} ` +
          `lastUsed=${row.last_used_at}`
        );
      }
      const { rowCount: deleted } = await pushPool.query(`DELETE FROM push_subscriptions`);
      await pushPool.query(`INSERT INTO push_cleanup_runs (version) VALUES (1)`);
      console.log(`[PUSH_AUDIT] STARTUP nuclear cleanup DONE — deleted ${deleted ?? 0} subscription(s). All devices will auto-re-register on next app open.`);
    } else {
      const { rows } = await pushPool.query(
        `SELECT id, user_id, endpoint, user_agent, fail_count, created_at, last_used_at FROM push_subscriptions ORDER BY created_at DESC`
      );
      console.log(`[PUSH_AUDIT] STARTUP (post-cleanup): ${rows.length} active subscription(s):`);
      for (const row of rows) {
        console.log(
          `[PUSH_AUDIT]   id=${String(row.id).slice(0,8)} ` +
          `userId=${String(row.user_id).slice(0,8)} ` +
          `endpoint=…${String(row.endpoint).slice(-20)} ` +
          `failCount=${row.fail_count} ` +
          `lastUsed=${row.last_used_at}`
        );
      }
    }
  } catch (e: any) {
    console.warn("[PUSH_AUDIT] STARTUP cleanup error (non-fatal):", e?.message);
  }
}

// ── Main startup IIFE ─────────────────────────────────────────────────────────
(async () => {
  // 1. Register all route handlers (synchronous registration, fast).
  await registerRoutes(httpServer, app);

  // 2. Global error handler (must be after routes).
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // 3. Static serving / Vite dev server.
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // 4. START LISTENING — port opens here, before any slow DB/network init.
  //    Railway's health-check probe must see an open port within a few seconds
  //    of the container starting.  Neon's first TCP+SSL handshake can take
  //    5-30 s on a cold start; awaiting DB work before listen() causes the
  //    probe to see "connection refused" and mark the deployment as failed.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      // 5. Background DB/push init — runs after port is open so it never
      //    delays Railway's health-check or the first incoming request.
      void initLocalDb();
      void initPushCleanup();
    },
  );

  const shutdown = () => {
    log("Received shutdown signal, closing server gracefully...");
    httpServer.close(() => {
      log("Server closed.");
      process.exit(0);
    });
    setTimeout(() => {
      log("Graceful shutdown timed out, forcing exit.");
      process.exit(1);
    }, 10_000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ── Phase 2: background tasks (do NOT await — server is already listening) ──

  // ── Stripe startup audit ─────────────────────────────────────────────────
  // Calls stripe.accounts.retrieve() to get the REAL account ID — not just a
  // key fragment — so mismatches against the Stripe dashboard are undeniable.
  (async () => {
    try {
      const { getStripeAccountInfo } = await import("./stripeClient");
      const info = await getStripeAccountInfo();   // also emits [STRIPE_ACCOUNT] log
      const secretMode  = info.secretKeyPrefix.startsWith('sk_live') ? 'LIVE' : 'TEST';
      const frontendUrl = process.env.FRONTEND_URL ?? `https://${process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost:5000"}`;
      const isDeployment = process.env.REPLIT_DEPLOYMENT === '1';
      console.log("╔══════════════════════════════════════════════════════════╗");
      console.log("║             STRIPE ACCOUNT AUDIT (startup)              ║");
      console.log("╠══════════════════════════════════════════════════════════╣");
      console.log(`║  Account ID  : ${info.accountId}  ← compare with dashboard URL`);
      console.log(`║  Display name: ${info.displayName ?? '(not set)'}`);
      console.log(`║  Country     : ${info.country ?? '(unknown)'}`);
      console.log(`║  Livemode    : ${info.livemode}`);
      console.log(`║  Source      : ${info.source}`);
      console.log(`║  Secret key  : ${info.secretKeyPrefix}… (${secretMode})`);
      console.log(`║  Pub key     : ${info.pubKeyPrefix}…`);
      console.log(`║  Environment : ${isDeployment ? 'PRODUCTION (REPLIT_DEPLOYMENT=1)' : 'DEVELOPMENT'}`);
      console.log(`║  FRONTEND_URL: ${frontendUrl}${process.env.FRONTEND_URL ? ' (from env)' : ' (REPLIT_DOMAINS fallback)'}`);
      console.log(`║  Sessions URL: stripe.com/dashboard → ${info.livemode ? 'Live mode' : 'Test mode'} → Payments → Checkout`);
      if (!info.livemode && isDeployment) {
        console.log("║  ⛔ TEST KEYS IN PRODUCTION — set STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY (live) and redeploy");
      } else if (!info.livemode) {
        console.log("║  ⚠  TEST mode — toggle Test mode ON in Stripe dashboard to see sessions");
      } else {
        console.log("║  ✓  LIVE mode — real charges will be made");
      }
      console.log("╚══════════════════════════════════════════════════════════╝");
    } catch (err: any) {
      console.warn("[STRIPE_AUDIT] Could not fetch Stripe account at startup:", err.message);
    }
  })();


  // Warm up Stripe price IDs (creates products/prices once if missing)
  (async () => {
    try {
      const { warmupStripePrices } = await import("./stripePrices");
      await warmupStripePrices();
    } catch (err: any) {
      console.warn("Stripe price warmup failed (non-fatal):", err.message);
    }
  })();

  // Check that lat/lng columns exist in Supabase — added for distance filtering.
  // If missing, Discovery/Wheel still work; distance filter is just skipped.
  (async () => {
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const ws = (await import("ws")).default;
      const { setHasLatLngColumns } = await import("./storage");
      const supabaseUrl = process.env.VITE_SUPABASE_URL!;
      const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
      const adminSb = createClient(supabaseUrl, serviceKey, { realtime: { transport: ws as any } });
      const { error } = await adminSb.from("profiles").select("latitude, longitude").limit(1);
      const columnsExist = !error || !error.message?.includes("does not exist");
      setHasLatLngColumns(columnsExist);

      // Background backfill: geocode existing profiles that have location text
      // but no lat/lng coordinates (created before geocoding was added).
      // Rate-limited to 1 req/second to respect Nominatim's usage policy.
      // Paginated — handles user bases of any size, not capped at 300.
      if (columnsExist) {
        (async () => {
          try {
            // Reduced from 10 s to 2 s — backfill must complete before the first
            // user discovers, to avoid the null-coord exclusion window.
            await new Promise(r => setTimeout(r, 2_000));
            const { geocodeLocation } = await import("./storage");

            const PAGE_SIZE = 50; // safe page size; well under PostgREST row limits
            let page = 0;
            let totalSuccess = 0;
            let totalProcessed = 0;
            let totalFailed = 0;

            while (true) {
              const { data: profiles, error: qErr } = await adminSb
                .from("profiles")
                .select("user_id, location")
                .not("location", "is", null)
                .is("latitude", null)
                .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

              if (qErr) { console.warn("[BACKFILL] query error:", qErr.message); break; }
              if (!profiles || profiles.length === 0) {
                if (page === 0) {
                  console.log("[BACKFILL] All profiles already have coordinates ✓");
                } else {
                  console.log(`[BACKFILL] Complete — ${totalSuccess} geocoded, ${totalFailed} failed, ${totalProcessed} processed across ${page} page(s).`);
                }
                break;
              }

              if (page === 0) {
                console.log(`[BACKFILL] Geocoding profiles with missing coordinates (page size ${PAGE_SIZE})…`);
              }

              for (const p of profiles) {
                if (!p.location) { totalProcessed++; continue; }
                try {
                  const coords = await geocodeLocation(p.location);
                  if (coords) {
                    const { error: upErr } = await adminSb.from("profiles")
                      .update({ latitude: coords.lat, longitude: coords.lng })
                      .eq("user_id", p.user_id);
                    if (!upErr) {
                      totalSuccess++;
                      console.log(`[BACKFILL] "${p.location}" → ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
                    } else {
                      totalFailed++;
                      console.warn(`[BACKFILL] update error for ${p.user_id}:`, upErr.message);
                    }
                  } else {
                    totalFailed++;
                    console.warn(`[BACKFILL] no geocode result for "${p.location}"`);
                  }
                } catch (e: any) {
                  totalFailed++;
                  console.warn(`[BACKFILL] error for "${p.location}":`, e?.message);
                }
                totalProcessed++;
                await new Promise(r => setTimeout(r, 1100)); // 1.1 s — Nominatim rate limit
              }

              page++;
            }
          } catch (e: any) {
            console.warn("[BACKFILL] failed:", e?.message);
          }
        })();
      }

      if (!columnsExist) {
        console.error("╔═══════════════════════════════════════════════════════════════╗");
        console.error("║  MIGRATION REQUIRED — run this SQL in the Supabase SQL editor ║");
        console.error("╠═══════════════════════════════════════════════════════════════╣");
        console.error("║  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS                ║");
        console.error("║    latitude double precision;                                 ║");
        console.error("║  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS                ║");
        console.error("║    longitude double precision;                                ║");
        console.error("╚═══════════════════════════════════════════════════════════════╝");
        console.error("  Discovery and Wheel work normally — distance filter is skipped.");
      }
    } catch (err: any) {
      console.warn("[STARTUP] Could not verify distance columns:", err?.message);
    }
  })();

  // ── Supabase optional-column probe ──────────────────────────────────────────
  // Checks all optional profile columns in one pass. Sets guard flags in
  // storage.ts so queries never reference a column that doesn't exist yet.
  (async () => {
    try {
      const { createClient: _createClientProbe } = await import("@supabase/supabase-js");
      const _ws = (await import("ws")).default;
      const {
        setHasIsPausedColumn,
        setHasCustomQColumn,
        setHasViewerQColumn,
        setHasCustomStartersColumn,
        setHasDateOfBirthColumn,
        setHasPronounsColumn,
        setHasCustomGreenFlagsColumn,
        setHasCustomSignalsColumn,
        setHasLastActiveColumn,
        setHasShowLastActiveColumn,
        setHasCommentFilterColumn,
        setHasConversationStarterAiColumn,
        setHasVoiceTranscriptColumn,
        setHasEmailVerifiedColumn,
      } = await import("./storage");

      const _supabaseUrl = process.env.VITE_SUPABASE_URL!;
      const _serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
      const _adminSb = _createClientProbe(_supabaseUrl, _serviceKey, { realtime: { transport: _ws as any } });

      type ColDef = {
        col: string;
        setter: (v: boolean) => void;
        sql: string;
      };
      const OPTIONAL_COLS: ColDef[] = [
        { col: "is_paused",          setter: setHasIsPausedColumn,          sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_paused boolean DEFAULT false;" },
        { col: "custom_questions",   setter: setHasCustomQColumn,           sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS custom_questions jsonb DEFAULT '[]'::jsonb;" },
        { col: "viewer_questions",   setter: setHasViewerQColumn,           sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS viewer_questions jsonb DEFAULT '[]'::jsonb;" },
        { col: "custom_starters",    setter: setHasCustomStartersColumn,    sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS custom_starters jsonb DEFAULT '[]'::jsonb;" },
        { col: "date_of_birth",      setter: setHasDateOfBirthColumn,       sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS date_of_birth date;" },
        { col: "pronouns",           setter: setHasPronounsColumn,          sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pronouns text;" },
        { col: "custom_green_flags", setter: setHasCustomGreenFlagsColumn,  sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS custom_green_flags jsonb DEFAULT '[]'::jsonb;" },
        { col: "custom_signals",     setter: setHasCustomSignalsColumn,     sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS custom_signals jsonb DEFAULT '[]'::jsonb;" },
        { col: "last_active",              setter: setHasLastActiveColumn,              sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_active timestamptz;" },
        { col: "show_last_active",         setter: setHasShowLastActiveColumn,          sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS show_last_active boolean DEFAULT true;" },
        { col: "comment_filter",           setter: setHasCommentFilterColumn,           sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS comment_filter boolean DEFAULT true;" },
        { col: "conversation_starter_ai",  setter: setHasConversationStarterAiColumn,   sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS conversation_starter_ai boolean DEFAULT true;" },
        { col: "email_verified",           setter: setHasEmailVerifiedColumn,           sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT false;" },
      ];

      const missingSql: string[] = [];

      await Promise.all(OPTIONAL_COLS.map(async ({ col, setter, sql }) => {
        try {
          const { error } = await _adminSb.from("profiles").select(col).limit(1);
          if (!error) {
            setter(true);
            console.log(`[STARTUP] profiles.${col} AVAILABLE`);
          } else if (error.message?.includes("does not exist")) {
            missingSql.push(sql);
          } else {
            console.warn(`[STARTUP] Could not verify profiles.${col}:`, error.message);
          }
        } catch (e: any) {
          console.warn(`[STARTUP] Could not probe profiles.${col}:`, e?.message);
        }
      }));

      if (missingSql.length > 0) {
        console.warn("╔══════════════════════════════════════════════════════════════════╗");
        console.warn("║  MIGRATION NEEDED — paste this into Supabase Dashboard SQL Editor ║");
        console.warn("╠══════════════════════════════════════════════════════════════════╣");
        for (const s of missingSql) console.warn(`║  ${s.padEnd(66)}║`);
        console.warn("╚══════════════════════════════════════════════════════════════════╝");
        console.warn("  Affected features are gracefully disabled until the columns exist.");
      } else {
        console.log("[STARTUP] All optional Supabase profile columns present ✓");
      }

      // ── email_verified backfill ───────────────────────────────────────────────
      // The email_verified column is added with DEFAULT false, which means ALL
      // existing rows — including profiles whose owners have long since verified
      // their email — start with false.  The lazy update in isAuthenticated only
      // fixes each user's OWN row the first time they make an API call.  On a
      // fresh deploy or after adding the column, this leaves the entire profile
      // pool invisible in Discovery until every single user individually logs in.
      //
      // Fix: at startup, grandfather all profiles created before the enforcement
      // date (2026-06-17) by setting email_verified = true immediately.  These
      // accounts pre-date the verification requirement and are trusted by default.
      // New accounts created after that date rely on the lazy-update path (they
      // become visible as soon as they make their first authenticated API call
      // after email verification).
      try {
        const GRANDFATHER_TS = "2026-06-17T00:00:00.000Z";
        const { error: bfErr } = await _adminSb
          .from("profiles")
          .update({ email_verified: true })
          .eq("email_verified", false)
          .lt("created_at", GRANDFATHER_TS);
        if (bfErr) {
          // Column doesn't exist yet → ignore; will be fixed next deploy
          if (!bfErr.message?.includes("does not exist")) {
            console.warn("[STARTUP] email_verified backfill error:", bfErr.message);
          }
        } else {
          console.log(`[STARTUP] email_verified backfill done — pre-${GRANDFATHER_TS} profiles marked verified ✓`);
        }
      } catch (bfEx: any) {
        console.warn("[STARTUP] email_verified backfill exception:", bfEx?.message);
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Probe messages.voice_transcript separately (different table).
      try {
        const { error: vtErr } = await _adminSb.from("messages").select("voice_transcript").limit(1);
        if (!vtErr) {
          setHasVoiceTranscriptColumn(true);
          console.log("[STARTUP] messages.voice_transcript AVAILABLE");
        } else if (vtErr.message?.includes("does not exist")) {
          console.warn("[STARTUP] MIGRATION NEEDED: ALTER TABLE messages ADD COLUMN IF NOT EXISTS voice_transcript text;");
        }
      } catch (e: any) {
        console.warn("[STARTUP] Could not probe messages.voice_transcript:", e?.message);
      }
    } catch (err: any) {
      console.warn("[STARTUP] Optional-column probe failed:", err?.message);
    }
  })();
})();
