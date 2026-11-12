import type { FxRateProvider, Currency, SanctionsScreener } from '@puente/core';

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
 * Party screening returns 'pending' so nothing is auto-cleared.
 */
export const mockScreener: SanctionsScreener = {
  async screenPerson() { return { result: 'pending', providerRef: 'mock' }; },
  async screenAddress(_network, address) {
    const a = address.toLowerCase();
    const risk = a.endsWith('dead') ? 'sanctioned' : a.endsWith('beef') ? 'high_risk' : 'clear';
    return { risk, providerRef: `mock:${risk}` };
  },
};
