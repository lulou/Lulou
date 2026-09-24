import { createHash, randomBytes } from "crypto";
import type { Express, Response, NextFunction } from "express";
import { z } from "zod";
import { supabaseAdmin, createUserClient } from "./supabase";
import { sendEmail, type SendEmailOpts, type EmailFailure } from "./emailService";
import { waitlistInviteEmail, waitlistVerifiedEmail, waitlistVerifyEmail } from "./emailTemplates";
import { publicWaitlistCount } from "./waitlistSocialProof";

const generic = { ok: true };
const waitlistSender = "Lulou <noreply@luloudating.com>";
const sendWaitlistEmail = (opts: Omit<SendEmailOpts, "from" | "replyTo">) =>
  sendEmail({ ...opts, from: waitlistSender, replyTo: "noreply@luloudating.com" });
const deliveryFailed = { code: "EMAIL_DELIVERY_FAILED", message: "We saved your place, but we couldn’t send the verification email. Please try again." };
const deliveryFailureResponse = (failure: EmailFailure | null) => ({ ...deliveryFailed, diagnostic: failure ?? { category: "RESEND_UNKNOWN" } });
const joinSchema = z.object({ firstName: z.string().trim().min(1).max(80), email: z.string().trim().email().max(254), city: z.string().trim().min(1).max(80), is18Plus: z.literal(true), referralCode: z.string().trim().max(32).optional() });
const eventSchema = z.object({ event: z.enum(["view", "form_started", "referral_copied"]) });
const normalizeEmail = (s: string) => s.trim().toLowerCase();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const origin = () => {
  const value = process.env.FRONTEND_URL;
  if (!value) throw new Error("FRONTEND_URL is required for waitlist emails");
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error("FRONTEND_URL must use HTTPS");
    return process.env.NODE_ENV === "production" ? "https://www.luloudating.com" : u.origin;
  } catch { throw new Error("FRONTEND_URL is invalid"); }
};
const limits = new Map<string, { count: number; until: number }>();
const emailCooldown = new Map<string, number>();
function canEmail(email: string) {
  const key = hash(email);
  const now = Date.now();
  if (emailCooldown.size > 5000) for (const [k, until] of emailCooldown) if (until < now) emailCooldown.delete(k);
  if ((emailCooldown.get(key) ?? 0) > now) return false;
  emailCooldown.set(key, now + 60_000);
  return true;
}
function releaseEmailCooldown(email: string) { emailCooldown.delete(hash(email)); }
function limiter(kind: string, max: number) {
  return (req: any, res: Response, next: NextFunction) => {
    const key = `${kind}:${String(req.ip || req.socket?.remoteAddress || "unknown")}`, now = Date.now();
    if (limits.size > 5000) for (const [k, v] of limits) if (v.until < now) limits.delete(k);
    const old = limits.get(key);
    if (!old || old.until < now) limits.set(key, { count: 1, until: now + 15 * 60_000 });
    else if (++old.count > max) return res.status(429).json({ message: "Too many requests. Please try again later." });
    next();
  };
}
async function admin(req: any, res: Response, next: NextFunction) {
  const allowed = (process.env.ADMIN_EMAIL || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length || !req.user?.email || !allowed.includes(String(req.user.email).toLowerCase())) return res.status(403).json({ message: "Admin access required" });
  const authorization = req.headers.authorization;
  if (!authorization) return res.status(403).json({ message: "Admin access required" });
  try {
    const signed = await createUserClient(authorization).rpc("waitlist_request_identity");
    const identity = signed.data as { id?: string; email?: string } | null;
    if (signed.error || !identity?.id || identity.id !== req.user.id ||
      !identity.email || identity.email.toLowerCase() !== String(req.user.email).toLowerCase() ||
      !allowed.includes(identity.email.toLowerCase())) return res.status(403).json({ message: "Admin access required" });
    next();
  } catch {
    return res.status(403).json({ message: "Admin access required" });
  }
}
function csvCell(value: unknown) { const s = String(value ?? ""); return `"${(/^\s*[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"`; }

export function registerWaitlistRoutes(app: Express, authenticated: any) {
  app.get("/api/waitlist/public-count", async (_req, res) => {
    try {
      // Verification, rather than row creation, is when someone joins the list.
      // The unique lower(email_normalized) index ensures one member per email.
      const { count, error } = await supabaseAdmin.from("early_access_waitlist")
        .select("id", { count: "exact", head: true })
        .not("email_verified_at", "is", null)
        .neq("status", "removed");
      if (error) throw error;
      const payload = publicWaitlistCount(count);
      res.set("Cache-Control", "public, max-age=30, s-maxage=60");
      return res.json(payload);
    } catch {
      res.set("Cache-Control", "no-store");
      return res.status(503).json({ visible: false });
    }
  });
  app.post("/api/waitlist/join", limiter("join", 8), async (req: any, res) => {
    const parsed = joinSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Please provide a name, email, city, and confirm you are 18 or older." });
    const { firstName, city } = parsed.data, email = normalizeEmail(parsed.data.email);
    try {
      origin(); // Fail before creating a lead if verification links cannot be built.
      let failure: EmailFailure | null = null;
      const onFailure = (value: EmailFailure) => { failure = value; };
      // Waitlist verification is independent of dating-account verification.
      // Never report success without saving the waitlist row or attempting mail.
      const existing = await supabaseAdmin.from("early_access_waitlist").select("id,email_verified_at,first_name,referral_code").eq("email_normalized", email).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) {
        if (!canEmail(email)) return res.json(generic);
        const delivered = existing.data.email_verified_at
          ? await sendWaitlistEmail({ to: email, subject: "You’re on the Lulou waitlist", html: waitlistVerifiedEmail(existing.data.first_name, `${origin()}/waitlist?r=${encodeURIComponent(existing.data.referral_code)}`), type: "waitlist_verified_resend", onFailure })
          : await sendVerification(email, existing.data.first_name, existing.data.id, onFailure);
        if (!delivered) { releaseEmailCooldown(email); return res.status(503).json(deliveryFailureResponse(failure)); }
        return res.json(generic);
      }
      let referredBy: string | null = null;
      if (parsed.data.referralCode) {
        const ref = await supabaseAdmin.from("early_access_waitlist").select("id,email_normalized").eq("referral_code", parsed.data.referralCode).not("email_verified_at", "is", null).maybeSingle();
        if (ref.error) throw new Error("referral lookup failed");
        referredBy = ref.data?.id && ref.data.email_normalized !== email ? ref.data.id : null;
      }
      const rawToken = randomBytes(32).toString("hex");
      const code = randomBytes(6).toString("base64url");
      const inserted = await supabaseAdmin.from("early_access_waitlist").insert({ first_name: firstName, email_normalized: email, city, is_18_plus: true, referral_code: code, referred_by: referredBy, email_verification_token_hash: hash(rawToken), email_verification_expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() }).select("id").single();
      if (inserted.error) {
        // A concurrent request won the case-insensitive unique-email race.
        if (inserted.error.code === "23505") return res.json(generic);
        throw inserted.error;
      }
      await supabaseAdmin.from("early_access_waitlist_events").insert({ waitlist_id: inserted.data.id, event: "submitted" });
      canEmail(email);
      if (!await sendVerification(email, firstName, rawToken, onFailure)) { releaseEmailCooldown(email); return res.status(503).json(deliveryFailureResponse(failure)); }
      return res.json(generic);
    } catch (e) { console.error("[WAITLIST_JOIN] request failed"); return res.status(500).json({ message: "Unable to join the waitlist right now." }); }
  });
  app.post("/api/waitlist/resend", limiter("resend", 5), async (req, res) => {
    const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
    if (!z.string().email().safeParse(email).success) return res.json(generic);
    try {
      let failure: EmailFailure | null = null;
      const onFailure = (value: EmailFailure) => { failure = value; };
      const row = await supabaseAdmin.from("early_access_waitlist").select("id,first_name,email_verified_at,referral_code").eq("email_normalized", email).maybeSingle();
      if (row.error) return res.status(503).json({ message: "Verification email is temporarily unavailable. Please try again." });
      if (!row.data) return res.json(generic);
      if (!canEmail(email)) return res.status(429).json({ message: "Please wait a minute before requesting another email." });
      const sent = row.data.email_verified_at
        ? await sendWaitlistEmail({ to: email, subject: "You’re on the Lulou waitlist", html: waitlistVerifiedEmail(row.data.first_name, `${origin()}/waitlist?r=${encodeURIComponent(row.data.referral_code)}`), type: "waitlist_verified_resend", onFailure })
        : await sendVerification(email, row.data.first_name, row.data.id, onFailure);
      if (!sent) { releaseEmailCooldown(email); return res.status(503).json(deliveryFailureResponse(failure)); }
    } catch {
      console.error("[WAITLIST_RESEND] request failed");
      return res.status(503).json({ message: "Verification email is temporarily unavailable. Please try again." });
    }
    res.json(generic);
  });
  app.post("/api/waitlist/verify", limiter("verify", 20), async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ message: "Invalid or expired verification link." });
    try { origin(); } catch { return res.status(503).json({ message: "Verification is temporarily unavailable." }); }
    const result = await supabaseAdmin.rpc("verify_early_access_waitlist", { p_token_hash: hash(token) });
    if (result.error) return res.status(503).json({ message: "Verification is temporarily unavailable." });
    if (!result.data?.[0]?.ok) return res.status(400).json({ message: "Invalid or expired verification link." });
    const row = result.data[0];
    const member = await supabaseAdmin.from("early_access_waitlist").select("email_normalized,first_name").eq("referral_code", row.referral_link_code).maybeSingle();
    if (member.data) {
      await sendWaitlistEmail({
        to: member.data.email_normalized,
        subject: "You’re on the Lulou waitlist",
        html: waitlistVerifiedEmail(member.data.first_name, `${origin()}/waitlist?r=${encodeURIComponent(row.referral_link_code)}`),
        type: "waitlist_verified",
      });
    }
    res.json({ ok: true, referralLink: `${origin()}/waitlist?r=${encodeURIComponent(row.referral_link_code)}`, city: row.city_name });
  });
  app.post("/api/waitlist/event", limiter("event", 60), async (req, res) => {
    const p = eventSchema.safeParse(req.body); if (!p.success) return res.status(400).json({ message: "Invalid event" });
    const saved = await supabaseAdmin.from("early_access_waitlist_events").insert({ event: p.data.event });
    if (saved.error) return res.status(503).json({ message: "Unable to record event" });
    res.json(generic);
  });
  app.get("/api/admin/waitlist/stats", authenticated, admin, async (_req, res) => {
    const { data, error } = await supabaseAdmin.rpc("early_access_waitlist_stats");
    if (error || !data) return res.status(500).json({ message: "Unable to load waitlist stats" });
    res.json(data);
  });
  app.get("/api/admin/waitlist/export", authenticated, admin, async (_req, res) => {
    const rows: any[] = []; for (let from = 0; ; from += 1000) {
      const q = await supabaseAdmin.from("early_access_waitlist").select("first_name,email_normalized,city,status,referral_count,created_at,email_verified_at,invited_at").range(from, from + 999);
      if (q.error) return res.status(500).json({ message: "Unable to export waitlist" });
      rows.push(...q.data); if (q.data.length < 1000) break;
    }
    const lines = ["firstName,email,city,status,referralCount,createdAt,verifiedAt,invitedAt", ...rows.map(x => [x.first_name,x.email_normalized,x.city,x.status,x.referral_count,x.created_at,x.email_verified_at,x.invited_at].map(csvCell).join(","))];
    res.type("text/csv").attachment("waitlist.csv").send(lines.join("\r\n"));
  });
  app.post("/api/admin/waitlist/invite", authenticated, admin, async (req, res) => {
    const city = req.body?.city, limit = Number(req.body?.limit);
    if (city !== "Sydney" || !Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ message: "city must be Sydney and limit must be 1-100" });
    try { origin(); } catch { return res.status(503).json({ message: "Invitations are temporarily unavailable." }); }
    const q = await supabaseAdmin.from("early_access_waitlist").select("id,email_normalized,first_name").eq("city", city).eq("status","waiting").not("email_verified_at","is",null).order("created_at").limit(limit);
    if (q.error) return res.status(500).json({ message: "Unable to invite waitlist members" });
    let invited = 0; for (const row of q.data) {
      const up = await supabaseAdmin.from("early_access_waitlist").update({ status:"invited", invited_at:new Date().toISOString(), updated_at:new Date().toISOString() }).eq("id",row.id).eq("status","waiting").select("id").maybeSingle();
      if (!up.data) continue;
      const delivered = await sendWaitlistEmail({ to: row.email_normalized, subject: "Your Lulou access is ready", html: waitlistInviteEmail(row.first_name, `${origin()}/?mode=signup`), type: "waitlist_invite" });
      if (delivered) { invited++; await supabaseAdmin.from("early_access_waitlist_events").insert({ waitlist_id: row.id, event:"invited" }); }
      else await supabaseAdmin.from("early_access_waitlist").update({ status:"waiting", invited_at:null, updated_at:new Date().toISOString() }).eq("id",row.id).eq("status","invited");
    }
    res.json({ ok:true, invited });
  });
}

/** Called after a successful profile upsert; never changes profile state. */
export async function markWaitlistJoinedApp(email: string | undefined) {
  if (!email) return;
  const normalized = normalizeEmail(email);
  const claimed = await supabaseAdmin.from("early_access_waitlist")
    .update({ status: "joined", joined_app_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("email_normalized", normalized).eq("status", "invited").is("joined_app_at", null)
    .select("id").maybeSingle();
  if (claimed.error || !claimed.data) return;
  await supabaseAdmin.from("early_access_waitlist_events").insert({ waitlist_id: claimed.data.id, event: "joined_app" });
}
async function sendVerification(to: string, firstName: string, tokenOrId: string, onFailure?: (failure: EmailFailure) => void) {
  let token = tokenOrId;
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    token = randomBytes(32).toString("hex");
    const updated = await supabaseAdmin.from("early_access_waitlist").update({ email_verification_token_hash: hash(token), email_verification_expires_at: new Date(Date.now()+86400000).toISOString() }).eq("id", tokenOrId);
    if (updated.error) { console.error("[WAITLIST_EMAIL] token refresh failed"); onFailure?.({ category: "TOKEN_REFRESH_FAILED" }); return false; }
  }
  return sendWaitlistEmail({ to, subject: "Confirm your Lulou early access", html: waitlistVerifyEmail(firstName, `${origin()}/waitlist/verify?token=${encodeURIComponent(token)}`), type: "waitlist_verify", onFailure });
}