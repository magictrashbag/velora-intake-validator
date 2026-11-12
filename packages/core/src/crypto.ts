/** Crypto rails: which assets/networks we touch and how addresses are validated. */
export type Network = 'ethereum' | 'polygon' | 'base' | 'solana';
export const NETWORKS: readonly Network[] = ['ethereum', 'polygon', 'base', 'solana'];

export function isNetwork(x: unknown): x is Network {
  return typeof x === 'string' && (NETWORKS as readonly string[]).includes(x);
}

/** Syntactic check only. Screening (sanctions / risk) is a separate, mandatory step. */
export function isValidAddress(network: Network, address: string): boolean {
  if (network === 'solana') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/** EVM addresses are case-insensitive (checksum is presentation); normalise before screening/storing. */
export function normalizeAddress(network: Network, address: string): string {
  return network === 'solana' ? address : address.toLowerCase();
}

/** Add N business days (Mon–Fri). Ignores public holidays, which only makes the date EARLIER (conservative). */
export function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}
