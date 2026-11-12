import { randomUUID } from 'expo-crypto';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: any) {
    super(code);
  }
}

async function call<T>(path: string, init: { method?: string; token?: string | null; body?: unknown; idempotencyKey?: string } = {}): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const res = await fetch(BASE + path, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 403) throw new ApiError(res.status, data.error ?? 'network_error', data);
  return { status: res.status, data };
}

export interface Wallet {
  user: { id: string; phone: string; name: string | null; kyc_tier: number; status: string };
  balances: { currency: 'USDC' | 'VES'; label: string; amount: string }[];
  activity: { id: string; kind: string; description: string; currency: string; amount: string; at: string }[];
}

export interface TransferResult { transfer_id: string; status: 'posted' | 'held_for_review' | 'denied'; reasons?: string[] }

export interface Quote {
  quote_id: string;
  sell: { currency: 'USDC' | 'VES'; amount: string };
  buy: { currency: 'USDC' | 'VES'; amount: string };
  mid_rate: string;
  spread_bps: number;
  expires_at: string;
}

export type Network = 'polygon' | 'base' | 'ethereum' | 'solana';

export interface Me {
  id: string;
  phone: string;
  name: string | null;
  kyc_tier: 0 | 1 | 2;
  status: string;
  country: string;
  member_since: string;
  limits: { per_transaction_usd: string; daily_usd: string; monthly_usd: string } | null;
  payment_uri: string;
}

export const api = {
  startOtp: (phone: string) => call<{ sent: boolean; dev_code?: string }>('/v1/auth/otp/start', { method: 'POST', body: { phone } }),
  verifyOtp: (phone: string, code: string) =>
    call<{ token: string }>('/v1/auth/otp/verify', { method: 'POST', body: { phone, code } }),
  logout: (token: string) => call('/v1/auth/logout', { method: 'POST', token }),
  wallet: (token: string) => call<Wallet>('/v1/wallet', { token }),
  me: (token: string) => call<Me>('/v1/me', { token }),
  /** Confirmation of payee: masked name for a phone, shown before the payer confirms. */
  lookupRecipient: (token: string, phone: string) =>
    call<{ found: boolean; display_name?: string }>(`/v1/recipients/lookup?phone=${encodeURIComponent(phone)}`, { token }),
  /** The idempotency key is created once per user intent and reused on retries, so a
   *  flaky connection can never send money twice. */
  newIdempotencyKey: () => randomUUID(),
  send: (token: string, toPhone: string, amount: string, idempotencyKey: string) =>
    call<TransferResult>('/v1/transfers', {
      method: 'POST', token, idempotencyKey, body: { to_phone: toPhone, amount, currency: 'USDC' },
    }),
  quote: (token: string, sell: 'USDC' | 'VES', buy: 'USDC' | 'VES', amount: string) =>
    call<Quote>('/v1/fx/quotes', { method: 'POST', token, body: { sell, buy, amount } }),
  /** Executing a quote is idempotent server-side (one execution per quote id). */
  executeQuote: (token: string, quoteId: string) =>
    call<TransferResult>(`/v1/fx/quotes/${quoteId}/execute`, { method: 'POST', token }),
  withdraw: (token: string, idempotencyKey: string, body: {
    network: Network; address: string; amount: string;
    travel_rule?: { beneficiary_name: string; wallet_type: 'self_hosted' | 'vasp'; vasp_name?: string };
  }) => call<TransferResult>('/v1/crypto/withdrawals', { method: 'POST', token, idempotencyKey, body }),
};
