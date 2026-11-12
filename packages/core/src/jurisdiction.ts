/**
 * Jurisdiction controls. Comprehensively embargoed under US sanctions (as of Nov 2026; verify
 * against OFAC): Cuba, Iran, North Korea, and the Crimea / so-called DNR / LNR regions of Ukraine.
 * Syria's comprehensive program was revoked by EO 14312 (June 2025) — listed persons remain
 * blocked and are caught by party screening. Counsel owns these lists.
 */
export const BLOCKED_COUNTRIES: ReadonlySet<string> = new Set(['CU', 'IR', 'KP']);

/** Phone prefixes refused at sign-up. +7978 / +7959 are numbering used in occupied Crimea and
 *  the Donetsk/Luhansk regions. A phone prefix is a first filter only: KYC address, IP geolocation
 *  and device signals must also be checked (OFAC virtual-currency guidance recommends geolocation). */
export const BLOCKED_PHONE_PREFIXES: readonly string[] = ['+53', '+98', '+850', '+7978', '+7959', '+7949'];

const PHONE_COUNTRY: [string, string][] = [
  ['+58', 'VE'], ['+57', 'CO'], ['+56', 'CL'], ['+51', 'PE'], ['+593', 'EC'], ['+507', 'PA'],
  ['+52', 'MX'], ['+54', 'AR'], ['+55', 'BR'], ['+34', 'ES'], ['+351', 'PT'], ['+39', 'IT'],
  ['+1', 'US'], ['+53', 'CU'], ['+98', 'IR'], ['+850', 'KP'],
];

export function isBlockedPhone(phone: string): boolean {
  return BLOCKED_PHONE_PREFIXES.some((p) => phone.startsWith(p));
}

/** Best-effort country from E.164 (longest prefix wins). 'ZZ' = unknown; KYC sets the real one. */
export function phoneCountry(phone: string): string {
  let best: [string, string] | undefined;
  for (const e of PHONE_COUNTRY) if (phone.startsWith(e[0]) && (!best || e[0].length > best[0].length)) best = e;
  return best?.[1] ?? 'ZZ';
}
