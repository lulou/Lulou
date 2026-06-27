import Stripe from 'stripe';

type Credentials = { publishableKey: string; secretKey: string };

let _cachedCreds: Credentials | null = null;
let _cachedCredsAt = 0;
const CREDS_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchConnectionForEnv(
  hostname: string,
  xReplitToken: string,
  environment: string,
): Promise<Credentials | null> {
  const url = new URL(`https://${hostname}/api/v2/connection`);
  url.searchParams.set('include_secrets', 'true');
  url.searchParams.set('connector_names', 'stripe');
  url.searchParams.set('environment', environment);

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Replit-Token': xReplitToken,
    },
  });

  if (!response.ok) {
    console.warn(`[STRIPE_CLIENT] Connector fetch failed for env=${environment}: HTTP ${response.status}`);
    return null;
  }

  const data = await response.json();
  const settings = data.items?.[0]?.settings;

  if (!settings?.publishable || !settings?.secret) {
    return null;
  }

  return { publishableKey: settings.publishable, secretKey: settings.secret };
}

async function getCredentials(): Promise<Credentials> {
  const now = Date.now();
  if (_cachedCreds && now - _cachedCredsAt < CREDS_TTL_MS) {
    return _cachedCreds;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) {
    throw new Error('[STRIPE_CLIENT] REPLIT_CONNECTORS_HOSTNAME is not set');
  }

  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? 'depl ' + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error('[STRIPE_CLIENT] REPL_IDENTITY and WEB_REPL_RENEWAL are both unset — cannot authenticate with Replit connectors');
  }

  const isProduction = process.env.REPLIT_DEPLOYMENT === '1';
  const primaryEnv = isProduction ? 'production' : 'development';
  const fallbackEnv = isProduction ? 'development' : null;

  let creds = await fetchConnectionForEnv(hostname, xReplitToken, primaryEnv);

  if (!creds && fallbackEnv) {
    console.warn(`[STRIPE_CLIENT] No ${primaryEnv} Stripe connection found, falling back to ${fallbackEnv}`);
    creds = await fetchConnectionForEnv(hostname, xReplitToken, fallbackEnv);
  }

  if (!creds) {
    throw new Error(
      `[STRIPE_CLIENT] Stripe connection not found for environment="${primaryEnv}"${fallbackEnv ? ` or "${fallbackEnv}"` : ''}. ` +
      'Please ensure the Stripe integration is connected in your Replit project.',
    );
  }

  // ── Audit log: key mode + account fragment ───────────────────────────────
  // Publishable keys encode the account ID: pk_test_<ACCT_FRAGMENT>_<RANDOM>
  // Extract it so the log tells us exactly which Stripe account is active.
  const pubParts = creds.publishableKey.split('_');
  const keyMode = creds.secretKey.startsWith('sk_live') ? 'LIVE' : creds.secretKey.startsWith('sk_test') ? 'TEST' : 'UNKNOWN';
  const acctFragment = pubParts.length >= 3 ? pubParts[2]?.slice(0, 8) + '…' : '(unknown)';
  const pubMode = creds.publishableKey.startsWith('pk_live') ? 'LIVE' : creds.publishableKey.startsWith('pk_test') ? 'TEST' : 'UNKNOWN';

  if (keyMode !== pubMode) {
    console.error(`[STRIPE_CLIENT] ⚠ KEY MODE MISMATCH — secret key is ${keyMode} but publishable key is ${pubMode}. They must belong to the same account and mode.`);
  }

  console.log(
    `[STRIPE_CLIENT] ✓ Credentials loaded — mode=${keyMode} env=${primaryEnv} ` +
    `acct=…${acctFragment} secret=sk_${keyMode.toLowerCase()}_…${creds.secretKey.slice(-4)} ` +
    `pub=pk_${pubMode.toLowerCase()}_…${creds.publishableKey.slice(-4)}`,
  );

  if (keyMode === 'TEST') {
    console.log('[STRIPE_CLIENT] ℹ Running in TEST mode. To see sessions in the Stripe dashboard: open dashboard.stripe.com → toggle "Test mode" (top-left). Live mode shows 0 test sessions.');
  }

  _cachedCreds = creds;
  _cachedCredsAt = now;
  return creds;
}

export async function getUncachableStripeClient(): Promise<Stripe> {
  const { secretKey } = await getCredentials();
  return new Stripe(secretKey, { apiVersion: '2025-08-27.basil' as any });
}

export async function getStripePublishableKey(): Promise<string> {
  const { publishableKey } = await getCredentials();
  return publishableKey;
}

export async function getStripeSecretKey(): Promise<string> {
  const { secretKey } = await getCredentials();
  return secretKey;
}

// ── Stripe account info (cached) ─────────────────────────────────────────────
// Calls stripe.accounts.retrieve() once and caches with the same TTL as creds.
// Returns the definitive Stripe account ID, livemode, and key prefixes.

export type StripeAccountInfo = {
  accountId: string;
  displayName: string | null;
  country: string | null;
  livemode: boolean;
  secretKeyPrefix: string;   // first 12 chars of the secret key
  pubKeyPrefix: string;      // first 12 chars of the publishable key
};

let _cachedAccountInfo: StripeAccountInfo | null = null;
let _cachedAccountAt = 0;

export async function getStripeAccountInfo(): Promise<StripeAccountInfo> {
  const now = Date.now();
  if (_cachedAccountInfo && now - _cachedAccountAt < CREDS_TTL_MS) {
    return _cachedAccountInfo;
  }

  const { secretKey, publishableKey } = await getCredentials();
  const stripe = new Stripe(secretKey, { apiVersion: '2025-08-27.basil' as any });
  const account = await stripe.accounts.retrieve();

  const info: StripeAccountInfo = {
    accountId:      account.id,
    displayName:    (account as any).display_name ?? (account as any).settings?.dashboard?.display_name ?? null,
    country:        account.country ?? null,
    livemode:       (account as any).livemode ?? !secretKey.startsWith('sk_test'),
    secretKeyPrefix: secretKey.slice(0, 12),
    pubKeyPrefix:   publishableKey.slice(0, 12),
  };

  console.log("[STRIPE_ACCOUNT]", {
    accountId:      info.accountId,
    displayName:    info.displayName,
    country:        info.country,
    livemode:       info.livemode,
    secretKeyPrefix: info.secretKeyPrefix,
    pubKeyPrefix:   info.pubKeyPrefix,
  });

  _cachedAccountInfo = info;
  _cachedAccountAt   = now;
  return info;
}

let stripeSync: any = null;

export async function getStripeSync() {
  if (!stripeSync) {
    const { StripeSync } = await import('stripe-replit-sync');
    const secretKey = await getStripeSecretKey();
    stripeSync = new StripeSync({
      poolConfig: { connectionString: process.env.DATABASE_URL!, max: 2 },
      stripeSecretKey: secretKey,
    });
  }
  return stripeSync;
}
