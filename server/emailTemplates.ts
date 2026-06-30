/**
 * emailTemplates.ts
 *
 * All Lulou transactional email templates.
 *
 * Design tokens (matches email-template-verification.html):
 *   bg:          #f5eeeb  — warm cream
 *   card:        #ffffff  with border-radius:24px
 *   header-bg:   linear-gradient(160deg,#fdf4f5,#fff8f9)
 *   primary:     linear-gradient(135deg,#e06272,#b83858)
 *   brand-label: #bc4e60
 *   heading:     Georgia serif, #1a0a0e
 *   body:        #5a3040
 *   muted:       #8a5a68
 *   footer-bg:   #fdf6f7
 */

const BRAND_LABEL_STYLE =
  'font-size:10px;font-weight:800;letter-spacing:0.30em;text-transform:uppercase;color:#bc4e60;line-height:1;margin:0 0 8px;';
const HEADING_STYLE =
  'margin:0 0 10px;font-family:Georgia,"Times New Roman",serif;font-size:32px;font-weight:700;letter-spacing:-0.02em;line-height:1.15;color:#1a0a0e;';
const SUBHEADING_STYLE =
  'margin:0;font-size:15px;color:#8a5a68;font-style:italic;letter-spacing:0.03em;';
const BODY_STYLE =
  'margin:0 0 16px;font-size:16px;color:#3d1a22;line-height:1.6;';
const MUTED_STYLE =
  'margin:0 0 30px;font-size:16px;color:#5a3040;line-height:1.75;';
const DIVIDER =
  `<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr><td style="height:1px;background:linear-gradient(90deg,transparent,rgba(188,78,96,0.18),transparent);"></td></tr>
  </table>`;

// ── Shared layout wrapper ─────────────────────────────────────────────────────

function layout(headerTitle: string, headerSubtitle: string, body: string, footerExtra?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${headerTitle} — Lulou</title>
</head>
<body style="margin:0;padding:0;background-color:#f5eeeb;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5eeeb;padding:48px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

          <!-- Logo mark -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <div style="display:inline-block;width:52px;height:52px;background:linear-gradient(135deg,#e06272 0%,#b83858 100%);border-radius:14px;line-height:52px;text-align:center;font-size:26px;">🌸</div>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 4px 40px rgba(0,0,0,0.08);">

              <!-- Card header -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background:linear-gradient(160deg,#fdf4f5 0%,#fff8f9 100%);padding:40px 40px 32px;">
                    <p style="${BRAND_LABEL_STYLE}">Lulou Dating</p>
                    <h1 style="${HEADING_STYLE}">${headerTitle}</h1>
                    <p style="${SUBHEADING_STYLE}">${headerSubtitle}</p>
                  </td>
                </tr>
              </table>

              <!-- Card body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:32px 40px 32px;">
                    ${body}
                  </td>
                </tr>
              </table>

              <!-- Card footer -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#fdf6f7;padding:22px 40px;border-top:1px solid #f0e2e6;">
                    ${footerExtra ? `<p style="margin:0 0 12px;font-size:13px;color:#9c6070;text-align:center;">${footerExtra}</p>` : ""}
                    <p style="margin:0 0 5px;font-size:13px;color:#9c6070;text-align:center;">
                      Questions? <a href="mailto:support@lulou.app" style="color:#bc4e60;text-decoration:none;font-weight:700;">support@lulou.app</a>
                    </p>
                    <p style="margin:0 0 8px;font-size:12px;color:#c49aaa;text-align:center;">© 2025 Lulou Dating. All rights reserved.</p>
                    <p style="margin:0;font-size:11px;color:#d4b0bb;text-align:center;line-height:1.6;">
                      <a href="https://lulou.app" style="color:#d4b0bb;text-decoration:none;">lulou.app</a>
                      &nbsp;·&nbsp;
                      <a href="https://lulou.app/privacy" style="color:#d4b0bb;text-decoration:none;">Privacy Policy</a>
                      &nbsp;·&nbsp;
                      <a href="https://lulou.app/terms" style="color:#d4b0bb;text-decoration:none;">Terms of Service</a>
                    </p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Button helper ─────────────────────────────────────────────────────────────

function ctaButton(label: string, href: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:8px 0 32px;">
        <a href="${href}" style="display:inline-block;padding:17px 52px;background:linear-gradient(135deg,#e06272 0%,#b83858 100%);color:#ffffff;font-size:13px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;text-decoration:none;border-radius:50px;box-shadow:0 8px 28px rgba(184,56,80,0.38);">
          ${label}
        </a>
      </td>
    </tr>
  </table>`;
}

// ── Info row helper (label + value) ──────────────────────────────────────────

function infoRow(label: string, value: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
    <tr>
      <td style="font-size:11px;font-weight:800;letter-spacing:0.20em;text-transform:uppercase;color:#bc4e60;padding-bottom:3px;">${label}</td>
    </tr>
    <tr>
      <td style="font-size:16px;font-weight:600;color:#1a0a0e;padding-bottom:4px;">${value}</td>
    </tr>
    <tr>
      <td style="height:1px;background:rgba(188,78,96,0.10);"></td>
    </tr>
  </table>`;
}

// ── Check row helper (benefit list) ──────────────────────────────────────────

function checkRow(strong: string, detail: string): string {
  return `<table cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
    <tr>
      <td style="width:28px;vertical-align:top;padding-top:1px;">
        <span style="display:inline-block;width:20px;height:20px;background:linear-gradient(135deg,#e06272,#b83858);border-radius:50%;text-align:center;line-height:20px;font-size:11px;color:#ffffff;font-weight:700;">✓</span>
      </td>
      <td style="font-size:14px;color:#5a3040;line-height:1.55;padding-left:10px;">
        <strong style="font-weight:600;color:#3d1a22;">${strong}</strong>${detail ? " — " + detail : ""}
      </td>
    </tr>
  </table>`;
}

// ── Amount pill ───────────────────────────────────────────────────────────────

function amountPill(amount: string, label?: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td align="center">
        <div style="display:inline-block;background:linear-gradient(135deg,#e06272 0%,#b83858 100%);border-radius:16px;padding:20px 48px;text-align:center;">
          ${label ? `<p style="margin:0 0 4px;font-size:10px;font-weight:800;letter-spacing:0.25em;text-transform:uppercase;color:rgba(255,255,255,0.80);">${label}</p>` : ""}
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">${amount}</p>
        </div>
      </td>
    </tr>
  </table>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Welcome to Lulou
// ─────────────────────────────────────────────────────────────────────────────

export function welcomeEmail(firstName: string): string {
  const body = `
    <p style="${BODY_STYLE}">Hi ${firstName},</p>
    <p style="${MUTED_STYLE}">
      Welcome to Lulou — where real connections flourish. We're so glad you're here.
      Your profile is live and you're ready to start discovering people who are genuinely
      looking for something meaningful.
    </p>
    ${ctaButton("Start Exploring", "https://lulou.app")}
    ${DIVIDER}
    ${checkRow("Verified profiles only", "every member is real")}
    ${checkRow("No games, no ghosting", "structured conversations that matter")}
    ${checkRow("Genuine intentions", "people here are looking for something real")}
    ${checkRow("Your privacy protected", "we never share your data")}
  `;
  return layout("Welcome to Lulou", "Be heard. Be seen.", body);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Email Verification (OTP version — sent via our own flow)
// ─────────────────────────────────────────────────────────────────────────────

export function emailVerificationEmail(firstName: string, otp: string): string {
  const body = `
    <p style="${BODY_STYLE}">Hi ${firstName || "there"},</p>
    <p style="${MUTED_STYLE}">
      Thank you for joining Lulou. Please use the verification code below to confirm
      your email address and begin building meaningful connections.
    </p>

    <!-- OTP box -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td align="center">
          <div style="display:inline-block;background:linear-gradient(160deg,#fdf4f5,#fff8f9);border:2px solid rgba(188,78,96,0.25);border-radius:16px;padding:24px 48px;text-align:center;">
            <p style="margin:0 0 6px;font-size:10px;font-weight:800;letter-spacing:0.25em;text-transform:uppercase;color:#bc4e60;">Verification Code</p>
            <p style="margin:0;font-family:'Courier New',monospace;font-size:40px;font-weight:700;letter-spacing:0.20em;color:#1a0a0e;">${otp}</p>
          </div>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 24px;font-size:14px;color:#8a5a68;text-align:center;line-height:1.6;">
      This code expires in 10 minutes. If you didn't create a Lulou account, you can safely ignore this email.
    </p>
    ${DIVIDER}
    ${checkRow("Verified profiles only", "every member is real")}
    ${checkRow("No games, no ghosting", "structured conversations that matter")}
    ${checkRow("Genuine intentions", "people here are looking for something real")}
  `;
  return layout("Verify Your Email", "One step to go.", body);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Password Reset
// ─────────────────────────────────────────────────────────────────────────────

export function passwordResetEmail(firstName: string, resetUrl: string): string {
  const body = `
    <p style="${BODY_STYLE}">Hi ${firstName || "there"},</p>
    <p style="${MUTED_STYLE}">
      We received a request to reset the password for your Lulou account.
      Click the button below to choose a new password. This link expires in 1 hour.
    </p>
    ${ctaButton("Reset My Password", resetUrl)}
    <p style="margin:0 0 16px;font-size:13px;color:#8a5a68;text-align:center;line-height:1.6;">
      If you didn't request a password reset, you can safely ignore this email.
      Your password will remain unchanged.
    </p>
    ${DIVIDER}
    <p style="margin:0;font-size:12px;color:#c49aaa;text-align:center;">
      For security, this link can only be used once and expires in 1 hour.
    </p>
  `;
  return layout("Reset Your Password", "Happens to everyone.", body, "If the button doesn't work, copy this link into your browser: " + resetUrl);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Purchase Confirmation (generic)
// ─────────────────────────────────────────────────────────────────────────────

export function purchaseConfirmationEmail(
  firstName: string,
  productName: string,
  amount: string,
  orderId: string,
): string {
  const body = `
    <p style="${BODY_STYLE}">Hi ${firstName},</p>
    <p style="${MUTED_STYLE}">
      Your payment was successful. Your new feature is ready to use right now — enjoy it.
    </p>
    ${amountPill(amount, "Amount Paid")}
    ${infoRow("Purchase", productName)}
    ${infoRow("Order Reference", orderId)}
    <p style="margin:24px 0 0;font-size:14px;color:#8a5a68;line-height:1.6;">
      A receipt has been sent by Stripe to your payment email. If you have any
      questions about this purchase, reply to this email and we'll help right away.
    </p>
    ${DIVIDER}
    ${ctaButton("Open Lulou", "https://lulou.app")}
  `;
  return layout("Purchase Confirmed", "Thank you for your support.", body);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Halo / Spark Purchase Confirmation
// ─────────────────────────────────────────────────────────────────────────────

export function haloPurchaseEmail(
  firstName: string,
  quantity: number,
  amount: string,
  orderId: string,
): string {
  const plural = quantity === 1 ? "Halo" : "Halos";
  const body = `
    <p style="${BODY_STYLE}">Hi ${firstName},</p>
    <p style="${MUTED_STYLE}">
      You've got ${quantity} new ${plural}! Head to the Intention Wheel and spin
      to send a Halo to someone who catches your eye — it's a warm, intentional signal
      that you'd love to connect.
    </p>
    ${amountPill(amount, `${quantity} ${plural} Purchased`)}
    ${infoRow("Item", `${quantity} ${plural}`)}
    ${infoRow("Order Reference", orderId)}
    ${DIVIDER}
    <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#3d1a22;">How Halos work</p>
    ${checkRow("Spin the Intention Wheel", "discover who's out there")}
    ${checkRow("Send a Halo", "a warm signal that you'd love to connect")}
    ${checkRow("Start a real conversation", "if they send one back, it's a match")}
    ${ctaButton("Spin the Wheel", "https://lulou.app/intent")}
  `;
  return layout(`${quantity} ${plural} Ready`, "Your Intention Wheel awaits.", body);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Elevate Purchase Confirmation
// ─────────────────────────────────────────────────────────────────────────────

export function elevatePurchaseEmail(
  firstName: string,
  packLabel: string,
  amount: string,
  orderId: string,
  isSuper: boolean,
): string {
  const duration = isSuper ? "60 minutes" : "30 minutes";
  const body = `
    <p style="${BODY_STYLE}">Hi ${firstName},</p>
    <p style="${MUTED_STYLE}">
      Your ${isSuper ? "Super Elevate" : "Elevate"} boost is ready. Activate it whenever you want
      and your profile will rise to the top of the discovery queue for ${duration},
      dramatically increasing who sees you.
    </p>
    ${amountPill(amount, `${packLabel} Purchased`)}
    ${infoRow("Pack", packLabel)}
    ${infoRow("Boost Duration", duration)}
    ${infoRow("Order Reference", orderId)}
    ${DIVIDER}
    <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#3d1a22;">How Elevate works</p>
    ${checkRow("Activate when you're ready", "your boost starts the moment you tap")}
    ${checkRow("Rise to the top", `featured for ${duration} in the discovery queue`)}
    ${checkRow("More visibility = more matches", "real people, genuine interest")}
    ${ctaButton("Activate My Boost", "https://lulou.app/likes")}
  `;
  return layout(
    isSuper ? "Super Elevate Ready" : "Elevate Ready",
    "Your profile is about to shine.",
    body,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Subscription Confirmation (Lulou Membership)
// ─────────────────────────────────────────────────────────────────────────────

export function subscriptionConfirmationEmail(
  firstName: string,
  amount: string,
  nextBillingDate: string,
  orderId: string,
): string {
  const body = `
    <p style="${BODY_STYLE}">Hi ${firstName},</p>
    <p style="${MUTED_STYLE}">
      Welcome to Lulou Membership — the full experience, unlocked. Your membership is
      now active and everything below is available in your account right now.
    </p>
    ${amountPill(amount, "Monthly Membership")}
    ${infoRow("Plan", "Lulou Membership (Monthly)")}
    ${infoRow("Next Billing Date", nextBillingDate)}
    ${infoRow("Order Reference", orderId)}
    ${DIVIDER}
    <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#3d1a22;">What's included</p>
    ${checkRow("+5 Extra Messages", "per month")}
    ${checkRow("Undo Last Pass", "take back an accidental skip")}
    ${checkRow("3 Extra Phone Calls", "go deeper before meeting")}
    ${checkRow("1 Video Call", "see each other before meeting")}
    ${ctaButton("Open Lulou", "https://lulou.app")}
    <p style="margin:24px 0 0;font-size:13px;color:#8a5a68;text-align:center;line-height:1.6;">
      To manage or cancel your membership, go to Profile → Settings → Membership.
    </p>
  `;
  return layout("Membership Active", "Welcome to the full Lulou experience.", body);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Subscription Cancellation
// ─────────────────────────────────────────────────────────────────────────────

export function subscriptionCancellationEmail(
  firstName: string,
  endDate: string,
): string {
  const body = `
    <p style="${BODY_STYLE}">Hi ${firstName},</p>
    <p style="${MUTED_STYLE}">
      Your Lulou Membership has been cancelled. You'll continue to have access to all
      membership benefits until the end of your current billing period.
    </p>
    ${DIVIDER}
    ${infoRow("Membership Access Until", endDate)}
    ${infoRow("Status After That Date", "Free plan")}
    ${DIVIDER}
    <p style="margin:0 0 24px;font-size:15px;color:#5a3040;line-height:1.75;">
      Any credits and benefits you've already received are yours to keep — we don't
      take anything back.
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#5a3040;line-height:1.75;">
      If you cancelled by mistake, you can reactivate at any time from your profile settings.
    </p>
    ${ctaButton("Reactivate Membership", "https://lulou.app/profile")}
    <p style="margin:24px 0 0;font-size:13px;color:#8a5a68;text-align:center;line-height:1.6;">
      If you have any questions, just reply to this email and we'll help.
    </p>
  `;
  return layout("Membership Cancelled", "We hope to see you again soon.", body);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Refund Confirmation
// ─────────────────────────────────────────────────────────────────────────────

export function refundConfirmationEmail(
  firstName: string,
  amount: string,
  productName: string,
  refundId: string,
): string {
  const body = `
    <p style="${BODY_STYLE}">Hi ${firstName},</p>
    <p style="${MUTED_STYLE}">
      We've successfully processed your refund. The amount will be returned to
      your original payment method within 2–10 business days, depending on your bank.
    </p>
    ${amountPill(amount, "Refund Amount")}
    ${infoRow("Purchase", productName)}
    ${infoRow("Refund ID", refundId)}
    ${DIVIDER}
    <p style="margin:0 0 24px;font-size:15px;color:#5a3040;line-height:1.75;">
      The refund has been issued back to your original payment method. Depending on
      your bank, it may take <strong style="color:#3d1a22;">2–10 business days</strong> to appear on your statement.
    </p>
    <p style="margin:0 0 0;font-size:15px;color:#5a3040;line-height:1.75;">
      If you requested this refund by mistake or have any questions, simply reply to
      this email and our team will help right away.
    </p>
    ${DIVIDER}
    <p style="margin:0;font-size:15px;color:#5a3040;line-height:1.75;font-style:italic;">
      Thank you for being part of Lulou. — <strong style="color:#3d1a22;">The Lulou Team</strong>
    </p>
  `;
  return layout(
    "Refund Processed ❤️",
    "Your refund is on its way.",
    body,
    "Reply to this email if you have any questions.",
  );
}
