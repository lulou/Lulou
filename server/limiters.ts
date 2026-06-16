import { rateLimit, ipKeyGenerator, type Options } from "express-rate-limit";

// ─────────────────────────────────────────────────────────────────────────────
// Lulou Dating — Tiered Rate Limiters
//
// Tier 1  GENERAL   2000 req/15 min/IP  — page loads + polling
//                   3 chats × 10s poll × 15 min = 270 polls alone.
//                   2000 gives comfortable headroom with dev refreshes.
//
// Tier 2  WRITES     300 req/15 min/user — message sends, likes, spins
//                   Normal session: ~30-60 messages, ~30 likes → well under 300.
//                   Per-user key (not IP) so shared WiFi is fair.
//
// Tier 3  CALLS       30 req/15 min/user — call start / rering / repair
//                   Prevents call-harassment loops.
//
// Tier 4  AUTH        20 req/15 min/IP  — signup / login / password reset
//                   Prevents credential brute-force. IP-keyed intentionally.
//
// Tier 5  PAYMENT     10 req/15 min/IP  — Stripe checkout creation
//                   Prevents automated checkout spam / card testing.
// ─────────────────────────────────────────────────────────────────────────────

const base: Partial<Options> = {
  standardHeaders: true,  // emit RateLimit-* headers (RFC 6585)
  legacyHeaders: false,   // suppress X-RateLimit-* legacy headers
};

// Key by authenticated user ID when available; fall back to normalized IP.
// Uses ipKeyGenerator for the IP path so IPv6 addresses are handled correctly
// and users on shared WiFi don't consume each other's write/call quotas.
const keyByUser = (req: any): string =>
  (req.user?.id as string | undefined) ?? ipKeyGenerator(req);

// ── Tier 1: General reads ────────────────────────────────────────────────────
export const generalLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  max: 2000,
  skip: (req) => req.method === "OPTIONS",
  message: { message: "Too many requests, please try again later." },
});

// ── Tier 2: Write actions ────────────────────────────────────────────────────
export const writeLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  max: 300,
  keyGenerator: keyByUser,
  message: { message: "Too many requests, please slow down." },
});

// ── Tier 3: Call initiation ──────────────────────────────────────────────────
export const callLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  max: 30,
  keyGenerator: keyByUser,
  message: { message: "Too many call requests, please slow down." },
});

// ── Tier 4: Auth attempts ────────────────────────────────────────────────────
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  max: 20,
  message: { message: "Too many attempts, please try again later." },
});

// ── Tier 5: Payment checkout creation ───────────────────────────────────────
export const paymentLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  max: 10,
  message: { message: "Too many payment requests, please try again later." },
});
