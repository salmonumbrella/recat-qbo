import { describe, expect, it } from 'vitest';
import { toRuleDto } from './rules.js';

describe('rule tax identity DTO', () => {
  it('preserves nullable historical tax identity for client validation', () => {
    expect(toRuleDto({
      id: 'RULE_GENERIC',
      companyId: 'COMPANY_GENERIC',
      priority: 0,
      matchField: 'payee',
      matchText: 'Generic supplier',
      category: 'Generic expense',
      categoryQboId: 'EXPENSE_ACCOUNT',
      taxCalculation: 'TaxInclusive',
      taxCode: 'Historical purchase tax',
      taxCodeQboId: 'TAX_CODE_HISTORICAL',
      autoPost: false,
      createdById: null,
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
      ruleTags: [],
    } as never)).toMatchObject({
      taxCalculation: 'TaxInclusive',
      taxCode: 'Historical purchase tax',
      taxCodeQboId: 'TAX_CODE_HISTORICAL',
    });
  });
});
