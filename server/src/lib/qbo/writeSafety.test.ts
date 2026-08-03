import { describe, expect, it } from 'vitest';
import { assertQboWriteAllowed, type QboWriteSafetyTarget } from './writeSafety.js';

const purchase: QboWriteSafetyTarget = {
  qboType: 'Purchase',
  qboId: 'purchase-1',
  txnDate: '2026-08-01',
  bankAccountQboId: 'bank-1',
};

describe('QuickBooks write safety', () => {
  it('allows an open, uncleared transaction', () => {
    expect(() => assertQboWriteAllowed(purchase, {
      bookCloseDate: null,
      cleared: false,
      reconciled: false,
    })).not.toThrow();
  });

  it.each([
    ['2026-08-01', 'on'],
    ['2026-08-02', 'before'],
  ])('blocks a transaction %s the closing date', (bookCloseDate) => {
    expect(() => assertQboWriteAllowed(purchase, {
      bookCloseDate,
      cleared: false,
      reconciled: false,
    })).toThrow(expect.objectContaining({ code: 'QBO_PERIOD_CLOSED' }));
  });

  it('allows the first day after the closing date', () => {
    expect(() => assertQboWriteAllowed(purchase, {
      bookCloseDate: '2026-07-31',
      cleared: false,
      reconciled: false,
    })).not.toThrow();
  });

  it.each([
    [{ cleared: true, reconciled: false }, 'cleared'],
    [{ cleared: false, reconciled: true }, 'reconciled'],
  ])('blocks a %s bank line', (status) => {
    expect(() => assertQboWriteAllowed({ ...purchase, qboType: 'Deposit' }, {
      bookCloseDate: null,
      ...status,
    })).toThrow(expect.objectContaining({ code: 'QBO_TRANSACTION_LOCKED' }));
  });

  it.each([
    [{ ...purchase, txnDate: '08/01/2026' }, { bookCloseDate: null, cleared: false, reconciled: false }],
    [purchase, { bookCloseDate: 'not-a-date', cleared: false, reconciled: false }],
    [{ ...purchase, bankAccountQboId: '' }, { bookCloseDate: null, cleared: false, reconciled: false }],
  ])('fails closed on malformed safety input', (target, evidence) => {
    expect(() => assertQboWriteAllowed(target, evidence))
      .toThrow(expect.objectContaining({ code: 'QBO_WRITE_SAFETY_UNAVAILABLE' }));
  });
});
