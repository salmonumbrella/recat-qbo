import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'COMPANY_GENERIC',
    accounts: [{
      qboId: 'EXPENSE_ACCOUNT',
      name: 'Generic expense',
      classification: 'Expenses',
    }],
    tags: [],
    taxReadiness: {
      status: 'ready',
      reason: null,
      usingSalesTax: true,
      refreshedAt: '2026-07-28T00:00:00.000Z',
      taxCodes: [{
        qboId: 'TAX_CODE_STANDARD',
        name: 'Standard purchase tax',
        active: true,
        taxable: true,
        combinedPurchaseRate: 5,
        combinedSalesRate: null,
      }],
      salesStatus: 'needs_setup',
      salesReason: null,
      salesTaxCodes: [],
    },
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  rules: {
    list: mocks.list,
    create: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    reorder: vi.fn(),
    test: vi.fn(),
  },
}));

import Rules from './Rules';

describe('Rules historical tax validation', () => {
  it('shows an invalid stored tax reference instead of silently applying it', async () => {
    mocks.list.mockResolvedValue([{
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
      tagIds: [],
      autoPost: false,
      createdAt: '2026-07-28T00:00:00.000Z',
    }]);

    render(<Rules />);

    expect(
      await screen.findByText(/tax reference unavailable.*historical purchase tax/i),
    ).toBeInTheDocument();
  });
});
