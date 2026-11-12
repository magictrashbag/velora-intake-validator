export interface Config {
  databaseUrl: string;
  port: number;
  /** Enables /v1/dev/* and returns OTP codes in responses. */
  devMode: boolean;
  /** Server-side secret mixed into OTP hashes. */
  otpPepper: string;
  /** Shared secret for HMAC-signed custodian webhooks. */
  custodyWebhookSecret: string;
  /** Which proxies may set X-Forwarded-For (comma-separated IPs/CIDRs of OUR load balancers).
   *  Default: trust nobody, so clients cannot spoof the IP recorded in the audit log. */
  trustProxy: string | false;
  sessionTtlHours: number;
  fxSpreadBps: number;
  fxQuoteTtlSeconds: number;
  policyVersion: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Fail closed: dev routes need an EXPLICIT development/test NODE_ENV. Unset => production rules.
  const devMode = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  const otpPepper = env.OTP_PEPPER ?? (devMode ? 'dev-only-pepper' : '');
  if (!otpPepper) throw new Error('OTP_PEPPER is required outside development');
  const custodyWebhookSecret = env.CUSTODY_WEBHOOK_SECRET ?? (devMode ? 'dev-only-webhook-secret' : '');
  if (!custodyWebhookSecret) throw new Error('CUSTODY_WEBHOOK_SECRET is required outside development');
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://kame:kame@localhost:5432/kame',
    port: Number(env.PORT ?? 3000),
    devMode,
    otpPepper,
    custodyWebhookSecret,
    trustProxy: env.TRUST_PROXY || false,
    sessionTtlHours: 12,
    fxSpreadBps: 150,
    fxQuoteTtlSeconds: 30,
    policyVersion: 'placeholder-2026-11c',
  };
}
