/**
 * adminSimulator.ts
 *
 * Admin-only payment testing system for Lulou.
 * Simulates the full purchase → entitlement → email → refund lifecycle
 * without touching Stripe, charging cards, or affecting real payment records.
 *
 * All simulated IDs are prefixed:
 *   sim_session_  — replaces Stripe Checkout Session ID
 *   sim_refund_   — replaces Stripe Refund ID
 *
 * Idempotency uses the same processed_stripe_sessions table as real purchases,
 * so sim_session_ rows are permanent audit records and can never be re-granted.
 */

import type { Express, Request, Response } from "express";
import { db } from "./db";
import { eq, desc } from "drizzle-orm";
import {
  adminPaymentSimulations,
  processedStripeSessions,
} from "@shared/schema";
import {
  EXTRAS_ITEMS,
  ELEVATE_PACKS,
  grantExtras,
  grantElevate,
  isUniqueViolation,
  type ExtrasItemId,
  type ElevatePackId,
} from "./purchaseItems";
import { supabaseAdmin } from "./supabase";
import { sendEmail } from "./emailService";
import {
  purchaseConfirmationEmail,
  haloPurchaseEmail,
  elevatePurchaseEmail,
  refundConfirmationEmail,
} from "./emailTemplates";
import { sendPushToUser, buildPush } from "./pushService";

// ── Admin guard ────────────────────────────────────────────────────────────────

function checkAdmin(req: Request, res: Response): boolean {
  const adminEmails = (process.env.ADMIN_EMAIL ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const isDev = process.env.NODE_ENV !== "production";
  const requestEmail = (req as any).user?.email ?? "";
  const isAdmin =
    adminEmails.includes(requestEmail) || (isDev && adminEmails.length === 0);
  if (!isAdmin) {
    res
      .status(403)
      .json({ message: "Admin access required. Set ADMIN_EMAIL env var." });
    return false;
  }
  return true;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

interface UserInfo {
  email: string | null;
  firstName: string | null;
}

async function getUserInfo(userId: string): Promise<UserInfo> {
  try {
    const [authResult, profileResult] = await Promise.all([
      supabaseAdmin.auth.admin.getUserById(userId),
      supabaseAdmin
        .from("profiles")
        .select("firstName")
        .eq("userId", userId)
        .single(),
    ]);
    return {
      email: authResult.data?.user?.email ?? null,
      firstName: (profileResult.data as any)?.firstName ?? null,
    };
  } catch (err: any) {
    console.warn(
      `[ADMIN_SIM] getUserInfo failed for ${userId.slice(0, 8)}: ${err?.message}`
    );
    return { email: null, firstName: null };
  }
}

function formatAmount(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function genId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}${ts}_${rand}`;
}

function getProductDetails(
  itemId?: string,
  packId?: string
): { productName: string; amountCents: number } {
  if (itemId && EXTRAS_ITEMS[itemId as ExtrasItemId]) {
    const item = EXTRAS_ITEMS[itemId as ExtrasItemId];
    return { productName: item.name, amountCents: item.unitAmount };
  }
  if (packId && ELEVATE_PACKS[packId as ElevatePackId]) {
    const pack = ELEVATE_PACKS[packId as ElevatePackId];
    return { productName: pack.label, amountCents: pack.unitAmount };
  }
  return { productName: "Unknown Product", amountCents: 0 };
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerAdminSimulatorRoutes(
  app: Express,
  isAuthenticated: (req: Request, res: Response, next: () => void) => void
): void {
  // ── GET /api/admin/payment-sim/users ────────────────────────────────────────
  // Lists Lulou users (email + firstName) for the target-user selector.
  // Uses Supabase Admin API — limited to 100 users.

  app.get(
    "/api/admin/payment-sim/users",
    isAuthenticated,
    async (req: Request, res: Response) => {
      if (!checkAdmin(req, res)) return;
      try {
        const { data, error } = await supabaseAdmin.auth.admin.listUsers({
          page: 1,
          perPage: 100,
        });
        if (error) throw error;

        const userIds = data.users.map((u) => u.id);
        let firstNameMap: Record<string, string> = {};
        if (userIds.length > 0) {
          const { data: profiles } = await supabaseAdmin
            .from("profiles")
            .select("userId, firstName")
            .in("userId", userIds);
          if (profiles) {
            for (const p of profiles as any[]) {
              firstNameMap[p.userId] = p.firstName;
            }
          }
        }

        const users = data.users.map((u) => ({
          userId: u.id,
          email: u.email ?? "",
          firstName: firstNameMap[u.id] ?? "",
          createdAt: u.created_at,
        }));

        res.json({ users });
      } catch (err: any) {
        console.error("[ADMIN_SIM] listUsers failed:", err?.message);
        res.status(500).json({ message: err?.message ?? "Failed to list users" });
      }
    }
  );

  // ── GET /api/admin/payment-sim/logs ─────────────────────────────────────────
  // Returns the 50 most recent simulations.

  app.get(
    "/api/admin/payment-sim/logs",
    isAuthenticated,
    async (req: Request, res: Response) => {
      if (!checkAdmin(req, res)) return;
      try {
        const rows = await db
          .select()
          .from(adminPaymentSimulations)
          .orderBy(desc(adminPaymentSimulations.createdAt))
          .limit(50);
        res.json({ simulations: rows });
      } catch (err: any) {
        res.status(500).json({ message: err?.message ?? "DB error" });
      }
    }
  );

  // ── POST /api/admin/payment-sim/purchase ────────────────────────────────────
  // Simulates a successful purchase for any Lulou product.
  // Body: { targetUserId: string; itemId?: string; packId?: string }

  app.post(
    "/api/admin/payment-sim/purchase",
    isAuthenticated,
    async (req: Request, res: Response) => {
      if (!checkAdmin(req, res)) return;

      const adminUserId = (req as any).user?.id ?? "unknown";
      const adminEmail = (req as any).user?.email ?? "unknown";
      const { targetUserId, itemId, packId } = req.body as {
        targetUserId: string;
        itemId?: string;
        packId?: string;
      };

      if (!targetUserId) {
        return res.status(400).json({ message: "targetUserId is required" });
      }
      if (!itemId && !packId) {
        return res
          .status(400)
          .json({ message: "itemId or packId is required" });
      }
      if (itemId && !EXTRAS_ITEMS[itemId as ExtrasItemId]) {
        return res.status(400).json({ message: `Unknown itemId: ${itemId}` });
      }
      if (packId && !ELEVATE_PACKS[packId as ElevatePackId]) {
        return res.status(400).json({ message: `Unknown packId: ${packId}` });
      }

      const simSessionId = genId("sim_session_");
      const { productName, amountCents } = getProductDetails(itemId, packId);
      const currency = "aud";

      console.log(
        `[ADMIN_SIM] PURCHASE_START admin=${adminEmail} target=${targetUserId.slice(0, 8)} product=${productName} simSession=${simSessionId}`
      );

      // ── Claim idempotency slot ─────────────────────────────────────────────
      let grantedTypes: string[] = [];
      let grantError: string | undefined;
      try {
        await db.insert(processedStripeSessions).values({
          sessionId: simSessionId,
          userId: targetUserId,
          itemRef: itemId ?? packId ?? "sim",
        });
      } catch (err: any) {
        if (isUniqueViolation(err)) {
          return res
            .status(409)
            .json({ message: "This simulation session ID already exists." });
        }
        return res
          .status(500)
          .json({ message: `Idempotency insert failed: ${err?.message}` });
      }

      // ── Grant entitlement ──────────────────────────────────────────────────
      try {
        if (itemId && EXTRAS_ITEMS[itemId as ExtrasItemId]) {
          grantedTypes = await grantExtras(
            targetUserId,
            simSessionId,
            itemId as ExtrasItemId,
            {}
          );
        } else if (packId && ELEVATE_PACKS[packId as ElevatePackId]) {
          const result = await grantElevate(targetUserId, packId as ElevatePackId);
          grantedTypes = result.grantedTypes;
        }
        console.log(
          `[ADMIN_SIM] ENTITLEMENT_GRANTED admin=${adminEmail} target=${targetUserId.slice(0, 8)} product=${productName} granted=${grantedTypes.join(", ")}`
        );
      } catch (err: any) {
        grantError = err?.message ?? "Grant failed";
        console.error(
          `[ADMIN_SIM] GRANT_FAILED simSession=${simSessionId}:`,
          grantError
        );
        try {
          await db
            .delete(processedStripeSessions)
            .where(eq(processedStripeSessions.sessionId, simSessionId));
        } catch {}
        await db.insert(adminPaymentSimulations).values({
          simSessionId,
          adminUserId,
          targetUserId,
          itemId: itemId ?? null,
          packId: packId ?? null,
          productName,
          amountCents,
          currency,
          status: "grant_failed",
          grantResult: null,
          purchaseEmailSent: false,
          errorLog: grantError,
        });
        return res.status(500).json({ message: `Grant failed: ${grantError}` });
      }

      // ── Send purchase confirmation email ───────────────────────────────────
      let purchaseEmailSent = false;
      let emailError: string | undefined;
      try {
        const info = await getUserInfo(targetUserId);
        if (info.email) {
          const firstName = info.firstName ?? "there";
          const amount = formatAmount(amountCents, currency);
          let subject: string;
          let html: string;

          const sparksItem = itemId?.startsWith("sparks-")
            ? EXTRAS_ITEMS[itemId as ExtrasItemId]
            : null;

          if (sparksItem) {
            const qty = sparksItem.quantity;
            subject =
              qty === 1
                ? "Your Halo is ready to send ✨"
                : `Your ${qty} Halos are ready to send ✨`;
            html = haloPurchaseEmail(firstName, qty, amount, simSessionId);
          } else if (
            packId &&
            ELEVATE_PACKS[packId as ElevatePackId]
          ) {
            const pack = ELEVATE_PACKS[packId as ElevatePackId];
            const isSuper = pack.type === "super_elevate";
            subject = isSuper
              ? "Your Super Elevate is ready 🚀"
              : "Your Elevate boost is ready ✨";
            html = elevatePurchaseEmail(
              firstName,
              pack.label,
              amount,
              simSessionId,
              isSuper
            );
          } else {
            subject = `Your ${productName} purchase is confirmed ❤️`;
            html = purchaseConfirmationEmail(
              firstName,
              productName,
              amount,
              simSessionId
            );
          }

          purchaseEmailSent = await sendEmail({
            to: info.email,
            subject,
            html,
            type: `sim_purchase_${itemId ?? packId ?? "generic"}`,
          });
          console.log(
            `[ADMIN_SIM] PURCHASE_EMAIL_${purchaseEmailSent ? "SENT" : "FAILED"} simSession=${simSessionId} to=${info.email.slice(0, 4)}***`
          );

          // Push notification (fire-and-forget)
          if (sparksItem) {
            sendPushToUser(targetUserId, buildPush.halo(sparksItem.quantity), "halo").catch(() => {});
          } else if (packId && ELEVATE_PACKS[packId as ElevatePackId]) {
            const pack = ELEVATE_PACKS[packId as ElevatePackId];
            sendPushToUser(targetUserId, buildPush.elevate(pack.label), "elevate").catch(() => {});
          } else {
            sendPushToUser(targetUserId, buildPush.payment(productName), "payment").catch(() => {});
          }
        } else {
          emailError = "No email address found for target user";
          console.warn(`[ADMIN_SIM] PURCHASE_EMAIL_SKIP: ${emailError}`);
        }
      } catch (err: any) {
        emailError = err?.message ?? "Email error";
        console.error(`[ADMIN_SIM] PURCHASE_EMAIL_ERROR simSession=${simSessionId}:`, emailError);
      }

      // ── Persist simulation record ──────────────────────────────────────────
      const [simRecord] = await db
        .insert(adminPaymentSimulations)
        .values({
          simSessionId,
          adminUserId,
          targetUserId,
          itemId: itemId ?? null,
          packId: packId ?? null,
          productName,
          amountCents,
          currency,
          status: "granted",
          grantResult: JSON.stringify(grantedTypes),
          purchaseEmailSent,
          errorLog: emailError ?? null,
        })
        .returning();

      console.log(
        `[ADMIN_SIM] PURCHASE_COMPLETE admin=${adminEmail} target=${targetUserId.slice(0, 8)} simSession=${simSessionId} emailSent=${purchaseEmailSent}`
      );

      res.json({ simulation: simRecord });
    }
  );

  // ── POST /api/admin/payment-sim/refund ──────────────────────────────────────
  // Simulates a refund for a previous simulation.
  // Body: { simSessionId: string }
  // Idempotent — re-posting the same simSessionId will not send a second email.

  app.post(
    "/api/admin/payment-sim/refund",
    isAuthenticated,
    async (req: Request, res: Response) => {
      if (!checkAdmin(req, res)) return;

      const adminEmail = (req as any).user?.email ?? "unknown";
      const { simSessionId } = req.body as { simSessionId: string };

      if (!simSessionId) {
        return res.status(400).json({ message: "simSessionId is required" });
      }

      // Load simulation record
      const [sim] = await db
        .select()
        .from(adminPaymentSimulations)
        .where(eq(adminPaymentSimulations.simSessionId, simSessionId));

      if (!sim) {
        return res
          .status(404)
          .json({ message: `Simulation ${simSessionId} not found` });
      }
      if (sim.status === "grant_failed") {
        return res
          .status(400)
          .json({ message: "Cannot refund a simulation that failed to grant." });
      }

      // Assign or reuse sim_refund_ ID
      const refundSimId = sim.refundSimId ?? genId("sim_refund_");

      console.log(
        `[ADMIN_SIM] REFUND_START admin=${adminEmail} simSession=${simSessionId} refundId=${refundSimId}`
      );

      // ── Idempotency guard for refund email ─────────────────────────────────
      const idempotencyKey = `refund_email_${refundSimId}`;
      let refundEmailSent = false;
      let alreadySent = false;
      let emailError: string | undefined;

      try {
        await db.insert(processedStripeSessions).values({
          sessionId: idempotencyKey,
          userId: "sim_refund",
          itemRef: refundSimId,
        });
      } catch (err: any) {
        if (isUniqueViolation(err)) {
          alreadySent = true;
          console.log(
            `[ADMIN_SIM] REFUND_EMAIL_IDEMPOTENT: already sent for refundId=${refundSimId} — skipping duplicate`
          );
        } else {
          return res
            .status(500)
            .json({ message: `Idempotency insert failed: ${err?.message}` });
        }
      }

      // ── Send refund email (skip if idempotent duplicate) ───────────────────
      if (!alreadySent) {
        try {
          const info = await getUserInfo(sim.targetUserId);
          if (info.email) {
            const firstName = info.firstName ?? "there";
            const amount = formatAmount(sim.amountCents, sim.currency);
            refundEmailSent = await sendEmail({
              to: info.email,
              subject: "Your Lulou refund has been processed ❤️",
              html: refundConfirmationEmail(
                firstName,
                amount,
                sim.productName,
                refundSimId
              ),
              type: "sim_refund_confirmation",
            });
            console.log(
              `[ADMIN_SIM] REFUND_EMAIL_${refundEmailSent ? "SENT" : "FAILED"} refundId=${refundSimId} to=${info.email.slice(0, 4)}***`
            );
            // Push notification
            sendPushToUser(
              sim.targetUserId,
              buildPush.refund(amount),
              "payment"
            ).catch(() => {});
          } else {
            emailError = "No email address found for target user";
            console.warn(`[ADMIN_SIM] REFUND_EMAIL_SKIP: ${emailError}`);
          }
        } catch (err: any) {
          emailError = err?.message ?? "Email error";
          console.error(
            `[ADMIN_SIM] REFUND_EMAIL_ERROR refundId=${refundSimId}:`,
            emailError
          );
        }
      }

      // ── Update simulation record ───────────────────────────────────────────
      const [updated] = await db
        .update(adminPaymentSimulations)
        .set({
          status: "refunded",
          refundSimId,
          refundEmailSent: alreadySent ? (sim.refundEmailSent ?? false) : refundEmailSent,
          refundedAt: sim.refundedAt ?? new Date(),
          errorLog: emailError
            ? `${sim.errorLog ?? ""}; refund: ${emailError}`.replace(/^; /, "")
            : sim.errorLog,
        })
        .where(eq(adminPaymentSimulations.simSessionId, simSessionId))
        .returning();

      console.log(
        `[ADMIN_SIM] REFUND_COMPLETE admin=${adminEmail} simSession=${simSessionId} refundId=${refundSimId} emailSent=${refundEmailSent} duplicate=${alreadySent}`
      );

      res.json({
        simulation: updated,
        idempotentSkip: alreadySent,
      });
    }
  );
}
