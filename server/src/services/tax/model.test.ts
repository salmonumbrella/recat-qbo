import { describe, expect, it } from 'vitest';
import { moneyToCents, validateRecategorizationPlan } from './model.js';

describe('purchase tax model', () => {
  it('converts signed decimal money to exact cents', () => {
    expect(moneyToCents(-10.005)).toBe(-1001);
  });

  it('rounds positive midpoint values away from zero', () => {
    expect(moneyToCents(10.075)).toBe(1008);
  });

  it('rounds negative midpoint values away from zero', () => {
    expect(moneyToCents(-10.075)).toBe(-1008);
  });

  it('rejects finite amounts whose cents exceed the safe integer range', () => {
    expect(() => moneyToCents(Number.MAX_VALUE)).toThrowError(
      'Amount must convert to safe integer cents.',
    );
  });

  it('rejects a plan whose gross lines do not equal the transaction', () => {
    expect(() =>
      validateRecategorizationPlan({
        qboType: 'Purchase',
        signedTransactionAmountCents: -1000,
        taxCalculation: 'TaxExcluded',
        lines: [{ grossCents: -999, accountQboId: '42', taxCodeQboId: 'GST' }],
      }),
    ).toThrowError(/gross lines/i);
  });

  it('rejects an unsafe signed transaction amount', () => {
    expect(() =>
      validateRecategorizationPlan({
        qboType: 'Purchase',
        signedTransactionAmountCents: Number.MAX_SAFE_INTEGER + 1,
        taxCalculation: 'TaxExcluded',
        lines: [{ grossCents: 0, accountQboId: '42', taxCodeQboId: 'GST' }],
      }),
    ).toThrowError('Signed transaction amount must be a safe integer.');
  });

  it('rejects a gross line total that exceeds the safe integer range', () => {
    expect(() =>
      validateRecategorizationPlan({
        qboType: 'Purchase',
        signedTransactionAmountCents: 0,
        taxCalculation: 'TaxExcluded',
        lines: [
          { grossCents: Number.MAX_SAFE_INTEGER, accountQboId: '42', taxCodeQboId: 'GST' },
          { grossCents: 1, accountQboId: '43', taxCodeQboId: 'GST' },
        ],
      }),
    ).toThrowError(/gross line total/i);
  });
});
