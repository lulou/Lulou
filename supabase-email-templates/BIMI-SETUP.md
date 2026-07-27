# Lulou — BIMI & Sender Branding Setup Guide

## Important distinction — email body logo vs sender avatar

**Updating the six Supabase HTML email templates changes the logo displayed
inside the email body** (the image rendered in the `<img>` tag when the recipient
opens the message).

**It does not change Gmail's circular sender avatar.** Gmail's sender avatar is
determined by the authenticated sender identity, not by any image tag in the
email HTML. Controlling the Gmail sender avatar requires BIMI support at the
mailbox-provider level (Google Workspace BIMI is GA; consumer Gmail is not yet
supported for custom BIMI). The steps below are the complete path to achieving
a branded sender avatar in supported mail clients.

---

## 1 — SPF (Sender Policy Framework)

SPF prevents spoofing by listing which servers may send on behalf of your domain.

**DNS record (TXT on `luloudating.com`):**
```
v=spf1 include:_spf.supabase.com ~all
```

- Replace `include:_spf.supabase.com` with whichever sending service(s) Lulou
  uses (Supabase Auth emails, any transactional provider).
- Use `-all` (hard fail) once you have confirmed all legitimate senders are
  listed. `~all` (soft fail) is safer during initial setup.
- Verify: `dig TXT luloudating.com` or https://mxtoolbox.com/spf.aspx

---

## 2 — DKIM (DomainKeys Identified Mail)

DKIM signs outgoing messages so recipients can verify they were not tampered
with in transit.

- **Supabase Auth:** configure custom SMTP via a provider that supports DKIM
  (Postmark, SendGrid, AWS SES, Resend). The provider gives you a public key to
  publish as a DNS TXT record, e.g.:
  ```
  key._domainkey.luloudating.com  TXT  "v=DKIM1; k=rsa; p=<public-key>"
  ```
- Verify: https://mxtoolbox.com/dkim.aspx

---

## 3 — DMARC (Domain-based Message Authentication)

DMARC ties SPF and DKIM together and tells receivers what to do when both fail.
**An enforced DMARC policy (`p=quarantine` or `p=reject`) is mandatory for
BIMI** — a `p=none` policy is insufficient.

**DNS record (TXT on `_dmarc.luloudating.com`):**
```
v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:dmarc-reports@luloudating.com; ruf=mailto:dmarc-forensics@luloudating.com; pct=100
```

| Field | Value | Notes |
|-------|-------|-------|
| `p` | `reject` | Must be `quarantine` or `reject` for BIMI |
| `adkim` | `s` (strict) | DKIM alignment mode |
| `aspf` | `s` (strict) | SPF alignment mode |
| `rua` | aggregate report address | Set up a mailbox or use a DMARC reporting service |
| `pct` | `100` | Apply policy to 100 % of messages |

Start with `p=none` and monitor aggregate reports for 2–4 weeks before
switching to `quarantine` then `reject`. Moving directly to `reject` risks
blocking legitimate mail.

---

## 4 — BIMI DNS record

Once DMARC is enforced and a VMC or CMC certificate is obtained:

**DNS record (TXT on `default._bimi.luloudating.com`):**
```
v=BIMI1; l=https://www.luloudating.com/lulou-bimi.svg; a=https://www.luloudating.com/lulou-vmc.pem
```

| Field | Value |
|-------|-------|
| `v` | `BIMI1` |
| `l` | URL of the published SVG Tiny PS logo (must be HTTPS, publicly reachable, no redirect) |
| `a` | URL of the PEM-encoded VMC or CMC certificate file |

**Do not publish this record until:**
1. The SVG has been visually approved (see `lulou-bimi-draft.svg`)
2. A VMC or CMC has been obtained
3. DMARC is at `p=reject` or `p=quarantine`

---

## 5 — SVG Tiny PS requirements

The BIMI SVG must conform to **SVG 1.2 Tiny PS** (Portable/Secure subset).

| Requirement | Detail |
|-------------|--------|
| Namespace | `xmlns="http://www.w3.org/2000/svg"` |
| Version | `version="1.2" baseProfile="tiny-ps"` |
| Square canvas | `viewBox="0 0 N N"` — aspect ratio must be 1:1 |
| No external references | No `<image>`, `href` to external URLs, or `<use>` of external symbols |
| No scripts | No `<script>` elements |
| No embedded fonts | All text must be converted to `<path>` outlines |
| No CSS `@import` | Inline styles only, no external stylesheets |
| Raster images | Not permitted |
| Max file size | 32 KB recommended (some providers enforce limits) |
| Validator | https://bimigroup.org/bimi-generator/ |

**Draft file:** `supabase-email-templates/lulou-bimi-draft.svg`

Before production:
1. Open `lulou-bimi-draft.svg` in Inkscape or Adobe Illustrator
2. Select all shapes; run **Path → Object to Path** (Inkscape) or
   **Type → Create Outlines** (Illustrator) if any text elements exist
3. Export / Save As SVG, preserving `version="1.2"` and `baseProfile="tiny-ps"`
4. Strip comments, metadata, and editor cruft to keep the file small
5. Re-validate at https://bimigroup.org/bimi-generator/
6. Host at `https://www.luloudating.com/lulou-bimi.svg` (HTTPS, HTTP 200, no redirect)

---

## 6 — VMC / CMC certificate

BIMI logos must be backed by a certificate that ties the mark to the domain.

| Certificate type | Issued by | Notes |
|-----------------|-----------|-------|
| **VMC** (Verified Mark Certificate) | DigiCert, Entrust | Requires trademark registration in at least one jurisdiction. Most widely supported by providers (Gmail, Apple Mail, Yahoo). |
| **CMC** (Common Mark Certificate) | DigiCert | Does not require trademark registration. Newer standard; provider support is growing (Yahoo Mail supports CMC). |

**VMC process (typical):**
1. File a trademark application for the Lulou logo (or "Lulou" word mark) in
   an eligible jurisdiction (USPTO, EUIPO, UK IPO, etc.).
2. Obtain registration certificate (3–18 months depending on jurisdiction).
3. Apply to DigiCert or Entrust for a VMC, providing the trademark certificate
   and the approved SVG Tiny PS file.
4. The CA validates the mark, issues the VMC as a PEM-encoded certificate.
5. Host the PEM at a stable HTTPS URL (e.g.
   `https://www.luloudating.com/lulou-vmc.pem`).
6. Add the `a=` field to the BIMI DNS record pointing at the PEM URL.

**Cost:** VMC certificates typically cost USD 1,000–1,500/year per domain from
DigiCert/Entrust, plus government trademark filing fees.

---

## 7 — Mailbox provider support

| Provider | BIMI support | Notes |
|----------|-------------|-------|
| Gmail (Workspace) | ✅ GA | Requires VMC; shows blue verified checkmark |
| Gmail (consumer `@gmail.com`) | ⚠️ Limited | No custom BIMI for consumer accounts as of mid-2025 |
| Apple Mail (iOS 16+, macOS Ventura+) | ✅ Supported | Requires VMC or CMC |
| Yahoo Mail | ✅ Supported | VMC and CMC both accepted |
| Outlook / Microsoft 365 | ✅ Supported (via BIMI) | Rolling out; check current status |
| Fastmail | ✅ Supported | |
| Other clients | ⚠️ Varies | Falls back gracefully (no logo shown) |

---

## 8 — Implementation checklist

```
[ ] SPF record published and verified
[ ] DKIM signing configured for all sending paths (Supabase SMTP provider)
[ ] DMARC at p=none with rua reporting — monitor for 4+ weeks
[ ] DMARC escalated to p=quarantine — monitor for 2+ weeks
[ ] DMARC escalated to p=reject
[ ] lulou-bimi-draft.svg visually approved
[ ] SVG converted to all-path, comments stripped, validated at bimigroup.org
[ ] SVG hosted at https://www.luloudating.com/lulou-bimi.svg (HTTP 200, no redirect)
[ ] Trademark registration filed / certificate obtained
[ ] VMC or CMC issued by accredited CA
[ ] PEM hosted at https://www.luloudating.com/lulou-vmc.pem
[ ] BIMI DNS TXT record published at default._bimi.luloudating.com
[ ] BIMI verified in Gmail Postmaster Tools / Yahoo BIMI Validator
```

---

## 9 — Email body logo (current deployment)

The six Supabase email templates in this directory now reference:

```
https://www.luloudating.com/lulou-email-logo-v6.png
```

This controls the logo **inside the email body** only. It is not related to
BIMI and does not require SPF/DKIM/DMARC or a certificate.

| Template file | Purpose |
|--------------|---------|
| `1-confirm-signup.html` | Email verification on sign-up |
| `2-password-reset.html` | Password reset link |
| `3-magic-link.html` | Magic-link sign-in |
| `4-email-change.html` | Email address change confirmation |
| `5-invite-user.html` | Admin-invite new user |
| `6-reauthentication.html` | Re-authentication prompt |
