import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { WebhookHandlers } from "./webhookHandlers";

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
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error("Stripe webhook error:", error.message);
      res.status(400).json({ error: "Webhook processing error" });
    }
  }
);

app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "50mb" }));

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
    `);
    console.log("[STARTUP] Local DB tables verified/created: user_benefits, user_elevates, call_credits, saved_wheel_profiles");
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
        await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
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
      const { setHasLatLngColumns } = await import("./storage");
      const supabaseUrl = process.env.VITE_SUPABASE_URL!;
      const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
      const adminSb = createClient(supabaseUrl, serviceKey);
      const { error } = await adminSb.from("profiles").select("latitude, longitude").limit(1);
      const columnsExist = !error || !error.message?.includes("does not exist");
      setHasLatLngColumns(columnsExist);
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
      const {
        setHasIsPausedColumn,
        setHasCustomQColumn,
        setHasViewerQColumn,
        setHasCustomStartersColumn,
        setHasDateOfBirthColumn,
        setHasPronounsColumn,
        setHasCustomGreenFlagsColumn,
        setHasCustomSignalsColumn,
      } = await import("./storage");

      const _supabaseUrl = process.env.VITE_SUPABASE_URL!;
      const _serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
      const _adminSb = _createClientProbe(_supabaseUrl, _serviceKey);

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
    } catch (err: any) {
      console.warn("[STARTUP] Optional-column probe failed:", err?.message);
    }
  })();
})();
