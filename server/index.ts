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
  // Init Stripe schema & sync
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

  // Warm up Stripe price IDs (creates products/prices once if missing)
  try {
    const { warmupStripePrices } = await import("./stripePrices");
    await warmupStripePrices();
  } catch (err: any) {
    console.warn("Stripe price warmup failed (non-fatal):", err.message);
  }

  // Check that lat/lng columns exist in Supabase — added for distance filtering.
  // If missing, Discovery/Wheel still work; distance filter is just skipped.
  // Run: ALTER TABLE profiles ADD COLUMN IF NOT EXISTS latitude double precision;
  //      ALTER TABLE profiles ADD COLUMN IF NOT EXISTS longitude double precision;
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

  // Auto-add is_paused column to Supabase profiles.
  // Enables account pause/unpause without a manual migration step.
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const { setHasIsPausedColumn } = await import("./storage");
    const supabaseUrl = process.env.VITE_SUPABASE_URL!;
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const adminSb = createClient(supabaseUrl, serviceKey);
    // First check if the column already exists
    const { error: checkErr } = await adminSb.from("profiles").select("is_paused").limit(1);
    if (!checkErr) {
      setHasIsPausedColumn(true);
    } else if (checkErr.message?.includes("does not exist")) {
      // Try to add column via direct pg connection (SUPABASE_DB_PASSWORD available)
      try {
        const { Pool: PgPool } = await import("pg");
        const projectRef = supabaseUrl.replace("https://", "").replace(".supabase.co", "");
        const dbPass = process.env.SUPABASE_DB_PASSWORD;
        if (dbPass && projectRef) {
          const pgPool = new PgPool({
            connectionString: `postgresql://postgres:${dbPass}@db.${projectRef}.supabase.co:5432/postgres`,
            ssl: { rejectUnauthorized: false },
          });
          await pgPool.query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_paused boolean DEFAULT false");
          await pgPool.end();
          setHasIsPausedColumn(true);
          console.log("[STARTUP] is_paused column added to Supabase profiles");
        }
      } catch (pgErr: any) {
        console.warn("[STARTUP] Could not add is_paused column via pg:", pgErr?.message);
        console.warn("  Run manually: ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_paused boolean DEFAULT false;");
      }
    }
  } catch (err: any) {
    console.warn("[STARTUP] Could not verify is_paused column:", err?.message);
  }

  // Check / auto-add custom_questions column to Supabase profiles.
  // Guards storage.ts column lists via _hasCustomQColumn flag so queries
  // don't fail if the column doesn't exist yet.
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const { setHasCustomQColumn } = await import("./storage");
    const supabaseUrl = process.env.VITE_SUPABASE_URL!;
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const adminSb = createClient(supabaseUrl, serviceKey);
    const { error: checkErr } = await adminSb.from("profiles").select("custom_questions").limit(1);
    if (!checkErr) {
      setHasCustomQColumn(true);
    } else if (checkErr.message?.includes("does not exist")) {
      try {
        const { Pool: PgPool } = await import("pg");
        const projectRef = supabaseUrl.replace("https://", "").replace(".supabase.co", "");
        const dbPass = process.env.SUPABASE_DB_PASSWORD;
        if (dbPass && projectRef) {
          const pgPool = new PgPool({
            connectionString: `postgresql://postgres:${dbPass}@db.${projectRef}.supabase.co:5432/postgres`,
            ssl: { rejectUnauthorized: false },
          });
          await pgPool.query("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS custom_questions jsonb DEFAULT '[]'::jsonb");
          await pgPool.end();
          setHasCustomQColumn(true);
          console.log("[STARTUP] custom_questions column added to Supabase profiles");
        }
      } catch (pgErr: any) {
        console.warn("[STARTUP] Could not add custom_questions column via pg:", pgErr?.message);
        console.warn("  Run manually: ALTER TABLE profiles ADD COLUMN IF NOT EXISTS custom_questions jsonb DEFAULT '[]'::jsonb;");
      }
    }
  } catch (err: any) {
    console.warn("[STARTUP] Could not verify custom_questions column:", err?.message);
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
})();
