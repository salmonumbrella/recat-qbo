import { describe, expect, it } from 'vitest';
import { receiptRetryDelayMs } from './jobs.js';

describe('receipt job retry policy', () => {
  it('uses two bounded retry delays', () => {
    expect(receiptRetryDelayMs(1)).toBe(30_000);
    expect(receiptRetryDelayMs(2)).toBe(120_000);
  });

  it('rejects attempts outside the retry policy', () => {
    expect(() => receiptRetryDelayMs(0)).toThrow();
    expect(() => receiptRetryDelayMs(3)).toThrow();
  });
});
