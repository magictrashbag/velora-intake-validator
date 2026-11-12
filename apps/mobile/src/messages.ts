/** Spanish (Venezuela) copy for API error/reason codes. Never show raw codes to users. */
const MESSAGES: Record<string, string> = {
  invalid_code: 'Código incorrecto o vencido.',
  too_many_requests: 'Demasiados intentos. Espera unos minutos.',
  insufficient_funds: 'Saldo insuficiente.',
  recipient_not_found: 'Ese número no tiene cuenta Puente.',
  cannot_send_to_self: 'No puedes enviarte dinero a ti mismo.',
  invalid_amount: 'Monto inválido.',
  kyc_tier_insufficient: 'Verifica tu identidad para enviar dinero.',
  limit_per_transaction: 'Supera tu límite por operación.',
  limit_daily: 'Supera tu límite diario.',
  limit_monthly: 'Supera tu límite mensual.',
  not_permitted: 'No pudimos procesar esta operación. Contacta a soporte.',
  retry: 'Reintentando…',
  network_error: 'Sin conexión. Intenta de nuevo.',
};

export const msg = (code: string) => MESSAGES[code] ?? 'Ocurrió un error. Intenta de nuevo.';
