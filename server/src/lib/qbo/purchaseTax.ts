import { createHash } from 'node:crypto';
import type { StagedCategorization, TaxCalculation } from '@recat/shared';
import {
  QboSyncTokenConflict,
  type QboPreparedWrite,
  type QboPurchaseExpectedState,
  type QboPurchaseSnapshot,
  type QboTaxCodeInfo,
  type QboTaxRateInfo,
  type RawPurchase,
  type RawPurchaseLine,
} from './types.js';

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

export type QboPurchasePreparationCode =
  | 'QBO_AMOUNT_UNSAFE'
  | 'QBO_PURCHASE_UNSUPPORTED'
  | 'QBO_REFERENCE_MISSING'
  | 'QBO_STATE_DRIFT';

export class QboPurchasePreparationError extends Error {
  constructor(
    public readonly code: QboPurchasePreparationCode,
    message: string,
  ) {
    super(message);
    this.name = 'QboPurchasePreparationError';
  }
}

const MAX_EXACT_MONEY_CENTS = Math.floor(Number.MAX_SAFE_INTEGER / 100);

function preparationError(code: QboPurchasePreparationCode, message: string): never {
  throw new QboPurchasePreparationError(code, message);
}

function exactCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return preparationError('QBO_AMOUNT_UNSAFE', 'Purchase money must be a finite number.');
  }
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (
    !Number.isSafeInteger(cents) ||
    Math.abs(cents) > MAX_EXACT_MONEY_CENTS ||
    Math.abs(scaled - cents) > 1e-7
  ) {
    return preparationError('QBO_AMOUNT_UNSAFE', 'Purchase money is not representable as exact safe cents.');
  }
  return cents;
}

function moneyFromCents(cents: number): number {
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_EXACT_MONEY_CENTS) {
    return preparationError('QBO_AMOUNT_UNSAFE', 'Prepared Purchase cents exceed the exact money range.');
  }
  const money = Math.abs(cents) / 100;
  if (exactCents(money) !== Math.abs(cents)) {
    return preparationError('QBO_AMOUNT_UNSAFE', 'Prepared Purchase cents cannot be serialized exactly.');
  }
  return money;
}

function safeCentSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_EXACT_MONEY_CENTS) {
      return preparationError('QBO_AMOUNT_UNSAFE', 'Prepared Purchase cents are unsafe.');
    }
    total += value;
    if (!Number.isSafeInteger(total) || Math.abs(total) > MAX_EXACT_MONEY_CENTS) {
      return preparationError('QBO_AMOUNT_UNSAFE', 'Prepared Purchase cent total is unsafe.');
    }
  }
  return total;
}

function requiredIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return preparationError('QBO_REFERENCE_MISSING', `Purchase ${label} is missing.`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function normalizedClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function requestHash(body: RawPurchase): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function purchaseSign(raw: RawPurchase): 1 | -1 {
  return raw.Credit === true ? 1 : -1;
}

function snapshotLine(raw: RawPurchaseLine, sign: 1 | -1): QboPurchaseSnapshot['lines'][number] {
  const detail = raw.AccountBasedExpenseLineDetail;
  return {
    id: raw.Id ?? null,
    amountCents: sign * exactCents(raw.Amount ?? 0),
    description: raw.Description ?? null,
    accountQboId: detail?.AccountRef?.value ?? null,
    customerQboId: detail?.CustomerRef?.value ?? null,
    classQboId: detail?.ClassRef?.value ?? null,
    taxCodeQboId: detail?.TaxCodeRef?.value ?? null,
    taxAmountCents: detail?.TaxAmount === undefined ? null : sign * exactCents(detail.TaxAmount),
    taxInclusiveCents:
      detail?.TaxInclusiveAmt === undefined ? null : sign * exactCents(detail.TaxInclusiveAmt),
  };
}

function snapshotFromRaw(raw: RawPurchase): QboPurchaseSnapshot {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray(raw.Line) ||
    typeof raw.Id !== 'string' ||
    raw.Id.trim() === '' ||
    typeof raw.SyncToken !== 'string' ||
    raw.SyncToken.trim() === '' ||
    typeof raw.TxnDate !== 'string' ||
    raw.TxnDate.trim() === '' ||
    raw.TotalAmt === undefined
  ) {
    return preparationError(
      'QBO_PURCHASE_UNSUPPORTED',
      'Purchase is missing a complete identity, date, total, SyncToken, or Line array.',
    );
  }
  const sign = purchaseSign(raw);
  const accountQboId = requiredIdentity(raw.AccountRef?.value, 'payment account reference');
  const provableLineTaxCents = raw.Line.map((line): number | null => {
    const detail = line.AccountBasedExpenseLineDetail;
    if (detail?.TaxAmount !== undefined) return exactCents(detail.TaxAmount);
    return detail?.TaxCodeRef?.value === undefined ? 0 : null;
  });
  const derivedTotalTaxCents =
    raw.GlobalTaxCalculation === undefined ||
    provableLineTaxCents.some((tax) => tax === null)
      ? null
      : safeCentSum(provableLineTaxCents as number[]);
  return {
    qboId: raw.Id,
    syncToken: raw.SyncToken,
    totalCents: sign * exactCents(raw.TotalAmt),
    accountQboId,
    date: raw.TxnDate,
    direction: sign === 1 ? 'refund' : 'purchase',
    globalTaxCalculation: raw.GlobalTaxCalculation ?? null,
    totalTaxCents:
      raw.TxnTaxDetail?.TotalTax === undefined
        ? derivedTotalTaxCents === null
          ? null
          : sign * derivedTotalTaxCents
        : sign * exactCents(raw.TxnTaxDetail.TotalTax),
    lines: raw.Line.map((line) => snapshotLine(line, sign)),
  };
}

function canonicalSnapshotLine(line: QboPurchaseSnapshot['lines'][number]): string {
  return JSON.stringify([
    line.id,
    line.amountCents,
    line.description,
    line.accountQboId,
    line.customerQboId,
    line.classQboId,
    line.taxCodeQboId,
    line.taxAmountCents,
    line.taxInclusiveCents,
  ]);
}

function zeroOrUnspecifiedTax(value: number | null): boolean {
  return value === 0 || value === null;
}

export function purchaseTotalTaxMatches(
  globalTaxCalculation: string | null,
  expected: number | null,
  actual: number | null,
): boolean {
  return expected === actual
    || (
      globalTaxCalculation === 'NotApplicable'
      && zeroOrUnspecifiedTax(expected)
      && zeroOrUnspecifiedTax(actual)
    );
}

export function purchaseTargetLineMatches(
  globalTaxCalculation: string | null,
  expectedTotalTaxCents: number | null,
  actualTotalTaxCents: number | null,
  expected: QboPurchaseSnapshot['lines'][number],
  actual: QboPurchaseSnapshot['lines'][number],
): boolean {
  const providerDefaultNonTaxCode =
    globalTaxCalculation === 'NotApplicable'
    && zeroOrUnspecifiedTax(expectedTotalTaxCents)
    && zeroOrUnspecifiedTax(actualTotalTaxCents)
    && expected.taxCodeQboId === null
    && typeof actual.taxCodeQboId === 'string'
    && actual.taxCodeQboId.trim() !== ''
    && expected.taxAmountCents === null
    && actual.taxAmountCents === null
    && expected.taxInclusiveCents === null
    && actual.taxInclusiveCents === null;
  return expected.amountCents === actual.amountCents
    && expected.description === actual.description
    && expected.accountQboId === actual.accountQboId
    && expected.customerQboId === actual.customerQboId
    && expected.classQboId === actual.classQboId
    && (
      expected.taxCodeQboId === actual.taxCodeQboId
      || providerDefaultNonTaxCode
    )
    && expected.taxAmountCents === actual.taxAmountCents
    && expected.taxInclusiveCents === actual.taxInclusiveCents;
}

function assertSnapshotEqualsBefore(actual: QboPurchaseSnapshot, before: QboPurchaseSnapshot): void {
  if (actual.syncToken !== before.syncToken) throw new QboSyncTokenConflict();
  const comparableActual = { ...actual, syncToken: undefined };
  const comparableBefore = { ...before, syncToken: undefined };
  if (canonicalJson(comparableActual) !== canonicalJson(comparableBefore)) {
    preparationError('QBO_STATE_DRIFT', 'Purchase changed after its before snapshot was stored.');
  }
}

function expectedBase(
  snapshot: QboPurchaseSnapshot,
  globalTaxCalculation: string | null,
  totalTaxCents: number | null,
): Omit<QboPurchaseExpectedState, 'targetLines' | 'untouchedLineHashes'> {
  return {
    qboId: snapshot.qboId,
    totalCents: snapshot.totalCents,
    accountQboId: snapshot.accountQboId,
    date: snapshot.date,
    direction: snapshot.direction,
    globalTaxCalculation,
    totalTaxCents,
  };
}

function stagedLineToRaw(
  line: StagedCategorization['lines'][number],
  taxCalculation: StagedCategorization['taxCalculation'],
): RawPurchaseLine {
  const accountQboId = requiredIdentity(line.categoryQboId, 'category account reference');
  if (line.idx < 0 || !Number.isSafeInteger(line.idx)) {
    preparationError('QBO_PURCHASE_UNSUPPORTED', 'Purchase split indexes must be non-negative integers.');
  }
  const detail: NonNullable<RawPurchaseLine['AccountBasedExpenseLineDetail']> = {
    AccountRef: { value: accountQboId },
  };
  if (taxCalculation !== 'NotApplicable') {
    detail.TaxCodeRef = {
      value: requiredIdentity(line.taxCodeQboId, 'tax code reference'),
    };
    detail.TaxAmount = moneyFromCents(line.taxCents);
    if (taxCalculation === 'TaxInclusive') {
      detail.TaxInclusiveAmt = moneyFromCents(line.totalCents);
    }
  } else if (line.taxCodeQboId !== null) {
    preparationError('QBO_PURCHASE_UNSUPPORTED', 'NotApplicable Purchase lines cannot carry a tax code.');
  }
  return {
    Amount: moneyFromCents(line.subtotalCents),
    DetailType: 'AccountBasedExpenseLineDetail',
    ...(line.memo === null ? {} : { Description: line.memo }),
    AccountBasedExpenseLineDetail: detail,
  };
}

function stagedLineToSnapshot(
  line: StagedCategorization['lines'][number],
  taxCalculation: StagedCategorization['taxCalculation'],
): QboPurchaseSnapshot['lines'][number] {
  return {
    id: null,
    amountCents: line.subtotalCents,
    description: line.memo,
    accountQboId: line.categoryQboId,
    customerQboId: null,
    classQboId: null,
    taxCodeQboId: taxCalculation === 'NotApplicable' ? null : line.taxCodeQboId,
    taxAmountCents: taxCalculation === 'NotApplicable' ? null : line.taxCents,
    taxInclusiveCents:
      taxCalculation === 'TaxInclusive' ? line.totalCents : null,
  };
}

function assertStagedAmounts(
  staged: StagedCategorization,
  current: QboPurchaseSnapshot,
  holdingLineIndexes: readonly number[],
): void {
  if (staged.lines.length === 0) {
    preparationError('QBO_PURCHASE_UNSUPPORTED', 'Prepared Purchase requires at least one split line.');
  }
  const orderedIndexes = staged.lines.map((line) => line.idx);
  if (orderedIndexes.some((idx, position) => idx !== position)) {
    preparationError('QBO_PURCHASE_UNSUPPORTED', 'Prepared Purchase split indexes must be contiguous.');
  }
  const expectedSign = current.direction === 'refund' ? 1 : -1;
  for (const line of staged.lines) {
    safeCentSum([line.subtotalCents, line.taxCents, line.totalCents]);
    if (safeCentSum([line.subtotalCents, line.taxCents]) !== line.totalCents) {
      preparationError('QBO_STATE_DRIFT', 'Prepared Purchase split tax cents do not balance.');
    }
    if (
      Math.sign(line.subtotalCents) !== expectedSign ||
      (line.taxCents !== 0 && Math.sign(line.taxCents) !== expectedSign)
    ) {
      preparationError(
        'QBO_PURCHASE_UNSUPPORTED',
        'Prepared Purchase subtotal and tax cents must follow the transaction direction.',
      );
    }
    if (staged.taxCalculation === 'NotApplicable' && line.taxCents !== 0) {
      preparationError('QBO_PURCHASE_UNSUPPORTED', 'NotApplicable Purchase lines must have zero tax cents.');
    }
  }
  const totals = {
    subtotalCents: safeCentSum(staged.lines.map((line) => line.subtotalCents)),
    taxCents: safeCentSum(staged.lines.map((line) => line.taxCents)),
    totalCents: safeCentSum(staged.lines.map((line) => line.totalCents)),
  };
  if (canonicalJson(totals) !== canonicalJson(staged.totals)) {
    preparationError('QBO_STATE_DRIFT', 'Prepared Purchase totals do not match its split lines.');
  }
  const holdingTotal = safeCentSum(holdingLineIndexes.map((index) => current.lines[index]!.amountCents));
  if (holdingTotal !== staged.totals.totalCents) {
    preparationError('QBO_STATE_DRIFT', 'Prepared Purchase total changed from the holding-account amount.');
  }
  if (staged.lines.some((line) => Math.sign(line.totalCents) !== expectedSign)) {
    preparationError('QBO_STATE_DRIFT', 'Prepared Purchase split direction changed.');
  }
}

export function preparePurchaseRecategorization(args: {
  current: RawPurchase;
  holdingAccountQboIds: readonly string[];
  staged: StagedCategorization;
  before: QboPurchaseSnapshot;
  requestId: string;
}): QboPreparedWrite {
  requiredIdentity(args.requestId, 'request id');
  if (args.holdingAccountQboIds.length === 0) {
    preparationError('QBO_REFERENCE_MISSING', 'Purchase holding-account references are missing.');
  }
  const holdingIds = new Set(args.holdingAccountQboIds.map((id) => requiredIdentity(id, 'holding account reference')));
  const current = snapshotFromRaw(args.current);
  assertSnapshotEqualsBefore(current, args.before);

  const holdingLineIndexes: number[] = [];
  const keptRawLines: RawPurchaseLine[] = [];
  const keptSnapshotLines: QboPurchaseSnapshot['lines'] = [];
  for (const [index, rawLine] of args.current.Line!.entries()) {
    const accountQboId = rawLine.AccountBasedExpenseLineDetail?.AccountRef?.value;
    if (accountQboId !== undefined && holdingIds.has(accountQboId)) {
      if (
        rawLine.DetailType !== 'AccountBasedExpenseLineDetail' ||
        rawLine.Amount === undefined ||
        accountQboId.trim() === ''
      ) {
        preparationError('QBO_PURCHASE_UNSUPPORTED', 'Holding Purchase line has an unsupported shape.');
      }
      exactCents(rawLine.Amount);
      holdingLineIndexes.push(index);
    } else {
      keptRawLines.push(rawLine);
      keptSnapshotLines.push(current.lines[index]!);
    }
  }
  if (holdingLineIndexes.length === 0) {
    preparationError('QBO_STATE_DRIFT', 'Purchase no longer has an eligible holding-account line.');
  }
  assertStagedAmounts(args.staged, current, holdingLineIndexes);

  const keptTaxBearing = keptSnapshotLines.some(
    (line) =>
      line.taxCodeQboId !== null ||
      line.taxAmountCents !== null ||
      line.taxInclusiveCents !== null,
  );
  if (
    keptTaxBearing &&
    args.staged.taxCalculation !== current.globalTaxCalculation
  ) {
    preparationError(
      'QBO_PURCHASE_UNSUPPORTED',
      'Purchase tax mode cannot change while untouched tax-bearing lines remain.',
    );
  }
  const newRawLines = args.staged.lines.map((line) => stagedLineToRaw(line, args.staged.taxCalculation));
  const newSnapshotLines = args.staged.lines.map((line) =>
    stagedLineToSnapshot(line, args.staged.taxCalculation));
  const provenTaxCents = (
    line: QboPurchaseSnapshot['lines'][number],
  ): number | null =>
    line.taxAmountCents ?? (line.taxCodeQboId === null ? 0 : null);
  const replacedTax = holdingLineIndexes.map((index) => provenTaxCents(current.lines[index]!));
  const keptTax = keptSnapshotLines.map(provenTaxCents);
  if (
    current.totalTaxCents !== null &&
    replacedTax.every((tax) => tax !== null) &&
    keptTax.every((tax) => tax !== null) &&
    current.totalTaxCents !==
      safeCentSum([...(replacedTax as number[]), ...(keptTax as number[])])
  ) {
    preparationError(
      'QBO_PURCHASE_UNSUPPORTED',
      'Purchase aggregate tax does not match its provable line taxes.',
    );
  }
  let keptTaxCents: number;
  if (current.totalTaxCents !== null && replacedTax.every((tax) => tax !== null)) {
    keptTaxCents = safeCentSum([
      current.totalTaxCents,
      -safeCentSum(replacedTax as number[]),
    ]);
  } else if (keptTax.every((tax) => tax !== null)) {
    keptTaxCents = safeCentSum(keptTax as number[]);
  } else {
    preparationError(
      'QBO_PURCHASE_UNSUPPORTED',
      'Purchase tax for untouched lines cannot be proven exactly.',
    );
  }
  const totalTaxCents = safeCentSum([keptTaxCents, args.staged.totals.taxCents]);
  const {
    TxnTaxDetail: _staleTaxDetail,
    status: _cdcStatus,
    ...writeable
  } = args.current;
  const body: RawPurchase = normalizedClone({
    ...writeable,
    SyncToken: current.syncToken,
    Line: [...keptRawLines, ...newRawLines],
    GlobalTaxCalculation: args.staged.taxCalculation,
  });
  const prepared: QboPreparedWrite = {
    operation: 'recategorize',
    qboType: 'Purchase',
    qboId: current.qboId,
    requestId: args.requestId,
    requestHash: requestHash(body),
    body,
    before: normalizedClone(args.before),
    expected: {
      ...expectedBase(current, args.staged.taxCalculation, totalTaxCents),
      targetLines: newSnapshotLines,
      untouchedLineHashes: keptSnapshotLines.map(canonicalSnapshotLine),
    },
  };
  return deepFreeze(prepared);
}

function assertExpectedCurrent(
  expected: QboPurchaseExpectedState,
  actual: QboPurchaseSnapshot,
): number[] {
  if (
    actual.qboId !== expected.qboId ||
    actual.totalCents !== expected.totalCents ||
    actual.accountQboId !== expected.accountQboId ||
    actual.date !== expected.date ||
    actual.direction !== expected.direction ||
    actual.globalTaxCalculation !== expected.globalTaxCalculation ||
    !purchaseTotalTaxMatches(
      expected.globalTaxCalculation,
      expected.totalTaxCents,
      actual.totalTaxCents,
    )
  ) {
    return preparationError('QBO_STATE_DRIFT', 'Purchase fields drifted before restore preparation.');
  }
  const remaining = actual.lines.map((line, index) => ({ line, index }));
  for (const untouchedHash of expected.untouchedLineHashes) {
    const index = remaining.findIndex(
      ({ line }) => canonicalSnapshotLine(line) === untouchedHash,
    );
    if (index === -1) {
      return preparationError('QBO_STATE_DRIFT', 'Untouched Purchase lines drifted before restore.');
    }
    remaining.splice(index, 1);
  }
  const targetIndexes: number[] = [];
  for (const target of expected.targetLines) {
    const index = remaining.findIndex(({ line }) =>
      purchaseTargetLineMatches(
        expected.globalTaxCalculation,
        expected.totalTaxCents,
        actual.totalTaxCents,
        target,
        line,
      ));
    if (index === -1) {
      return preparationError('QBO_STATE_DRIFT', 'Prepared Purchase target line drifted before restore.');
    }
    targetIndexes.push(remaining[index]!.index);
    remaining.splice(index, 1);
  }
  if (remaining.length !== 0) {
    return preparationError('QBO_STATE_DRIFT', 'Unexpected Purchase lines appeared before restore.');
  }
  return targetIndexes;
}

function beforeTargetLines(prepared: QboPreparedWrite): QboPurchaseSnapshot['lines'] {
  const remaining = [...prepared.before.lines];
  for (const untouchedHash of prepared.expected.untouchedLineHashes) {
    const index = remaining.findIndex((line) => canonicalSnapshotLine(line) === untouchedHash);
    if (index === -1) {
      return preparationError('QBO_PURCHASE_UNSUPPORTED', 'Stored before snapshot cannot identify restore target lines.');
    }
    remaining.splice(index, 1);
  }
  if (remaining.length === 0) {
    preparationError('QBO_PURCHASE_UNSUPPORTED', 'Stored before snapshot has no restore target lines.');
  }
  return remaining;
}

function snapshotLineToRaw(line: QboPurchaseSnapshot['lines'][number]): RawPurchaseLine {
  const accountQboId = requiredIdentity(line.accountQboId, 'restore account reference');
  const detail: NonNullable<RawPurchaseLine['AccountBasedExpenseLineDetail']> = {
    AccountRef: { value: accountQboId },
    ...(line.customerQboId === null ? {} : { CustomerRef: { value: line.customerQboId } }),
    ...(line.classQboId === null ? {} : { ClassRef: { value: line.classQboId } }),
    ...(line.taxCodeQboId === null ? {} : { TaxCodeRef: { value: line.taxCodeQboId } }),
    ...(line.taxAmountCents === null ? {} : { TaxAmount: moneyFromCents(line.taxAmountCents) }),
    ...(line.taxInclusiveCents === null
      ? {}
      : { TaxInclusiveAmt: moneyFromCents(line.taxInclusiveCents) }),
  };
  return {
    ...(line.id === null ? {} : { Id: line.id }),
    Amount: moneyFromCents(line.amountCents),
    DetailType: 'AccountBasedExpenseLineDetail',
    ...(line.description === null ? {} : { Description: line.description }),
    AccountBasedExpenseLineDetail: detail,
  };
}

function restoreLinesInBeforeOrder(
  before: QboPurchaseSnapshot,
  keptRaw: readonly RawPurchaseLine[],
  keptSnapshot: readonly QboPurchaseSnapshot['lines'][number][],
): RawPurchaseLine[] {
  const untouched = keptSnapshot.map((snapshot, index) => ({
    hash: canonicalSnapshotLine(snapshot),
    raw: keptRaw[index]!,
  }));
  return before.lines.map((line) => {
    const hash = canonicalSnapshotLine(line);
    const untouchedIndex = untouched.findIndex((candidate) => candidate.hash === hash);
    if (untouchedIndex === -1) return snapshotLineToRaw(line);
    const [match] = untouched.splice(untouchedIndex, 1);
    return match!.raw;
  });
}

export function preparePurchaseRestore(args: {
  current: RawPurchase;
  prepared: QboPreparedWrite;
  requestId: string;
}): QboPreparedWrite {
  requiredIdentity(args.requestId, 'request id');
  if (args.prepared.operation !== 'recategorize' || args.prepared.qboType !== 'Purchase') {
    preparationError('QBO_PURCHASE_UNSUPPORTED', 'Only a prepared Purchase recategorization can be restored.');
  }
  const current = snapshotFromRaw(args.current);
  const targetIndexes = new Set(assertExpectedCurrent(args.prepared.expected, current));
  const targetsBefore = beforeTargetLines(args.prepared);
  const keptRaw = args.current.Line!.filter((_line, index) => !targetIndexes.has(index));
  const keptSnapshot = current.lines.filter((_line, index) => !targetIndexes.has(index));
  const restoredLines = restoreLinesInBeforeOrder(args.prepared.before, keptRaw, keptSnapshot);
  const {
    TxnTaxDetail: _staleTaxDetail,
    status: _cdcStatus,
    ...writeable
  } = args.current;
  const body: RawPurchase = normalizedClone({
    ...writeable,
    SyncToken: current.syncToken,
    Line: restoredLines,
    GlobalTaxCalculation: args.prepared.before.globalTaxCalculation ?? undefined,
  });
  const prepared: QboPreparedWrite = {
    operation: 'restore',
    qboType: 'Purchase',
    qboId: current.qboId,
    requestId: args.requestId,
    requestHash: requestHash(body),
    body,
    before: normalizedClone(args.prepared.before),
    expected: {
      ...expectedBase(
        args.prepared.before,
        args.prepared.before.globalTaxCalculation,
        args.prepared.before.totalTaxCents,
      ),
      targetLines: normalizedClone(targetsBefore),
      untouchedLineHashes: keptSnapshot.map(canonicalSnapshotLine),
    },
  };
  return deepFreeze(prepared);
}
