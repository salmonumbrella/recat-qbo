import type { TaxCalculation } from '@recat/shared';

export interface QboRecategorizationPlan {
  qboType: string;
  signedTransactionAmountCents: number;
  taxCalculation: TaxCalculation;
  lines: { grossCents: number; accountQboId: string; taxCodeQboId: string }[];
}

export function moneyToCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new Error('Amount must be finite.');

  const decimal = amount.toString().toLowerCase();
  const exponentIndex = decimal.indexOf('e');
  const coefficient = exponentIndex === -1 ? decimal : decimal.slice(0, exponentIndex);
  const exponent = exponentIndex === -1 ? 0 : Number(decimal.slice(exponentIndex + 1));
  const negative = coefficient.startsWith('-');
  const unsignedCoefficient = coefficient.replace(/^[+-]/, '');
  const decimalIndex = unsignedCoefficient.indexOf('.');
  const whole = decimalIndex === -1 ? unsignedCoefficient : unsignedCoefficient.slice(0, decimalIndex);
  const fraction = decimalIndex === -1 ? '' : unsignedCoefficient.slice(decimalIndex + 1);
  const digits = `${whole}${fraction}`.replace(/^0+/, '') || '0';
  const scale = exponent - fraction.length + 2;
  const unscaled = BigInt(digits);

  let cents: bigint;
  if (scale >= 0) {
    cents = unscaled * 10n ** BigInt(scale);
  } else {
    const divisor = 10n ** BigInt(-scale);
    const quotient = unscaled / divisor;
    const remainder = unscaled % divisor;
    cents = remainder * 2n >= divisor ? quotient + 1n : quotient;
  }

  const signedCents = negative ? -cents : cents;
  if (
    signedCents < BigInt(Number.MIN_SAFE_INTEGER) ||
    signedCents > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Amount must convert to safe integer cents.');
  }

  return Number(signedCents);
}

export function validateRecategorizationPlan(plan: QboRecategorizationPlan): void {
  if (plan.qboType !== 'Purchase') throw new Error('Tax is supported only for Purchase.');
  if (plan.lines.length === 0) throw new Error('At least one line is required.');
  if (!Number.isSafeInteger(plan.signedTransactionAmountCents)) {
    throw new Error('Signed transaction amount must be a safe integer.');
  }
  if (plan.lines.some((line) => !Number.isSafeInteger(line.grossCents))) {
    throw new Error('Gross line amounts must be integer cents.');
  }

  let total = 0;
  for (const line of plan.lines) {
    total += line.grossCents;
    if (!Number.isSafeInteger(total)) {
      throw new Error('Gross line total must be a safe integer.');
    }
  }
  if (total !== plan.signedTransactionAmountCents) {
    throw new Error('Gross lines must equal the signed transaction amount.');
  }
}
