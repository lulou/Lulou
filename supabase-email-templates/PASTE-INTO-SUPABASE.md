# Lulou — Supabase Email Templates

Six premium HTML email templates to paste directly into the Supabase dashboard.

---

## Logo asset

| Property | Value |
|---|---|
| Original source | `client/public/icon-192.png` (the real Lulou app icon) |
| Copied to | `client/public/lulou-email-logo.png` |
| Filename | `lulou-email-logo.png` |
| Dimensions | 192 × 192 px |
| File size | ~65 KB |
| Production HTTPS URL | `https://www.luloudating.com/lulou-email-logo.png` |
| Rendered size in email | 80 × 80 px (retina-crisp at 192 px source) |

> **⚠️ The public asset must stay deployed.**
> All six templates load the logo from `https://www.luloudating.com/lulou-email-logo.png`.
> If `client/public/lulou-email-logo.png` is deleted or renamed, or if the Vercel deployment
> is rebuilt without that file, the logo will break in every email already in users' inboxes.
> Never remove this file. If you need to update the logo, overwrite the file in place and
> redeploy so the URL stays the same.

> **⚠️ The logo URL only works after the next deployment.**
> The file was added to `client/public/` in this commit. Until you publish a new build to
> Vercel/production, the URL returns the SPA's `index.html` instead of the PNG.
> Do not paste these templates into Supabase until after you have deployed and confirmed the
> URL returns `Content-Type: image/png` (see "Testing after pasting" below).

---

## In-email logo vs. Gmail sender avatar

These are two completely separate things:

| | In-email logo | Gmail sender avatar |
|---|---|---|
| **What it is** | The 80×80 Lulou icon inside the email body | The circular icon next to "Lulou" in the Gmail inbox list |
| **Controlled by** | The `<img>` tag in the HTML template | Google's servers (fetched from BIMI DNS record) |
| **Current status** | ✅ Added to all 6 templates | ❌ Not changed — Gmail shows a generated "L" initial |
| **How to change it** | Already done — just deploy | Requires BIMI + VMC (~$1,200/yr) or Google Workspace (~$6/mo) |

**Gmail sender avatar has NOT changed.** Gmail still shows a generated initial ("L") next to the
sender name in the inbox list. The in-email logo (inside the message body) will display correctly
once the asset is deployed, but these are independent.

To change the Gmail avatar:
- **Option A (cheapest):** Create a Google Workspace account for `noreply@luloudating.com` and
  set its profile photo to the Lulou icon — ~$6/month, no certificate required.
- **Option B (BIMI):** Add a BIMI DNS record pointing to an SVG logo + obtain a Verified Mark
  Certificate (VMC) from DigiCert or Entrust — ~$1,200/year. See `SENDER-AVATAR-BIMI.md`.

---

## Testing after pasting

Run these checks **before** and **after** pasting the templates into Supabase:

### 1. Verify the logo URL is live (do this first)
```
curl -sI https://www.luloudating.com/lulou-email-logo.png
```
Expected output must include:
- `HTTP/2 200`
- `content-type: image/png`

If you see `content-type: text/html`, the deployment hasn't included the file yet. Do not
paste the templates until this returns a PNG.

### 2. After pasting — trigger a test email
1. Go to **Supabase → Authentication → Email Templates → Confirm signup**
2. Click the **Send test** button (or do a real test signup with a mailbox you control)
3. Open the email and confirm:
   - The Lulou logo appears as a rounded 80×80 icon at the top of the card
   - The button link works and redirects to `https://luloudating.com/auth/callback`
   - Mobile layout is not broken (check on your phone or use Gmail mobile)

### 3. Mobile width check
Open the raw HTML file (`1-confirm-signup.html`) in a browser and resize the window to 375 px
wide. The logo, heading, button, and footer should all remain centred and readable.

### 4. What to look for if the logo is missing
- White broken-image icon → the URL is not returning a PNG (re-check step 1)
- "Lulou" text appears instead of the image → the `alt` fallback is working (logo not loaded)
- Nothing at all → email client is blocking remote images (user setting, not a template bug)

---

## Where to paste them

1. Open your Supabase project dashboard
2. Go to **Authentication → Email Templates**
3. Select the template name in the left sidebar
4. Paste the HTML into the **Message (HTML)** field
5. Paste the plain-text version into the **Message (plain text)** field (where available)
6. Set the **Subject** line as shown below
7. Click **Save**

---

## Template 1 — Confirm signup

**File:** `1-confirm-signup.html`  
**Supabase slot:** Confirm signup  
**Subject:** `Welcome to Lulou — confirm your account`  
**Supabase variable used:** `{{ .ConfirmationURL }}`

> Note: Supabase reuses this template when `supabase.auth.resend({ type: "signup" })` is called, so there is no separate "resend verification" slot needed.

**Plain-text version:**
```
Welcome to Lulou

Your real connection starts here.

Confirm your email to activate your account:

{{ .ConfirmationURL }}

This link expires in 24 hours. If you did not create a Lulou account, you can safely ignore this email.

—
Other apps learn who you swipe on.
Lulou learns who you genuinely connect with.

noreply@luloudating.com
```

---

## Template 2 — Password reset (Recovery)

**File:** `2-password-reset.html`  
**Supabase slot:** Reset password  
**Subject:** `Reset your Lulou password`  
**Supabase variable used:** `{{ .ConfirmationURL }}`

**Plain-text version:**
```
Lulou — Password Reset

We received a request to reset the password on your Lulou account.
Tap the link below to choose a new one. This link expires in one hour.

{{ .ConfirmationURL }}

If you did not request a password reset, you can safely ignore this email.
Your password will remain unchanged.

—
Other apps learn who you swipe on.
Lulou learns who you genuinely connect with.

noreply@luloudating.com
```

---

## Template 3 — Magic link

**File:** `3-magic-link.html`  
**Supabase slot:** Magic Link  
**Subject:** `Your secure Lulou sign-in link`  
**Supabase variable used:** `{{ .ConfirmationURL }}`

**Plain-text version:**
```
Lulou — Sign In

Your secure sign-in link is ready. Tap below to enter Lulou instantly.
No password needed. This link expires in one hour.

{{ .ConfirmationURL }}

If you did not request this sign-in link, you can safely ignore this email.

—
Other apps learn who you swipe on.
Lulou learns who you genuinely connect with.

noreply@luloudating.com
```

---

## Template 4 — Email change confirmation

**File:** `4-email-change.html`  
**Supabase slot:** Change Email Address  
**Subject:** `Confirm your new Lulou email`  
**Supabase variables used:** `{{ .ConfirmationURL }}`, `{{ .NewEmail }}`

> Note: Supabase sends this to the **new** email address. The `{{ .NewEmail }}` variable is displayed in the card so the user can confirm they're verifying the right address.

**Plain-text version:**
```
Lulou — Email Change

You recently requested to update the email address on your Lulou account.
Confirm your new address by visiting the link below:

{{ .ConfirmationURL }}

If you did not request this change, please contact us at support@luloudating.com

—
noreply@luloudating.com
```

---

## Template 5 — Invite user

**File:** `5-invite-user.html`  
**Supabase slot:** Invite User  
**Subject:** `You're invited to Lulou`  
**Supabase variable used:** `{{ .ConfirmationURL }}`

**Plain-text version:**
```
You're invited to Lulou

Something real could start here.

You've been personally invited to join Lulou — a premium dating community
built for people who are ready for a genuine connection.

Accept your invitation:

{{ .ConfirmationURL }}

This invitation expires in 24 hours.

—
Other apps learn who you swipe on.
Lulou learns who you genuinely connect with.

noreply@luloudating.com
```

---

## Template 6 — Reauthentication (OTP)

**File:** `6-reauthentication.html`  
**Supabase slot:** Reauthentication  
**Subject:** `Confirm it's really you — Lulou`  
**Supabase variable used:** `{{ .Token }}` (6-digit OTP code)

> Note: Unlike the other templates, reauthentication uses `{{ .Token }}` (a 6-digit OTP), NOT `{{ .ConfirmationURL }}`. The code is displayed prominently in the email and entered directly in the app. There is no button link.

**Plain-text version:**
```
Lulou — Security Check

Your security code: {{ .Token }}

Enter this code in the Lulou app to confirm your identity.
This code expires in 10 minutes. Do not share it with anyone.

If you did not request this, you can safely ignore this email.

—
noreply@luloudating.com
```

---

## Design system (reference)

| Token | Value |
|---|---|
| Background | `#f5eeeb` warm cream |
| Card background | `#ffffff` |
| Hero background | `#fdf4f5` blush |
| Primary brand | `#bc4e60` muted rose |
| Heading | `#1a0a0e` deep charcoal |
| Body text | `#5a3040` deep rose-brown |
| Muted text | `#8a5a68` |
| Footer background | `#fdf6f7` |
| Heading font | Georgia, "Times New Roman", serif |
| Body font | Arial, Helvetica, sans-serif |
| OTP font | "Courier New", Courier, monospace |
| Button radius | 100px (pill) |

---

## Sender configuration (Resend + Supabase SMTP)

Set in **Supabase → Authentication → Email → SMTP Settings**:

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | *(your Resend API key)* |
| Sender name | `Lulou` |
| Sender email | `noreply@luloudating.com` |

Set in **Supabase → Authentication → URL Configuration**:

| Field | Value |
|---|---|
| Site URL | `https://luloudating.com` |
| Additional Redirect URLs | `https://luloudating.com/auth/callback` |

---

## Deliverability checklist

- [x] Professional subject lines — no spam-trigger words
- [x] Real body text — not image-only
- [x] Plain-text fallback for every template
- [x] Clear sender identity: `Lulou <noreply@luloudating.com>`
- [x] No tracking pixels, no hidden text, no excessive links
- [x] `{{ .ConfirmationURL }}` present in every link-based template
- [x] Fallback raw link below every button
- [x] No external images (text wordmark only)
- [x] Mobile-safe table layout
- [x] Outlook VML button fallback
- [x] Dark mode `@media (prefers-color-scheme:dark)` support
- [x] `word-break:break-all` on the raw fallback URL
- [x] SPF + DKIM handled by Resend domain verification

---

## Supabase built-in email rate limit

Supabase's built-in (Inbucket) email provider allows a maximum of **2 emails per hour**.
This is enforced by Supabase regardless of template content. If a user triggers more than 2
verification emails in one hour, Supabase returns HTTP 429 with code `over_email_send_rate_limit`
and no email is sent.

**To remove this limit entirely, configure custom SMTP** (Resend is recommended — see
"Sender configuration" above). With custom SMTP connected, Supabase delegates sending to your
provider and the 2/hour cap does not apply.

---

## Production status

Email verification is **not fully fixed** until:

1. Resend custom SMTP is configured in the Supabase dashboard (steps above)
2. The Resend domain `luloudating.com` is verified in the Resend dashboard (DNS records added)
3. These templates are pasted into all six Supabase Auth slots
4. A test signup confirms the email arrives, button is visible, and clicking it verifies the account
