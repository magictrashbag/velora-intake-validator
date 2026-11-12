export interface Config {
  databaseUrl: string;
  port: number;
  /** Enables /v1/dev/* and returns OTP codes in responses. */
  devMode: boolean;
  /** Server-side secret mixed into OTP hashes. */
  otpPepper: string;
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
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://puente:puente@localhost:5432/puente',
    port: Number(env.PORT ?? 3000),
    devMode,
    otpPepper,
    sessionTtlHours: 12,
    fxSpreadBps: 150,
    fxQuoteTtlSeconds: 30,
    policyVersion: 'placeholder-2026-11',
  };
}
