import type { QboPurchaseSnapshot } from '../../lib/qbo/types.js';
import {
  purchaseTargetLineMatches,
  purchaseTotalTaxMatches,
} from '../../lib/qbo/purchaseTax.js';

type PurchaseLine = QboPurchaseSnapshot['lines'][number];

export interface ExpectedPurchaseResult {
  qboId: string;
  totalCents: number;
  accountQboId: string | null;
  date: string;
  direction: QboPurchaseSnapshot['direction'];
  globalTaxCalculation: string | null;
  totalTaxCents: number | null;
  targetLines: PurchaseLine[];
  untouchedLineHashes: string[];
}

export type PurchaseVerification = { ok: true } | { ok: false; code: 'QBO_STATE_DRIFT'; message: string };

export function canonicalPurchaseLineHash(line: PurchaseLine): string {
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

function targetLineHash(line: PurchaseLine): string {
  return JSON.stringify([
    line.amountCents,
    line.description,
    line.accountQboId,
    line.customerQboId,
    line.classQboId,
    line.taxCodeQboId,
    effectiveLineTaxCents(line),
    line.taxInclusiveCents,
  ]);
}

function effectiveLineTaxCents(line: PurchaseLine): number | null {
  if (line.taxAmountCents !== null) return line.taxAmountCents;
  if (line.taxInclusiveCents === null) return null;
  return line.taxInclusiveCents - line.amountCents;
}

function omittedInclusiveTotalTaxMatches(
  expectedTotalTaxCents: number | null,
  actual: QboPurchaseSnapshot,
): boolean {
  if (actual.totalTaxCents === expectedTotalTaxCents) return true;
  if (
    actual.totalTaxCents !== null
    || expectedTotalTaxCents === null
    || actual.globalTaxCalculation !== 'TaxInclusive'
  ) {
    return false;
  }
  let derivedTotalTaxCents = 0;
  for (const line of actual.lines) {
    const lineTaxCents = effectiveLineTaxCents(line);
    if (lineTaxCents === null) {
      if (line.taxCodeQboId !== null) return false;
      continue;
    }
    derivedTotalTaxCents += lineTaxCents;
  }
  return derivedTotalTaxCents === expectedTotalTaxCents;
}
function drift(message: string): PurchaseVerification {
  return { ok: false, code: 'QBO_STATE_DRIFT', message };
}

export function verifyPurchaseResult(
  expected: ExpectedPurchaseResult,
  actual: QboPurchaseSnapshot,
): PurchaseVerification {
  if (actual.qboId !== expected.qboId) return drift('Purchase ID changed.');
  if (actual.totalCents !== expected.totalCents) return drift('Purchase total changed.');
  if (actual.accountQboId !== expected.accountQboId) return drift('Purchase account changed.');
  if (actual.date !== expected.date) return drift('Purchase date changed.');
  if (actual.direction !== expected.direction) return drift('Purchase direction changed.');
  if (actual.globalTaxCalculation !== expected.globalTaxCalculation) return drift('Purchase global tax mode changed.');
  if (
    !purchaseTotalTaxMatches(
      expected.globalTaxCalculation,
      expected.totalTaxCents,
      actual.totalTaxCents,
    )
    && !omittedInclusiveTotalTaxMatches(expected.totalTaxCents, actual)
  ) {
    return drift('Purchase total tax changed.');
  }

  const remainingLines = [...actual.lines];
  for (const targetLine of expected.targetLines) {
    const targetIndex = remainingLines.findIndex((line) =>
      purchaseTargetLineMatches(
        expected.globalTaxCalculation,
        expected.totalTaxCents,
        actual.totalTaxCents,
        targetLine,
        line,
      ) || targetLineHash(line) === targetLineHash(targetLine));
    if (targetIndex === -1) return drift('Expected target Purchase line is missing or changed.');
    remainingLines.splice(targetIndex, 1);
  }

  const actualUntouchedHashes = remainingLines.map(canonicalPurchaseLineHash).sort();
  const expectedUntouchedHashes = [...expected.untouchedLineHashes].sort();
  if (
    actualUntouchedHashes.length !== expectedUntouchedHashes.length ||
    actualUntouchedHashes.some((hash, index) => hash !== expectedUntouchedHashes[index])
  ) {
    return drift('Untouched Purchase lines changed.');
  }

  return { ok: true };
}
