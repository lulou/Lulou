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

  console.log(`[STRIPE_CLIENT] Credentials loaded (env=${primaryEnv}, key=...${creds.secretKey.slice(-4)})`);
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
