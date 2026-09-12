import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const purchaseService = readFileSync("client/src/lib/purchase-service.ts", "utf8");
const routes = readFileSync("server/routes.ts", "utf8");
const purchaseItems = readFileSync("server/purchaseItems.ts", "utf8");
const webhookHandlers = readFileSync("server/webhookHandlers.ts", "utf8");
const stripeClient = readFileSync("server/stripeClient.ts", "utf8");

describe("shared Stripe checkout regressions", () => {
  it("uses the app auth helper so protected checkout requests include the session ID", () => {
    expect(purchaseService).toContain('import { API_BASE, getAuthHeaders } from "./queryClient"');
    expect(purchaseService).toContain("const authHeaders = await getAuthHeaders()");
    expect(purchaseService).toContain('headers: {\n        "Content-Type": "application/json",\n        ...authHeaders,');
    expect(purchaseService).not.toContain("supabase.auth.getSession()");
  });

  it("suppresses duplicate taps and exposes only a short checkout failure message", () => {
    expect(purchaseService).toContain("let checkoutInFlight = false");
    expect(purchaseService).toContain("DUPLICATE_CLICK_IGNORED");
    expect(purchaseService).toContain("Checkout couldn’t start. Please try again.");
    expect(purchaseService).toContain('url.hostname === "checkout.stripe.com"');
    expect(purchaseService).toContain("window.location.assign(checkoutUrl)");
  });

  it("requires only the secret key for server-hosted Checkout", () => {
    const credentialLoader = stripeClient.slice(
      stripeClient.indexOf("function loadCredentials"),
      stripeClient.indexOf("function getCredentials"),
    );
    const publishableKeyGetter = stripeClient.slice(
      stripeClient.indexOf("export function getStripePublishableKey"),
      stripeClient.indexOf("export function getStripeSecretKey"),
    );

    expect(credentialLoader).toContain("if (!secretKey)");
    expect(credentialLoader).not.toContain("if (!publishableKey)");
    expect(publishableKeyGetter).toContain("if (!publishableKey)");
  });

  it("returns users to their trusted request origin instead of a stale deployment URL", () => {
    expect(routes).toContain("const resolveStripeReturnBaseUrl = (req: any): string =>");
    expect(routes).toContain('"https://www.luloudating.com"');
    expect(routes).toContain('"https://lulouapp.vercel.app"');
    expect(routes).toContain("const baseUrl = resolveStripeReturnBaseUrl(req)");
    expect(routes.match(/const baseUrl = resolveStripeReturnBaseUrl\(req\)/g)).toHaveLength(3);
  });

  it("keeps every paid SKU server-mapped with the expected AUD amount and mode", () => {
    const expectedSkus = [
      ["messages-5", "499", "payment"],
      ["undo-close", "299", "payment"],
      ["membership", "1999", "subscription"],
      ["starter-pack", "499", "payment"],
      ["video-starter", "699", "payment"],
      ["connection-pack", "1299", "payment"],
      ["premium-pack", "1999", "payment"],
      ["chemistry-pack", "1699", "payment"],
      ["deep-connection-pack", "2799", "payment"],
      ["voice-notes-unlock", "499", "payment"],
      ["extra-call", "499", "payment"],
      ["sparks-1", "299", "payment"],
      ["sparks-3", "699", "payment"],
      ["sparks-5", "999", "payment"],
      ["elevate-1", "999", "elevate"],
      ["elevate-3", "2699", "elevate"],
      ["elevate-5", "3999", "elevate"],
      ["super-elevate", "3499", "super_elevate"],
    ] as const;

    for (const [sku, amount, mode] of expectedSkus) {
      const definition = purchaseItems
        .split("\n")
        .find((line) => line.includes(`"${sku}"`));
      expect(definition).toBeDefined();
      expect(definition).toMatch(new RegExp(`unitAmount:\\s*${amount}`));
      expect(definition).toMatch(new RegExp(`(?:mode|type):\\s*"${mode}"`));
    }
    expect(routes).toContain('currency: "aud"');
    expect(routes).toContain("const item = EXTRAS_ITEMS[itemId as ExtrasItemId]");
    expect(routes).toContain("const pack = ELEVATE_PACKS[packId as keyof typeof ELEVATE_PACKS]");
  });

  it("keeps webhook fulfillment payment-gated and exactly-once", () => {
    expect(webhookHandlers).toContain('session.payment_status === "paid"');
    expect(webhookHandlers).toContain("await db.transaction(async (tx)");
    expect(webhookHandlers).toContain("await tx.insert(processedStripeSessions)");
    expect(webhookHandlers).toContain("if (isUniqueViolation(grantErr))");
    expect(webhookHandlers).toContain("await grantExtras(");
    expect(webhookHandlers).toContain("await grantElevate(");
    expect(webhookHandlers).toContain("throw err");
    expect(webhookHandlers).toContain('event.type === "checkout.session.async_payment_succeeded"');
    expect(webhookHandlers).toContain('session.payment_status === "no_payment_required"');
    expect(routes).toContain('session.payment_status === "no_payment_required"');
    expect(routes).toContain("await db.transaction(async (tx)");
    expect(purchaseItems).not.toContain("grantElevate: auto-activate failed");
  });

  it("fails fast when the configured Stripe account cannot accept charges", () => {
    expect(stripeClient).toContain("export function checkStripeAccountReady");
    expect(stripeClient).toContain("stripe_live_charges_disabled");
    expect(routes.match(/checkStripeAccountReady\(/g)).toHaveLength(2);
  });

  it("scopes purchase-status reads to the authenticated user", () => {
    expect(routes).toContain("eq(processedStripeSessions.userId, userId)");
  });
});