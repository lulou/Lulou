---
name: Stripe live-charge capability
description: Production checkout requires account-level charge capability in addition to valid live credentials and prices.
---

Treat Stripe account capability as a separate production readiness gate. A live secret key, matching publishable key, active prices, completed account details, and enabled payouts do not prove the account can create live Checkout Sessions. Require `charges_enabled=true`; for card checkout, verify `card_payments` is active.

**Why:** Stripe can reject every Checkout Session with “Your account cannot currently make live charges” while the account is live, details are submitted, payouts are enabled, prices resolve, and no requirements are listed. This is an account-level Stripe restriction, not an auth, SKU, currency, or Checkout parameter error.

**How to apply:** During checkout diagnostics, retrieve the Stripe account safely and log only mode/capability status. If card payments are requested but inactive with no API-visible requirements, do not swap to an unrelated connected account or alter product logic; the account owner must resolve the capability in Stripe.