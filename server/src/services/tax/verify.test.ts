import { describe, expect, it } from 'vitest';
import { canonicalPurchaseLineHash, verifyPurchaseResult, type ExpectedPurchaseResult } from './verify.js';

const targetLine = {
  id: null,
  amountCents: -10_50,
  description: 'Fuel',
  accountQboId: 'expense',
  customerQboId: 'customer-1',
  classQboId: 'class-1',
  taxCodeQboId: 'GST5',
  taxAmountCents: -50,
  taxInclusiveCents: -10_50,
};

const untouchedLine = {
  id: 'untouched-1',
  amountCents: 10_50,
  description: 'Payment',
  accountQboId: 'bank',
  customerQboId: null,
  classQboId: 'class-2',
  taxCodeQboId: null,
  taxAmountCents: 0,
  taxInclusiveCents: null,
};

const expected: ExpectedPurchaseResult = {
  qboId: 'purchase-1',
  totalCents: -10_50,
  accountQboId: 'bank',
  date: '2026-07-27',
  direction: 'purchase',
  globalTaxCalculation: 'TaxInclusive',
  totalTaxCents: -50,
  targetLines: [targetLine],
  untouchedLineHashes: [canonicalPurchaseLineHash(untouchedLine)],
};

const actual = {
  qboId: 'purchase-1',
  syncToken: '1',
  totalCents: -10_50,
  accountQboId: 'bank',
  date: '2026-07-27',
  direction: 'purchase' as const,
  globalTaxCalculation: 'TaxInclusive',
  totalTaxCents: -50,
  lines: [{ ...targetLine, id: 'new-target' }, untouchedLine],
};

describe('verifyPurchaseResult', () => {
  it('accepts the expected Purchase target and untouched-line state', () => {
    expect(verifyPurchaseResult(expected, actual)).toEqual({ ok: true });
  });

  it('accepts QBO non-taxable null/default normalization without accepting tax drift', () => {
    const nonTaxableTarget = {
      ...targetLine,
      taxCodeQboId: null,
      taxAmountCents: null,
      taxInclusiveCents: null,
    };
    const nonTaxableExpected: ExpectedPurchaseResult = {
      ...expected,
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: 0,
      targetLines: [nonTaxableTarget],
      untouchedLineHashes: [],
    };
    const normalizedByQbo = {
      ...actual,
      globalTaxCalculation: 'NotApplicable',
      totalTaxCents: null,
      lines: [{
        ...nonTaxableTarget,
        id: 'provider-assigned-target',
        taxCodeQboId: 'PROVIDER_DEFAULT_NON_TAX',
      }],
    };

    expect(verifyPurchaseResult(nonTaxableExpected, normalizedByQbo))
      .toEqual({ ok: true });
    expect(verifyPurchaseResult(nonTaxableExpected, {
      ...normalizedByQbo,
      totalTaxCents: -1,
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyPurchaseResult({
      ...nonTaxableExpected,
      totalTaxCents: -1,
    }, {
      ...normalizedByQbo,
      totalTaxCents: -1,
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
    expect(verifyPurchaseResult(nonTaxableExpected, {
      ...normalizedByQbo,
      lines: [{ ...normalizedByQbo.lines[0], taxAmountCents: -1 }],
    })).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('accepts omitted redundant tax fields when the inclusive amount proves the exact tax', () => {
    const expectedTarget = {
      ...targetLine,
      amountCents: -10_00,
      taxAmountCents: -50,
      taxInclusiveCents: -10_50,
    };
    const expectedWithDerivedTax = {
      ...expected,
      targetLines: [expectedTarget],
    };
    const qboReadback = {
      ...actual,
      totalTaxCents: null,
      lines: [{
        ...expectedTarget,
        id: 'new-target',
        taxAmountCents: null,
      }, untouchedLine],
    };

    expect(verifyPurchaseResult(expectedWithDerivedTax, qboReadback)).toEqual({ ok: true });
  });

  it('rejects omitted tax fields when the inclusive amount does not prove the expected tax', () => {
    const expectedTarget = {
      ...targetLine,
      amountCents: -10_00,
      taxAmountCents: -50,
      taxInclusiveCents: -10_50,
    };
    const expectedWithDerivedTax = {
      ...expected,
      targetLines: [expectedTarget],
    };
    const qboReadback = {
      ...actual,
      totalTaxCents: null,
      lines: [{
        ...expectedTarget,
        id: 'new-target',
        taxAmountCents: null,
        taxInclusiveCents: -10_49,
      }, untouchedLine],
    };

    expect(verifyPurchaseResult(expectedWithDerivedTax, qboReadback)).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
  });

  it.each([
    ['Purchase ID', { qboId: 'purchase-2' }],
    ['total', { totalCents: -10_49 }],
    ['account', { accountQboId: 'other-bank' }],
    ['date', { date: '2026-07-28' }],
    ['direction', { direction: 'refund' }],
    ['global tax mode', { globalTaxCalculation: 'TaxExcluded' }],
    ['total tax', { totalTaxCents: -49 }],
  ])('detects %s drift', (_name, changes) => {
    expect(verifyPurchaseResult(expected, { ...actual, ...changes })).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
  });

  it('detects a changed target Purchase line', () => {
    expect(
      verifyPurchaseResult(expected, {
        ...actual,
        lines: [{ ...actual.lines[0], taxInclusiveCents: -10_49 }, actual.lines[1]],
      }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it.each([
    ['customer', { customerQboId: 'customer-2' }],
    ['class', { classQboId: 'class-2' }],
    ['line tax', { taxAmountCents: -49 }],
  ])('detects changed target-line %s detail', (_field, changes) => {
    expect(
      verifyPurchaseResult(expected, {
        ...actual,
        lines: [{ ...actual.lines[0], ...changes }, actual.lines[1]],
      }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('detects a changed untouched Purchase line', () => {
    expect(
      verifyPurchaseResult(expected, {
        ...actual,
        lines: [actual.lines[0], { ...actual.lines[1], description: 'Changed payment' }],
      }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it.each([
    ['customer', { customerQboId: 'customer-2' }],
    ['class', { classQboId: 'class-3' }],
    ['line tax', { taxAmountCents: 1 }],
  ])('detects changed untouched-line %s detail', (_field, changes) => {
    expect(
      verifyPurchaseResult(expected, {
        ...actual,
        lines: [actual.lines[0], { ...actual.lines[1], ...changes }],
      }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('detects missing and extra Purchase lines', () => {
    expect(verifyPurchaseResult(expected, { ...actual, lines: [actual.lines[0]] })).toMatchObject({
      ok: false,
      code: 'QBO_STATE_DRIFT',
    });
    expect(
      verifyPurchaseResult(expected, {
        ...actual,
        lines: [...actual.lines, { ...untouchedLine, id: 'extra' }],
      }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('matches duplicate target lines as a multiset', () => {
    const duplicateTargetExpected = { ...expected, targetLines: [targetLine, targetLine] };
    const duplicateTargetActual = {
      ...actual,
      lines: [{ ...targetLine, id: 'new-target-1' }, { ...targetLine, id: 'new-target-2' }, untouchedLine],
    };

    expect(verifyPurchaseResult(duplicateTargetExpected, duplicateTargetActual)).toEqual({ ok: true });
    expect(
      verifyPurchaseResult(duplicateTargetExpected, { ...duplicateTargetActual, lines: duplicateTargetActual.lines.slice(1) }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('matches duplicate untouched lines as a multiset', () => {
    const duplicateUntouchedExpected = {
      ...expected,
      untouchedLineHashes: [canonicalPurchaseLineHash(untouchedLine), canonicalPurchaseLineHash(untouchedLine)],
    };
    const duplicateUntouchedActual = { ...actual, lines: [actual.lines[0], untouchedLine, untouchedLine] };

    expect(verifyPurchaseResult(duplicateUntouchedExpected, duplicateUntouchedActual)).toEqual({ ok: true });
    expect(
      verifyPurchaseResult(duplicateUntouchedExpected, { ...duplicateUntouchedActual, lines: duplicateUntouchedActual.lines.slice(0, 2) }),
    ).toMatchObject({ ok: false, code: 'QBO_STATE_DRIFT' });
  });

  it('hashes semantically identical lines consistently regardless of property insertion order', () => {
    const reorderedLine = {
      taxInclusiveCents: untouchedLine.taxInclusiveCents,
      taxAmountCents: untouchedLine.taxAmountCents,
      taxCodeQboId: untouchedLine.taxCodeQboId,
      classQboId: untouchedLine.classQboId,
      customerQboId: untouchedLine.customerQboId,
      accountQboId: untouchedLine.accountQboId,
      description: untouchedLine.description,
      amountCents: untouchedLine.amountCents,
      id: untouchedLine.id,
    };

    expect(canonicalPurchaseLineHash(reorderedLine)).toBe(canonicalPurchaseLineHash(untouchedLine));
  });
});
