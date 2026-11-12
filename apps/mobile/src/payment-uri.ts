/**
 * Payment QR payload: `kame://pagar?tel=<E.164 phone>` and NOTHING else.
 * Scanned codes are untrusted input: anything that isn't exactly this shape is rejected, and a
 * valid code only PREFILLS the recipient — the payer still sees the recipient's name, types the
 * amount and confirms. A QR code can never move money by itself.
 */
const E164 = /^\+[1-9][0-9]{7,14}$/;

export function buildPaymentUri(phone: string): string {
  return `kame://pagar?tel=${encodeURIComponent(phone)}`;
}

export function parsePaymentUri(data: string): { phone: string } | null {
  const m = /^kame:\/\/pagar\?tel=([^&#\s]+)$/.exec(data.trim());
  if (!m) return null;
  let phone: string;
  try { phone = decodeURIComponent(m[1]!); } catch { return null; }
  return E164.test(phone) ? { phone } : null;
}
