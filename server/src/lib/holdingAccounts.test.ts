import { describe, expect, it } from 'vitest';
import {
  isDefaultHoldingAccountName,
  isHoldingAccountName,
  isQboHoldingAccountName,
} from '@recat/shared';

describe('holding-account name matching', () => {
  it.each([
    'Uncategorized Expense',
    'Uncategorised Expense',
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
    ['Ask My Accountant', true],
    ['Uncategorised Income', false],
    ['Uncategorised Asset', false],
    ['Office Supplies', false],
  ])('applies Setup defaults to %s', (name, expected) => {
    expect(isDefaultHoldingAccountName(name)).toBe(expected);
  });
});

// Queue and Rules use this to REMOVE accounts from the category picker, so a
// loose match costs the user a destination they created on purpose and gives
// them nothing to explain its absence. QuickBooks names its own holding
// accounts exactly, so anchoring loses nothing real.
describe('isQboHoldingAccountName — the anchored form used to hide accounts', () => {
  it.each([
    'Uncategorized Expense',
    'Uncategorised Expense',
    'Uncategorised Income',
    'Uncategorized Asset',
    '  Uncategorised Expense  ',
    'uNcAtEgOrIsEd ExPeNsE',
    'Ask My Accountant',
    'ask my accountant',
  ])('hides the QuickBooks holding account %s', (name) => {
    expect(isQboHoldingAccountName(name)).toBe(true);
  });

  it.each([
    'Old Uncategorized Costs',
    'Reclassified Uncategorized 2023',
    'Legal - ask my accountant first',
    'Ask My Accountant Later',
    'Office Supplies',
    // A localized company's own categories, which a prefix test would swallow.
    'Uncategorised Travel',
    'Uncategorised Software',
    'Uncategorized Expenses Pending Review',
  ])('leaves the user account %s categorizable', (name) => {
    expect(isQboHoldingAccountName(name)).toBe(false);
  });

  it('is stricter than the candidate matcher, which may stay broad', () => {
    // The server offers candidates to choose from, so a near miss is harmless
    // there. Hiding a destination is not.
    expect(isHoldingAccountName('Old Uncategorized Costs')).toBe(true);
    expect(isQboHoldingAccountName('Old Uncategorized Costs')).toBe(false);
  });
});
