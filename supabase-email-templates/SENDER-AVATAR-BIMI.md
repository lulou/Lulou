# Lulou Email Sender Avatar & BIMI Configuration

## Current Sender Configuration

| Setting | Value |
|---------|-------|
| From email | `noreply@luloudating.com` |
| From name | `Lulou` |
| SMTP provider | Resend (smtp.resend.com:465) |
| Domain | luloudating.com |

---

## Why Gmail Shows a Generic "L" Avatar

Gmail's sender avatar is **NOT controlled by email HTML**. Changing the HTML template cannot replace the Gmail sender logo.

Gmail determines the sender avatar via one of these mechanisms, in priority order:

1. **Google Workspace profile photo** — if the sending address has a Google Account or Google Workspace account, that account's profile photo appears.
2. **BIMI** (Brand Indicators for Message Identification) — a published DNS record that links your domain to an SVG logo file. Gmail specifically requires a **VMC (Verified Mark Certificate)** from an approved CA.
3. **Auto-generated initial** — fallback: Gmail picks the first letter of the sender name and assigns a colour (currently: blue "L" for "Lulou").

---

## How to Display the Lulou Logo in Gmail

### Step 1 — Confirm SPF, DKIM, and DMARC

Before BIMI will work, the domain must pass all three email authentication checks.

#### SPF
Add a TXT record to `luloudating.com`:
```
v=spf1 include:_spf.resend.com ~all
```
Check: https://mxtoolbox.com/spf.aspx

#### DKIM
Resend generates DKIM keys. In the Resend dashboard → Domains → luloudating.com, copy the DKIM CNAME records and add them to your DNS.

Check: https://mxtoolbox.com/dkim.aspx

#### DMARC (required — must be p=quarantine or p=reject for BIMI)
Add a TXT record to `_dmarc.luloudating.com`:
```
v=DMARC1; p=quarantine; rua=mailto:dmarc@luloudating.com; ruf=mailto:dmarc@luloudating.com; fo=1
```
Check: https://mxtoolbox.com/dmarc.aspx

> **Gmail BIMI requires DMARC policy of `p=quarantine` or `p=reject`. `p=none` will not work.**

---

### Step 2 — Prepare the SVG Logo

BIMI requires a **square SVG** in the **SVG Tiny PS** profile. The Lulou app icon (rose-pink double-L monogram on cream background) is used.

Requirements:
- SVG format (SVG Tiny PS — not full SVG)
- Square aspect ratio (1:1)
- Hosted at a publicly accessible `https://` URL
- File size: ideally < 32 KB

The app icon is currently served at:
```
https://luloudating.com/lulou-email-logo.png
```
For BIMI you need the SVG version, hosted at e.g.:
```
https://luloudating.com/lulou-bimi-logo.svg
```

Use the existing `icon-appstore.png` or `lulou-logo-master.png` converted to SVG Tiny PS format using a tool like https://vecta.io or Adobe Illustrator.

---

### Step 3 — Obtain a VMC or CMC Certificate (Required for Gmail)

Gmail requires a **Verified Mark Certificate (VMC)** from an approved CA:
- **Entrust**: https://www.entrust.com/email-security/bimi/
- **DigiCert**: https://www.digicert.com/tls-ssl/verified-mark-certificates

**Cost**: approximately $1,200–$1,500 USD/year.

> **Without a VMC, BIMI will show the logo in Apple Mail, Yahoo Mail, and Fastmail, but NOT in Gmail.** Gmail strictly requires a VMC.

---

### Step 4 — Publish the BIMI DNS Record

Once the VMC is obtained (it includes the logo URL), add a TXT record to `default._bimi.luloudating.com`:
```
v=BIMI1; l=https://luloudating.com/lulou-bimi-logo.svg; a=https://luloudating.com/lulou-vmc.pem
```

Where:
- `l=` is the public URL of your SVG Tiny PS logo file
- `a=` is the public URL of your VMC PEM file (provided by Entrust or DigiCert)

Check after publishing: https://bimigroup.org/bimi-generator/

---

## Alternative (Cheaper) Options

| Option | Gmail support | Cost |
|--------|--------------|------|
| VMC from Entrust/DigiCert | ✓ Yes | ~$1,200/yr |
| CMC (Common Mark Certificate) | ✗ Not yet | ~$100–300/yr |
| No certificate (BIMI lite) | ✗ No | Free |
| Google Workspace profile photo | ✓ Yes | $6–18/user/mo |

**Cheapest path to Gmail logo**: Create a Google Workspace account for `noreply@luloudating.com`, upload the Lulou logo as the account's profile photo. Gmail will then show that photo as the sender avatar. No VMC required.

---

## In-Email Logo (Done)

The Lulou app icon is served at:
```
https://luloudating.com/lulou-email-logo.png
```

This URL can be used inside email HTML templates as the header logo:
```html
<img
  src="https://luloudating.com/lulou-email-logo.png"
  alt="Lulou"
  width="48"
  height="48"
  style="border-radius:12px;display:block;margin:0 auto 16px;"
/>
```

The file is already placed at `client/public/lulou-email-logo.png` (a copy of the 1024×1024 app icon) and will be accessible at the above URL when deployed.

---

## Summary of Actions Required

| Action | Who | Complexity |
|--------|-----|-----------|
| Verify SPF record for Resend | DNS admin | Easy (5 min) |
| Configure DKIM in Resend dashboard + DNS | DNS admin | Easy (10 min) |
| Set DMARC to p=quarantine | DNS admin | Easy (5 min) |
| Convert app icon to SVG Tiny PS | Designer | Medium (1–2 hrs) |
| Host SVG at HTTPS URL | Dev | Easy |
| Publish BIMI DNS TXT record | DNS admin | Easy (5 min) |
| Purchase VMC from Entrust/DigiCert | Business | Hard ($1,200/yr) |
| OR create Google Workspace account for noreply@ + set profile photo | Admin | Easy (30 min, ~$6/mo) |
