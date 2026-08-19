import { describe, expect, it } from 'vitest';
import {
  isDefaultHoldingAccountName,
  isHoldingAccountName,
} from '@recat/shared';

describe('holding-account name matching', () => {
  it.each([
    'Uncategorized Expense',
    'Uncategorised Expense',
    'Localized expense | Uncategorised Expense',
    'uNcAtEgOrIsEd ExPeNsE',
    'Ask My Accountant',
  ])('recognizes %s', (name) => {
    expect(isHoldingAccountName(name)).toBe(true);
  });

  it('rejects an unrelated account', () => {
    expect(isHoldingAccountName('Office Supplies')).toBe(false);
  });

  it.each([
    ['Uncategorized Expense', true],
    ['Localized expense | Uncategorised Expense', true],
    ['Ask My Accountant', true],
    ['Uncategorised Income', false],
    ['Uncategorised Asset', false],
    ['Office Supplies', false],
  ])('applies Setup defaults to %s', (name, expected) => {
    expect(isDefaultHoldingAccountName(name)).toBe(expected);
  });
});
