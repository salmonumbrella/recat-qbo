import type { TaxCalculation } from '@recat/shared';
import type { QboTaxCodeInfo, QboTaxRateInfo } from './types.js';

/** Largest percentage exactly storable by Prisma Decimal(9,6). */
export const MAX_SUPPORTED_TAX_RATE_PERCENT = 999.999999;

export function isSupportedTaxRateValue(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_SUPPORTED_TAX_RATE_PERCENT
  );
}

export interface CalculatedPurchaseLine {
  grossCents: number;
  netCents: number;
  taxCents: number;
}

export type PurchaseTaxTreatment = 'standard' | 'zero_rated' | 'exempt' | 'out_of_scope';

export type PurchaseTaxIneligibilityReason =
  | 'TAX_AMOUNT_INVALID'
  | 'TAX_AMOUNT_SIGN_MISMATCH'
  | 'TAX_COMPANY_MISMATCH'
  | 'TAX_CODE_UNAVAILABLE'
  | 'TAX_CODE_INACTIVE'
  | 'TAX_CODE_MALFORMED'
  | 'TAX_CODE_SALES_ONLY'
  | 'TAX_RATE_UNAVAILABLE'
  | 'TAX_RATE_INACTIVE'
  | 'TAX_RATE_MALFORMED'
  | 'TAX_RATE_UNSUPPORTED'
  | 'TAX_TREATMENT_AMBIGUOUS';

export interface PurchaseTaxLineInput {
  grossCents: number;
  taxCodeQboId: string;
  /**
   * QBO's normalized TaxCode fields do not distinguish these treatments.
   * Callers must supply the accounting treatment explicitly.
   */
  nonTaxTreatment?: 'exempt' | 'out_of_scope';
}

export type PurchaseTaxTransactionResult =
  | {
      eligible: true;
      grossCents: number;
      netCents: number;
      taxCents: number;
      lines: (CalculatedPurchaseLine & {
        taxCodeQboId: string;
        treatment: PurchaseTaxTreatment;
      })[];
    }
  | {
      eligible: false;
      reason: PurchaseTaxIneligibilityReason;
      lineIndex?: number;
    };

export class PurchaseTaxError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PurchaseTaxError';
  }
}

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  const sign = numerator < 0n ? -1n : 1n;
  const unsignedNumerator = numerator < 0n ? -numerator : numerator;
  const quotient = unsignedNumerator / denominator;
  const remainder = unsignedNumerator % denominator;
  return sign * (remainder * 2n >= denominator ? quotient + 1n : quotient);
}

function rateValueToRatio(rateValue: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(rateValue) || rateValue < 0) throw new PurchaseTaxError('TAX_RATE_UNSUPPORTED');

  const decimal = rateValue.toString().toLowerCase();
  const exponentIndex = decimal.indexOf('e');
  const coefficient = exponentIndex === -1 ? decimal : decimal.slice(0, exponentIndex);
  const exponent = exponentIndex === -1 ? 0 : Number(decimal.slice(exponentIndex + 1));
  const decimalIndex = coefficient.indexOf('.');
  const whole = decimalIndex === -1 ? coefficient : coefficient.slice(0, decimalIndex);
  const fraction = decimalIndex === -1 ? '' : coefficient.slice(decimalIndex + 1);
  const digits = `${whole}${fraction}`.replace(/^0+/, '') || '0';
  const scale = exponent - fraction.length;
  const unscaled = BigInt(digits);

  return scale >= 0
    ? { numerator: unscaled * 10n ** BigInt(scale), denominator: 1n }
    : { numerator: unscaled, denominator: 10n ** BigInt(-scale) };
}

function toSafeCents(value: bigint): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PurchaseTaxError('TAX_AMOUNT_INVALID');
  }
  return Number(value);
}

interface ResolvedTaxLine {
  rateQboId: string | null;
  rate: { numerator: bigint; denominator: bigint } | null;
  treatment: PurchaseTaxTreatment;
}

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function runtimeReferenceFailure(
  reference: unknown,
): 'TAX_CODE_MALFORMED' | 'TAX_RATE_MALFORMED' | null {
  if (!isRuntimeRecord(reference) || !Array.isArray(reference.codes) || !Array.isArray(reference.rates)) {
    return 'TAX_CODE_MALFORMED';
  }
  for (const code of reference.codes) {
    if (
      !isRuntimeRecord(code) ||
      !isNonEmptyIdentity(code.qboId) ||
      typeof code.active !== 'boolean' ||
      (code.taxable !== null && typeof code.taxable !== 'boolean') ||
      !Array.isArray(code.purchaseRates)
    ) {
      return 'TAX_CODE_MALFORMED';
    }
    for (const component of code.purchaseRates) {
      if (
        !isRuntimeRecord(component) ||
        !isNonEmptyIdentity(component.taxRateQboId) ||
        !isNonEmptyIdentity(component.taxTypeApplicable)
      ) {
        return 'TAX_RATE_MALFORMED';
      }
    }
  }
  for (const rate of reference.rates) {
    if (
      !isRuntimeRecord(rate) ||
      !isNonEmptyIdentity(rate.qboId) ||
      typeof rate.active !== 'boolean' ||
      !isSupportedTaxRateValue(rate.rateValue)
    ) {
      return 'TAX_RATE_MALFORMED';
    }
  }
  return null;
}

function resolveTaxLine(
  input: PurchaseTaxLineInput,
  taxCalculation: TaxCalculation,
  reference: { codes: QboTaxCodeInfo[]; rates: QboTaxRateInfo[] },
): ResolvedTaxLine | PurchaseTaxIneligibilityReason {
  if (!isNonEmptyIdentity(input.taxCodeQboId)) return 'TAX_CODE_MALFORMED';
  const code = reference.codes.find((candidate) => candidate.qboId === input.taxCodeQboId);
  if (!code) return 'TAX_CODE_UNAVAILABLE';
  if (!isNonEmptyIdentity(code.qboId) || typeof code.active !== 'boolean') return 'TAX_CODE_MALFORMED';
  if (!code.active) return 'TAX_CODE_INACTIVE';
  if (code.taxable === null) return 'TAX_CODE_MALFORMED';
  if (!Array.isArray(code.purchaseRates)) return 'TAX_CODE_MALFORMED';

  if (code.taxable === false) {
    if (code.purchaseRates.length !== 0) return 'TAX_CODE_MALFORMED';
    if (input.nonTaxTreatment === undefined) return 'TAX_TREATMENT_AMBIGUOUS';
    return { rateQboId: null, rate: null, treatment: input.nonTaxTreatment };
  }

  if (taxCalculation === 'NotApplicable') return 'TAX_CODE_MALFORMED';
  if (code.taxable !== true) return 'TAX_CODE_MALFORMED';
  if (code.purchaseRates.length === 0) return 'TAX_CODE_SALES_ONLY';
  if (code.purchaseRates.length !== 1) return 'TAX_RATE_UNSUPPORTED';
  const component = code.purchaseRates[0];
  if (
    !isRuntimeRecord(component) ||
    !isNonEmptyIdentity(component.taxRateQboId) ||
    !isNonEmptyIdentity(component.taxTypeApplicable)
  ) {
    return 'TAX_RATE_MALFORMED';
  }
  if (component.taxTypeApplicable !== 'TaxOnAmount') return 'TAX_RATE_UNSUPPORTED';

  const taxRate = reference.rates.find((candidate) => candidate.qboId === component.taxRateQboId);
  if (!taxRate) return 'TAX_RATE_UNAVAILABLE';
  if (!isNonEmptyIdentity(taxRate.qboId) || typeof taxRate.active !== 'boolean') {
    return 'TAX_RATE_MALFORMED';
  }
  if (!taxRate.active) return 'TAX_RATE_INACTIVE';
  if (!isSupportedTaxRateValue(taxRate.rateValue)) return 'TAX_RATE_MALFORMED';

  return {
    rateQboId: taxRate.qboId,
    rate: rateValueToRatio(taxRate.rateValue),
    treatment: taxRate.rateValue === 0 ? 'zero_rated' : 'standard',
  };
}

function sumSafe(values: number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function allocateExcludedTax(
  lines: PurchaseTaxTransactionResult & { eligible: true },
  indexes: number[],
  rate: { numerator: bigint; denominator: bigint },
): PurchaseTaxIneligibilityReason | null {
  const taxDenominator = rate.denominator * 100n;
  const taxableBase = sumSafe(indexes.map((index) => lines.lines[index]!.grossCents));
  if (taxableBase === null) return 'TAX_AMOUNT_INVALID';

  let targetTax: number;
  try {
    targetTax = toSafeCents(roundRatio(BigInt(taxableBase) * rate.numerator, taxDenominator));
  } catch {
    return 'TAX_AMOUNT_INVALID';
  }

  const sign = targetTax < 0 ? -1 : 1;
  const shares = indexes.map((index) => {
    const numerator = BigInt(Math.abs(lines.lines[index]!.grossCents)) * rate.numerator;
    return {
      index,
      taxCents: numerator / taxDenominator,
      remainder: numerator % taxDenominator,
    };
  });
  const floorTotal = shares.reduce((sum, share) => sum + share.taxCents, 0n);
  let centsToAllocate = BigInt(Math.abs(targetTax)) - floorTotal;
  const priority = [...shares].sort(
    (left, right) =>
      left.remainder === right.remainder
        ? left.index - right.index
        : left.remainder > right.remainder
          ? -1
          : 1,
  );
  for (const share of priority) {
    if (centsToAllocate === 0n) break;
    share.taxCents += 1n;
    centsToAllocate -= 1n;
  }
  for (const share of shares) {
    lines.lines[share.index]!.taxCents = toSafeCents(BigInt(sign) * share.taxCents);
  }
  return null;
}

/**
 * Authoritative structured purchase-tax calculator.
 *
 * Tax-exclusive components are aggregated by QBO TaxRate reference and
 * rounded once. Tax-inclusive net amounts are back-calculated and rounded per
 * line, matching Intuit's documented non-US workflow.
 */
export function calculatePurchaseTransaction(
  input: { companyId: string; taxCalculation: TaxCalculation; lines: PurchaseTaxLineInput[] },
  reference: { companyId: string; codes: QboTaxCodeInfo[]; rates: QboTaxRateInfo[] },
): PurchaseTaxTransactionResult {
  if (
    !isNonEmptyIdentity(input.companyId) ||
    !isNonEmptyIdentity(reference.companyId) ||
    input.companyId !== reference.companyId
  ) {
    return { eligible: false, reason: 'TAX_COMPANY_MISMATCH' };
  }
  if (input.lines.length === 0) return { eligible: false, reason: 'TAX_AMOUNT_INVALID' };
  if (input.lines.some((line) => !Number.isSafeInteger(line.grossCents))) {
    return { eligible: false, reason: 'TAX_AMOUNT_INVALID' };
  }
  const referenceFailure = runtimeReferenceFailure(reference);
  if (referenceFailure) {
    return { eligible: false, reason: referenceFailure, lineIndex: 0 };
  }

  const nonZeroSigns = new Set(
    input.lines
      .filter((line) => line.grossCents !== 0)
      .map((line) => Math.sign(line.grossCents)),
  );
  if (nonZeroSigns.size > 1) {
    return { eligible: false, reason: 'TAX_AMOUNT_SIGN_MISMATCH' };
  }

  const resolved: ResolvedTaxLine[] = [];
  for (const [lineIndex, line] of input.lines.entries()) {
    const resolution = resolveTaxLine(line, input.taxCalculation, reference);
    if (typeof resolution === 'string') {
      return { eligible: false, reason: resolution, lineIndex };
    }
    resolved.push(resolution);
  }

  const grossCents = sumSafe(input.lines.map((line) => line.grossCents));
  if (grossCents === null) return { eligible: false, reason: 'TAX_AMOUNT_INVALID' };

  const result: PurchaseTaxTransactionResult & { eligible: true } = {
    eligible: true,
    grossCents,
    netCents: 0,
    taxCents: 0,
    lines: input.lines.map((line, index) => ({
      grossCents: line.grossCents,
      netCents: line.grossCents,
      taxCents: 0,
      taxCodeQboId: line.taxCodeQboId,
      treatment: resolved[index]!.treatment,
    })),
  };

  if (input.taxCalculation === 'TaxInclusive') {
    for (const [index, resolution] of resolved.entries()) {
      if (!resolution.rate) continue;
      const gross = BigInt(result.lines[index]!.grossCents);
      const denominator = resolution.rate.denominator * 100n;
      try {
        const net = toSafeCents(
          roundRatio(gross * denominator, denominator + resolution.rate.numerator),
        );
        result.lines[index]!.netCents = net;
        result.lines[index]!.taxCents = result.lines[index]!.grossCents - net;
      } catch {
        return { eligible: false, reason: 'TAX_AMOUNT_INVALID', lineIndex: index };
      }
    }
  } else if (input.taxCalculation === 'TaxExcluded') {
    const componentGroups = new Map<string, { indexes: number[]; rate: ResolvedTaxLine['rate'] }>();
    for (const [index, resolution] of resolved.entries()) {
      if (!resolution.rateQboId || !resolution.rate) continue;
      const group = componentGroups.get(resolution.rateQboId);
      if (group) group.indexes.push(index);
      else componentGroups.set(resolution.rateQboId, { indexes: [index], rate: resolution.rate });
    }
    for (const group of componentGroups.values()) {
      const failure = allocateExcludedTax(result, group.indexes, group.rate!);
      if (failure) return { eligible: false, reason: failure };
    }
  }

  const netCents = sumSafe(result.lines.map((line) => line.netCents));
  const taxCents = sumSafe(result.lines.map((line) => line.taxCents));
  if (netCents === null || taxCents === null) {
    return { eligible: false, reason: 'TAX_AMOUNT_INVALID' };
  }
  result.netCents = netCents;
  result.taxCents = taxCents;
  return result;
}

export function calculatePurchaseLine(
  input: { grossCents: number; taxCalculation: TaxCalculation; taxCodeQboId: string },
  reference: { codes: QboTaxCodeInfo[]; rates: QboTaxRateInfo[] },
): CalculatedPurchaseLine {
  if (!Number.isSafeInteger(input.grossCents)) throw new PurchaseTaxError('TAX_AMOUNT_INVALID');

  const code = reference.codes.find((candidate) => candidate.qboId === input.taxCodeQboId);
  if (!code || !code.active) throw new PurchaseTaxError('TAX_CODE_UNAVAILABLE');
  if (input.taxCalculation === 'NotApplicable') {
    if (code.taxable !== false) throw new PurchaseTaxError('TAX_RATE_UNSUPPORTED');
    return { grossCents: input.grossCents, netCents: input.grossCents, taxCents: 0 };
  }
  if (code.purchaseRates.length !== 1 || code.purchaseRates[0]?.taxTypeApplicable !== 'TaxOnAmount') {
    throw new PurchaseTaxError('TAX_RATE_UNSUPPORTED');
  }

  const taxRate = reference.rates.find((candidate) => candidate.qboId === code.purchaseRates[0]?.taxRateQboId);
  if (!taxRate || !taxRate.active) throw new PurchaseTaxError('TAX_RATE_UNAVAILABLE');
  if (!isSupportedTaxRateValue(taxRate.rateValue)) throw new PurchaseTaxError('TAX_RATE_UNSUPPORTED');
  const rate = rateValueToRatio(taxRate.rateValue);

  const grossCents = BigInt(input.grossCents);
  const taxDenominator = rate.denominator * 100n;
  const netCents = input.taxCalculation === 'TaxInclusive'
    ? roundRatio(grossCents * taxDenominator, taxDenominator + rate.numerator)
    : grossCents;
  const taxCents = input.taxCalculation === 'TaxInclusive'
    ? grossCents - netCents
    : roundRatio(grossCents * rate.numerator, taxDenominator);

  return {
    grossCents: input.grossCents,
    netCents: toSafeCents(netCents),
    taxCents: toSafeCents(taxCents),
  };
}
