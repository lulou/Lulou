import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { WebhookHandlers } from "./webhookHandlers";
import helmet from "helmet";
import { generalLimiter, authLimiter } from "./limiters";

const app = express();
const httpServer = createServer(app);

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
// Allows cross-origin requests from the Vercel frontend (and local dev).
// On Replit fullstack mode the frontend is same-origin so this is a no-op.
// Add extra origins via ALLOWED_ORIGINS="https://a.com,https://b.com".
const _corsAllowPatterns: RegExp[] = [
  /\.replit\.app$/,
  /\.replit\.dev$/,
  /\.vercel\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  ...(process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map(
        (o) => new RegExp(`^${o.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`),
      )
    : []),
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && _corsAllowPatterns.some((p) => p.test(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }
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

(async () => {
  // ── Phase 1: register routes, set up static serving, then START LISTENING ───
  // The health-check probe fires immediately after the container starts.
  // All slow background tasks (Stripe sync, Supabase column probes) must NOT
  // block the listen() call — they are kicked off after the server is ready.

  // Ensure local PostgreSQL tables exist before routes are registered so that
  // the very first request doesn't hit a missing-table error. This is a fast
  // local PG call (sub-second) so it is safe to await here.
  try {
    const { pool: localPool } = await import("./db");
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
    `);
    console.log("[STARTUP] Local DB tables verified/created: user_benefits, user_elevates, call_credits, saved_wheel_profiles, active_sessions, membership_subscriptions");
  } catch (err: any) {
    console.error("[STARTUP] Local DB table migration failed:", err?.message);
  }

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
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
      console.log(`║  Secret key  : ${info.secretKeyPrefix}… (${secretMode})`);
      console.log(`║  Pub key     : ${info.pubKeyPrefix}…`);
      console.log(`║  Environment : ${isDeployment ? 'PRODUCTION (REPLIT_DEPLOYMENT=1)' : 'DEVELOPMENT'}`);
      console.log(`║  FRONTEND_URL: ${frontendUrl}${process.env.FRONTEND_URL ? ' (from env)' : ' (REPLIT_DOMAINS fallback)'}`);
      console.log(`║  Sessions URL: stripe.com/dashboard → ${info.livemode ? 'Live mode' : 'Test mode'} → Payments → Checkout`);
      if (!info.livemode) {
        console.log("║  ⚠  TEST mode — toggle Test mode ON in Stripe dashboard to see sessions");
      } else {
        console.log("║  ✓  LIVE mode — real charges will be made");
      }
      console.log("╚══════════════════════════════════════════════════════════╝");
    } catch (err: any) {
      console.warn("[STRIPE_AUDIT] Could not fetch Stripe account at startup:", err.message);
    }
  })();

  // Init Stripe schema & sync
  (async () => {
    try {
      const { runMigrations } = await import("stripe-replit-sync");
      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl) {
        await runMigrations({ databaseUrl });
        const { getStripeSync } = await import("./stripeClient");
        const stripeSync = await getStripeSync();
        const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
        const webhookUrl = `${webhookBaseUrl}/api/stripe/webhook`;
        console.log(`[WEBHOOK_SETUP] Registering Stripe webhook → ${webhookUrl}`);
        // findOrCreateManagedWebhook handles stale/missing IDs internally:
        // it will catch any 404 from Stripe, remove the stale ID from the local DB,
        // clean up orphaned webhooks in Stripe, then register a fresh endpoint.
        // 404 errors logged below this line are expected cleanup — not crashes.
        try {
          await stripeSync.findOrCreateManagedWebhook(webhookUrl);
          console.log(`[WEBHOOK_SETUP] Webhook endpoint ready ✓`);
        } catch (webhookErr: any) {
          const code = webhookErr?.raw?.code ?? webhookErr?.code ?? "unknown";
          const status = webhookErr?.statusCode ?? webhookErr?.raw?.statusCode ?? "";
          console.warn(
            `[WEBHOOK_SETUP] Webhook registration failed (${status} ${code}) — checkout still works; ` +
            `webhooks may not fire until next restart. Message: ${webhookErr.message}`
          );
        }
        stripeSync.syncBackfill().catch((err: any) => console.error("Stripe backfill error:", err));
      }
    } catch (err: any) {
      console.error("Stripe init error (non-fatal):", err.message);
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
