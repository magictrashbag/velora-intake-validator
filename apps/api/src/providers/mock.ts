import type { FxRateProvider, Currency, SanctionsScreener, CustodyProvider } from '@kame/core';

/** Delivers OTP codes. Production: a licensed SMS/WhatsApp provider. */
export interface SmsSender {
  sendOtp(phone: string, code: string): Promise<void>;
}

export const mockSms: SmsSender = { async sendOtp() {} };

/** Fixed demo rate. Production: an approved rate source; which one is a compliance decision. */
export function mockFxRates(rates: Partial<Record<`${Currency}/${Currency}`, string>> = { 'USDC/VES': '40.00' }): FxRateProvider {
  return {
    async midRate(base, quote) {
      const r = rates[`${base}/${quote}`];
      if (!r) throw new Error(`no mock rate for ${base}/${quote}`);
      return { rate: r, source: 'mock', asOf: new Date() };
    },
  };
}

/**
 * Deterministic screening mock for development/tests ONLY. Production: an OFAC-list + blockchain-
 * analytics provider. Addresses ending in "dead" are treated as sanctioned, "beef" as high-risk.
 */
export const mockScreener: SanctionsScreener = {
  // Names containing SANCTIONED / MAYBE screen as confirmed / potential matches.
  async screenPerson(p) {
    const n = p.fullName.toUpperCase();
    const result = n.includes('SANCTIONED') ? 'confirmed_match' : n.includes('MAYBE') ? 'potential_match' : 'clear';
    return { result, providerRef: `mock:${result}` };
  },
  async screenAddress(_network, address) {
    const a = address.toLowerCase();
    const risk = a.endsWith('dead') ? 'sanctioned' : a.endsWith('beef') ? 'high_risk' : 'clear';
    return { risk, providerRef: `mock:${risk}` };
  },
};

/** Custody mock for development/tests: records every withdraw call; `failNext` simulates outages. */
export function mockCustody() {
  const calls: { idempotencyKey: string; network: string; address: string; amountMinor: bigint }[] = [];
  let failNext = 0;
  let omnibus = 0n;
  const provider: CustodyProvider = {
    async createDepositAddress() { return '0x' + '9'.repeat(40); },
    async getOmnibusBalance() { return { amountMinor: omnibus, asOf: new Date() }; },
    async withdraw(req) {
      if (failNext > 0) { failNext--; throw new Error('custodian timeout'); }
      calls.push(req);
      return { providerRef: `mock-wd-${req.idempotencyKey}` };
    },
  };
  return { provider, calls, failTimes: (n: number) => { failNext = n; }, setOmnibus: (v: bigint) => { omnibus = v; } };
}
