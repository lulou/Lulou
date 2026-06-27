import Stripe from 'stripe';

type Credentials = { publishableKey: string; secretKey: string };
type CredentialSource = 'env' | 'replit_connector';

let _cachedCreds: Credentials | null = null;
let _cachedCredsAt = 0;
let _cachedSource: CredentialSource | null = null;
const CREDS_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Helper: derive livemode from a key string ─────────────────────────────────
function keyLivemode(key: string): boolean {
  return key.startsWith('sk_live_') || key.startsWith('pk_live_');
}

// ── Replit connector fetch ────────────────────────────────────────────────────
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

// ── Core credential resolver ──────────────────────────────────────────────────
// Priority order:
//   1. Explicit env vars  (STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY / VITE_STRIPE_PUBLISHABLE_KEY)
//   2. Replit connector   (development → production fallback)
async function getCredentials(): Promise<{ creds: Credentials; source: CredentialSource }> {
  const now = Date.now();
  if (_cachedCreds && _cachedSource && now - _cachedCredsAt < CREDS_TTL_MS) {
    return { creds: _cachedCreds, source: _cachedSource };
  }

  // ── 1. Explicit environment variables ────────────────────────────────────────
  const envSecret = process.env.STRIPE_SECRET_KEY ?? '';
  const envPub =
    process.env.STRIPE_PUBLISHABLE_KEY ??
    process.env.VITE_STRIPE_PUBLISHABLE_KEY ??
    '';

  if (envSecret && envPub) {
    const creds: Credentials = { secretKey: envSecret, publishableKey: envPub };
    _cachedCreds = creds;
    _cachedCredsAt = now;
    _cachedSource = 'env';
    _logCredentials(creds, 'env');
    return { creds, source: 'env' };
  }

  if (envSecret && !envPub) {
    console.warn(
      '[STRIPE_CLIENT] ⚠ STRIPE_SECRET_KEY is set but STRIPE_PUBLISHABLE_KEY / VITE_STRIPE_PUBLISHABLE_KEY is missing. ' +
      'Falling back to Replit connector for publishable key.',
    );
  }
  if (!envSecret && envPub) {
    console.warn(
      '[STRIPE_CLIENT] ⚠ STRIPE_PUBLISHABLE_KEY is set but STRIPE_SECRET_KEY is missing. ' +
      'Ignoring partial env override — using Replit connector.',
    );
  }

  // ── 2. Replit connector ───────────────────────────────────────────────────────
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) {
    throw new Error(
      '[STRIPE_CLIENT] No Stripe credentials found. Set STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY, ' +
      'or ensure REPLIT_CONNECTORS_HOSTNAME is set for the Replit Stripe connector.',
    );
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

  _cachedCreds = creds;
  _cachedCredsAt = now;
  _cachedSource = 'replit_connector';
  _logCredentials(creds, 'replit_connector');
  return { creds, source: 'replit_connector' };
}

function _logCredentials(creds: Credentials, source: CredentialSource) {
  const keyMode   = creds.secretKey.startsWith('sk_live') ? 'LIVE' : creds.secretKey.startsWith('sk_test') ? 'TEST' : 'UNKNOWN';
  const pubMode   = creds.publishableKey.startsWith('pk_live') ? 'LIVE' : creds.publishableKey.startsWith('pk_test') ? 'TEST' : 'UNKNOWN';
  const pubParts  = creds.publishableKey.split('_');
  const acctFrag  = pubParts.length >= 3 ? pubParts[2]?.slice(0, 8) + '…' : '(unknown)';
  const livemode  = keyMode === 'LIVE';

  if (keyMode !== pubMode) {
    console.error(
      `[STRIPE_CLIENT] ⚠ KEY MODE MISMATCH — secret key is ${keyMode} but publishable key is ${pubMode}. ` +
      'They must belong to the same account and mode.',
    );
  }

  const isProduction = process.env.REPLIT_DEPLOYMENT === '1';

  console.log(
    `[STRIPE_CLIENT] ✓ Credentials loaded — source=${source} mode=${keyMode} ` +
    `acct=…${acctFrag} secret=sk_${keyMode.toLowerCase()}_…${creds.secretKey.slice(-4)} ` +
    `pub=pk_${pubMode.toLowerCase()}_…${creds.publishableKey.slice(-4)}`,
  );

  // ── [STRIPE_MODE] block ───────────────────────────────────────────────────
  console.log(`[STRIPE_MODE] source=${source}`);
  console.log(`[STRIPE_MODE] livemode=${livemode}`);
  // accountId is only known after accounts.retrieve(); log a placeholder here.
  console.log(`[STRIPE_MODE] keyMode=${keyMode} secretSuffix=…${creds.secretKey.slice(-4)} pubSuffix=…${creds.publishableKey.slice(-4)}`);

  if (!livemode) {
    if (isProduction) {
      console.error(
        '\n╔══════════════════════════════════════════════════════════════════╗\n' +
        '║  ⛔  STRIPE TEST KEYS IN PRODUCTION                             ║\n' +
        '║  Real money will NOT be charged.                                ║\n' +
        '║  Set STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY (live keys)     ║\n' +
        '║  in Replit Secrets → redeploy to enable live payments.          ║\n' +
        '╚══════════════════════════════════════════════════════════════════╝\n',
      );
    } else {
      console.log(
        '[STRIPE_CLIENT] ℹ Running in TEST mode. ' +
        'To see sessions: dashboard.stripe.com → toggle "Test mode" (top-left) → Payments → Checkout.',
      );
    }
  }
}

// ── Public helpers ────────────────────────────────────────────────────────────

export async function getUncachableStripeClient(): Promise<Stripe> {
  const { creds } = await getCredentials();
  return new Stripe(creds.secretKey, { apiVersion: '2025-08-27.basil' as any });
}

export async function getStripePublishableKey(): Promise<string> {
  const { creds } = await getCredentials();
  return creds.publishableKey;
}

export async function getStripeSecretKey(): Promise<string> {
  const { creds } = await getCredentials();
  return creds.secretKey;
}

// ── Mode descriptor ───────────────────────────────────────────────────────────
export type StripeModeInfo = {
  source: CredentialSource;
  livemode: boolean;
  /** true when running in production with test keys — checkout should be blocked */
  isBlocked: boolean;
  secretSuffix: string;
  pubSuffix: string;
};

export async function getStripeMode(): Promise<StripeModeInfo> {
  const { creds, source } = await getCredentials();
  const livemode   = creds.secretKey.startsWith('sk_live_');
  const isProduction = process.env.REPLIT_DEPLOYMENT === '1';
  const isBlocked  = isProduction && !livemode;
  return {
    source,
    livemode,
    isBlocked,
    secretSuffix: creds.secretKey.slice(-4),
    pubSuffix: creds.publishableKey.slice(-4),
  };
}

/**
 * Call at the top of any checkout endpoint.
 * Throws a 402 payload if the app is in production but only has test keys,
 * so real users never see a test-mode checkout session.
 */
export async function checkStripeReady(): Promise<void> {
  const mode = await getStripeMode();
  if (mode.isBlocked) {
    throw Object.assign(
      new Error('Payments are still in test mode. Live keys have not been configured.'),
      { statusCode: 402, code: 'stripe_test_mode_blocked' },
    );
  }
}

// ── Stripe account info (cached) ──────────────────────────────────────────────

export type StripeAccountInfo = {
  accountId: string;
  displayName: string | null;
  country: string | null;
  livemode: boolean;
  secretKeyPrefix: string;
  pubKeyPrefix: string;
  source: CredentialSource;
};

let _cachedAccountInfo: StripeAccountInfo | null = null;
let _cachedAccountAt = 0;

export async function getStripeAccountInfo(): Promise<StripeAccountInfo> {
  const now = Date.now();
  if (_cachedAccountInfo && now - _cachedAccountAt < CREDS_TTL_MS) {
    return _cachedAccountInfo;
  }

  const { creds, source } = await getCredentials();
  const stripe  = new Stripe(creds.secretKey, { apiVersion: '2025-08-27.basil' as any });
  const account = await stripe.accounts.retrieve();

  const info: StripeAccountInfo = {
    accountId:       account.id,
    displayName:     (account as any).display_name ?? (account as any).settings?.dashboard?.display_name ?? null,
    country:         account.country ?? null,
    livemode:        (account as any).livemode ?? !creds.secretKey.startsWith('sk_test'),
    secretKeyPrefix: creds.secretKey.slice(0, 12),
    pubKeyPrefix:    creds.publishableKey.slice(0, 12),
    source,
  };

  console.log('[STRIPE_ACCOUNT]', {
    accountId:       info.accountId,
    displayName:     info.displayName,
    country:         info.country,
    livemode:        info.livemode,
    source:          info.source,
    secretKeyPrefix: info.secretKeyPrefix,
    pubKeyPrefix:    info.pubKeyPrefix,
  });
  console.log(`[STRIPE_MODE] accountId=${info.accountId}`);

  _cachedAccountInfo = info;
  _cachedAccountAt   = now;
  return info;
}

// ── StripeSync (webhook wiring) ───────────────────────────────────────────────
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
