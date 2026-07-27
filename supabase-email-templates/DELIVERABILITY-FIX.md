# Lulou — Email Deliverability Fix (Gmail "This message might be dangerous")

## Root-cause diagnosis (July 2026)

A live password-reset email arrived in Gmail showing:

- **"This message might be dangerous"** red banner
- **Blank body / "..."** preview (no branded content visible)
- **From:** `lulou <nonreply@luloudating.com>` (typo — extra "n")

### Why Gmail showed the warning

Gmail evaluates SPF + DKIM + DMARC on every inbound message.

| Check | Result | Reason |
|---|---|---|
| SPF | **NONE** | `luloudating.com` has zero TXT records — no SPF record exists |
| DKIM | **FAIL alignment** | Resend's DKIM key is in DNS (`resend._domainkey.luloudating.com`) but Supabase custom SMTP was not configured, so Supabase used its own MTA. DKIM was signed with `d=mail.supabase.io`, not `d=luloudating.com` → alignment fails |
| DMARC | **FAIL** | Both SPF and DKIM alignment failed. Policy is `p=none` so no enforcement, but Gmail still flags the message |

Both SPF and DKIM alignment fail → DMARC fails → **Gmail shows the red warning**.

### Why the body was blank

The custom HTML template (`2-password-reset.html`) was **never pasted into the Supabase dashboard**. Supabase's default reset-password email is a near-empty plain-text message: `"Follow this link to reset your password: {{ .ConfirmationURL }}"`. Gmail's preview shows only "...".

### Why the From address is wrong

The Supabase SMTP sender email was saved as `nonreply@luloudating.com` (extra "n"). The correct address is `noreply@luloudating.com`.

---

## Fix checklist (complete in this order)

### Step 1 — Add SPF record (DNS registrar)

Add a TXT record on `luloudating.com`:

```
Type:    TXT
Name:    @   (or luloudating.com, depending on your registrar)
Value:   v=spf1 include:spf.resend.com ~all
TTL:     3600
```

**Important:** `luloudating.com` currently has **no TXT records at all**. Do not add a second SPF record later — only one SPF record is allowed per domain. If you ever need to add another sending service, combine them on one line, e.g. `v=spf1 include:spf.resend.com include:other.provider.com ~all`.

After adding, verify propagation (may take up to 24 h):
```
curl -s "https://dns.google/resolve?name=luloudating.com&type=TXT" | python3 -c "import json,sys; [print(r['data']) for r in json.load(sys.stdin).get('Answer',[])]"
```
Expected: `v=spf1 include:spf.resend.com ~all`

### Step 2 — Update DMARC record (DNS registrar)

The current DMARC record is: `v=DMARC1; p=none;`

Replace it with:

```
Type:    TXT
Name:    _dmarc
Value:   v=DMARC1; p=none; rua=mailto:dmarc@luloudating.com; pct=100;
TTL:     3600
```

This keeps `p=none` (monitoring only, no enforcement) but adds aggregate reporting so you can see authentication results. Once you confirm SPF and DKIM are both passing for 7+ days in reports, move to `p=quarantine`.

### Step 3 — Configure Resend custom SMTP in Supabase (dashboard)

Go to: **Supabase dashboard → Authentication → Email → SMTP Settings**

Enable custom SMTP and fill in:

| Field | Value |
|---|---|
| **Host** | `smtp.resend.com` |
| **Port** | `465` |
| **Username** | `resend` |
| **Password** | *(your Resend API key — starts with `re_`)* |
| **Sender name** | `Lulou` |
| **Sender email** | `noreply@luloudating.com` |

> ⚠️ The current sender email is `nonreply@luloudating.com` (extra "n" — a typo). Change it to `noreply@luloudating.com`.

Click **Save**. Supabase will now route all auth emails through Resend, which will DKIM-sign them with `d=luloudating.com` using the existing `resend._domainkey.luloudating.com` key.

### Step 4 — Paste the password-reset HTML template (dashboard)

Go to: **Supabase → Authentication → Email Templates → Reset Password**

1. Set the **Subject** to:
   ```
   Reset your Lulou password
   ```

2. Paste the full contents of `supabase-email-templates/2-password-reset.html` into the **Message (HTML)** field.

3. Paste the plain-text fallback into the **Message (plain text)** field:
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

4. Click **Save**.

### Step 5 — Disable link tracking in Resend (dashboard)

Go to: **Resend dashboard → Domains → luloudating.com → Settings**

Ensure **Click tracking** and **Open tracking** are **disabled** for this domain. Password-reset links must not be rewritten through a tracking subdomain — doing so breaks the cryptographic signature on the link and can trigger Gmail phishing detection.

### Step 6 — Send a fresh test reset email

1. Open an incognito window, go to the Lulou login page, click **Forgot password**, enter a Gmail address you control.
2. Open Gmail. The message should arrive with:
   - **No red warning banner**
   - **From:** `Lulou <noreply@luloudating.com>`
   - Full branded body with the dark-plum Lulou logo, "Reset my password" button, and fallback link
3. Click **Show original** (three-dot menu in Gmail) and confirm:
   - `SPF: PASS`
   - `DKIM: PASS`
   - `DMARC: PASS`
   - `From: noreply@luloudating.com`
   - `Return-Path: ...@bounce.resend.com` (Resend handles bounces)
   - `DKIM-Signature: d=luloudating.com` (aligned)

---

## Current DNS status (as of July 2026)

| Record | Status | Action needed |
|---|---|---|
| SPF (`luloudating.com` TXT) | ❌ MISSING | Add `v=spf1 include:spf.resend.com ~all` |
| DKIM (`resend._domainkey.luloudating.com`) | ✅ EXISTS | No action — already configured |
| DMARC (`_dmarc.luloudating.com`) | ⚠️ INCOMPLETE | Add `rua=` address (see Step 2) |
| MX (`luloudating.com`) | ⚠️ NONE | Optional — only needed if you receive mail at luloudating.com |

---

## Verification commands

Run after DNS propagates (up to 24 h):

```bash
# SPF
curl -s "https://dns.google/resolve?name=luloudating.com&type=TXT" | python3 -c "import json,sys; [print(r['data']) for r in json.load(sys.stdin).get('Answer',[])]"

# DKIM
curl -s "https://dns.google/resolve?name=resend._domainkey.luloudating.com&type=TXT" | python3 -c "import json,sys; d=json.load(sys.stdin); print('DKIM EXISTS:', bool(d.get('Answer')))"

# DMARC
curl -s "https://dns.google/resolve?name=_dmarc.luloudating.com&type=TXT" | python3 -c "import json,sys; [print(r['data']) for r in json.load(sys.stdin).get('Answer',[])]"
```
