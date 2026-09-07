---
name: Stripe Checkout key boundary
description: Which Stripe credentials may block server-hosted Checkout session creation
---

Server-hosted Stripe Checkout session creation must require `STRIPE_SECRET_KEY` only. A publishable key may be required by a separate Stripe.js/config endpoint, but it is not a prerequisite for creating a hosted Checkout Session and redirecting to its URL.

**Why:** Railway had a valid live secret key but no publishable-key variable. Shared credential loading treated both as mandatory, so every paid endpoint returned HTTP 500 before calling Stripe.

**How to apply:** Keep secret-key validation in the shared server credential loader. Validate the publishable key only inside functions that explicitly return or use it in the browser.