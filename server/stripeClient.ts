import Stripe from 'stripe';

// ── Credential loading ────────────────────────────────────────────────────────
// Reads ONLY from environment variables — no Replit connector, no sandbox claim.
// Required vars: STRIPE_SECRET_KEY + (STRIPE_PUBLISHABLE_KEY or VITE_STRIPE_PUBLISHABLE_KEY)

type Credentials = { secretKey: string; publishableKey: string };

let _cachedCreds: Credentials | null = null;
let _cachedCredsAt = 0;
const CREDS_TTL_MS = 5 * 60 * 1000; // 5 minutes

function loadCredentials(): Credentials {
  const secretKey =
    process.env.STRIPE_SECRET_KEY ?? '';

  const publishableKey =
    process.env.STRIPE_PUBLISHABLE_KEY ??
    process.env.VITE_STRIPE_PUBLISHABLE_KEY ??
    '';

  if (!secretKey) {
    throw new Error(
      '[STRIPE_CLIENT] STRIPE_SECRET_KEY is not set. ' +
      'Add it to Replit Secrets and redeploy.',
    );
  }
  if (!publishableKey) {
    throw new Error(
      '[STRIPE_CLIENT] Neither STRIPE_PUBLISHABLE_KEY nor VITE_STRIPE_PUBLISHABLE_KEY is set. ' +
      'Add one to Replit Secrets and redeploy.',
    );
  }

  return { secretKey, publishableKey };
}

function getCredentials(): Credentials {
  const now = Date.now();
  if (_cachedCreds && now - _cachedCredsAt < CREDS_TTL_MS) {
    return _cachedCreds;
  }

  const creds = loadCredentials();

  _cachedCreds    = creds;
  _cachedCredsAt  = now;

  _logCredentials(creds);
  return creds;
}

function _logCredentials(creds: Credentials): void {
  const keyMode  = creds.secretKey.startsWith('sk_live')  ? 'LIVE'    :
                   creds.secretKey.startsWith('sk_test')  ? 'TEST'    : 'UNKNOWN';
  const pubMode  = creds.publishableKey.startsWith('pk_live') ? 'LIVE' :
                   creds.publishableKey.startsWith('pk_test') ? 'TEST' : 'UNKNOWN';

  const pubParts  = creds.publishableKey.split('_');
  const acctFrag  = pubParts.length >= 3 ? (pubParts[2]?.slice(0, 8) ?? '') + '…' : '(unknown)';
  const livemode  = keyMode === 'LIVE';

  if (keyMode !== pubMode) {
    console.error(
      `[STRIPE_CLIENT] ⚠ KEY MODE MISMATCH — secret=${keyMode} publishable=${pubMode}. ` +
      'Keys must belong to the same Stripe account and mode.',
    );
  }

  const secretPrefix = livemode ? 'sk_live' : 'sk_test';
  const pubPrefix    = creds.publishableKey.startsWith('pk_live') ? 'pk_live' : 'pk_test';
  const isProduction = process.env.REPLIT_DEPLOYMENT === '1';

  // ── summary line ─────────────────────────────────────────────────────────
  console.log(
    `[STRIPE_CLIENT] ✓ Credentials loaded — source=env mode=${keyMode} ` +
    `acct=…${acctFrag} secret=${secretPrefix}_…${creds.secretKey.slice(-4)} ` +
    `pub=${pubPrefix}_…${creds.publishableKey.slice(-4)}`,
  );

  // ── [STRIPE_MODE] block (exact format for ops monitoring) ─────────────
  console.log(`[STRIPE_MODE] source=env`);
  console.log(`[STRIPE_MODE] livemode=${livemode}`);
  console.log(`[STRIPE_MODE] secretKeyPrefix=${secretPrefix}`);
  console.log(`[STRIPE_MODE] publishableKeyPrefix=${pubPrefix}`);

  if (!livemode) {
    if (isProduction) {
      console.error(
        '\n╔══════════════════════════════════════════════════════════════════╗\n' +
        '║  ⛔  STRIPE TEST KEYS IN PRODUCTION                             ║\n' +
        '║  Real money will NOT be charged.                                ║\n' +
        '║  Update STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY to live keys ║\n' +
        '║  in Replit Secrets and redeploy to enable live payments.        ║\n' +
        '╚══════════════════════════════════════════════════════════════════╝\n',
      );
    } else {
      console.log(
        '[STRIPE_CLIENT] ℹ Running in TEST mode. ' +
        'To see sessions: dashboard.stripe.com → toggle "Test mode" → Payments → Checkout.',
      );
    }
  }
}

// ── Public helpers ────────────────────────────────────────────────────────────

export function getUncachableStripeClient(): Stripe {
  const { secretKey } = getCredentials();
  return new Stripe(secretKey, { apiVersion: '2025-08-27.basil' as any });
}

export function getStripePublishableKey(): string {
  return getCredentials().publishableKey;
}

export function getStripeSecretKey(): string {
  return getCredentials().secretKey;
}

// ── Mode descriptor ───────────────────────────────────────────────────────────
export type StripeModeInfo = {
  source: 'env';
  livemode: boolean;
  /** true when running in production with test keys — checkout should be blocked */
  isBlocked: boolean;
  secretSuffix: string;
  pubSuffix: string;
};

export function getStripeMode(): StripeModeInfo {
  const creds        = getCredentials();
  const livemode     = creds.secretKey.startsWith('sk_live_');
  const isProduction = process.env.REPLIT_DEPLOYMENT === '1';
  const isBlocked    = isProduction && !livemode;
  return {
    source: 'env',
    livemode,
    isBlocked,
    secretSuffix: creds.secretKey.slice(-4),
    pubSuffix:    creds.publishableKey.slice(-4),
  };
}

/**
 * Call at the top of any checkout endpoint.
 * Throws a 402 payload if the app is in production but only has test keys,
 * so real users never see a test-mode checkout session.
 */
export function checkStripeReady(): void {
  const mode = getStripeMode();
  if (mode.isBlocked) {
    throw Object.assign(
      new Error('Payments are still in test mode. Live keys have not been configured.'),
      { statusCode: 402, code: 'stripe_test_mode_blocked' },
    );
  }
}

// ── Stripe account info (cached, calls accounts.retrieve()) ──────────────────
export type StripeAccountInfo = {
  accountId:       string;
  displayName:     string | null;
  country:         string | null;
  livemode:        boolean;
  secretKeyPrefix: string;
  pubKeyPrefix:    string;
  source:          'env';
};

let _cachedAccountInfo: StripeAccountInfo | null = null;
let _cachedAccountAt = 0;

export async function getStripeAccountInfo(): Promise<StripeAccountInfo> {
  const now = Date.now();
  if (_cachedAccountInfo && now - _cachedAccountAt < CREDS_TTL_MS) {
    return _cachedAccountInfo;
  }

  const creds   = getCredentials();
  const stripe  = new Stripe(creds.secretKey, { apiVersion: '2025-08-27.basil' as any });
  const account = await stripe.accounts.retrieve();

  const info: StripeAccountInfo = {
    accountId:       account.id,
    displayName:     (account as any).display_name
                       ?? (account as any).settings?.dashboard?.display_name
                       ?? null,
    country:         account.country ?? null,
    livemode:        (account as any).livemode ?? !creds.secretKey.startsWith('sk_test'),
    secretKeyPrefix: creds.secretKey.slice(0, 12),
    pubKeyPrefix:    creds.publishableKey.slice(0, 12),
    source:          'env',
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

// ── Webhook secret ─────────────────────────────────────────────────────────
// Reads from STRIPE_WEBHOOK_SECRET env var first, then falls back to the
// stripe._managed_webhooks table that was created by the old stripe-replit-sync setup.
let _cachedWebhookSecret: string | null = null;

export async function getWebhookSecret(): Promise<string> {
  if (_cachedWebhookSecret) return _cachedWebhookSecret;

  // 1. Env var takes precedence
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    _cachedWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    console.log('[STRIPE_WEBHOOK] Secret loaded from STRIPE_WEBHOOK_SECRET env var');
    return _cachedWebhookSecret;
  }

  // 2. Fall back to the _managed_webhooks table
  try {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
    const isLive = (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live');
    const result = await pool.query<{ secret: string }>(
      `SELECT secret FROM stripe._managed_webhooks WHERE livemode = $1 AND secret IS NOT NULL ORDER BY created DESC LIMIT 1`,
      [isLive],
    );
    await pool.end();
    const secret = result.rows[0]?.secret ?? null;
    if (secret) {
      _cachedWebhookSecret = secret;
      console.log(`[STRIPE_WEBHOOK] Secret loaded from _managed_webhooks (livemode=${isLive})`);
      return _cachedWebhookSecret;
    }
  } catch (err: any) {
    console.warn('[STRIPE_WEBHOOK] Could not read secret from _managed_webhooks:', err.message);
  }

  throw new Error(
    '[STRIPE_WEBHOOK] No webhook signing secret found. ' +
    'Set STRIPE_WEBHOOK_SECRET in Replit Secrets, or ensure the stripe._managed_webhooks table is populated.',
  );
}
