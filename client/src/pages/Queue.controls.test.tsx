import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  classificationSearch: vi.fn(),
  classificationHealth: vi.fn(),
  categorize: vi.fn(),
  toast: vi.fn(),
  setPendingCount: vi.fn(),
  refreshCompanies: vi.fn(),
  navigate: vi.fn(),
  tags: [] as Array<{ id: string; companyId: string; name: string; color: string }>,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompany: {
      id: 'COMPANY_GENERIC', nickname: 'Generic company', holdingAccountIds: [], lastSyncedAt: null,
    },
    activeCompanyId: 'COMPANY_GENERIC',
    role: 'admin',
    accounts: [
      { id: 'ACCOUNT_GENERIC', qboId: 'EXPENSE_GENERIC', name: 'Generic expense', fullName: 'Expenses · Generic expense', classification: 'Expenses', active: true },
      { id: 'ACCOUNT_OFFICE', qboId: 'EXPENSE_OFFICE', name: 'Office expense', fullName: 'Expenses · Office expense', classification: 'Expenses', active: true },
      { id: 'ACCOUNT_HOLDING', qboId: 'HOLDING', name: 'Uncategorised Expense', fullName: 'Expenses · Uncategorised Expense', classification: 'Expenses', active: true },
    ],
    tags: mocks.tags, setPendingCount: mocks.setPendingCount, refreshCompanies: mocks.refreshCompanies,
    dryRun: false, tagsRequired: false, taxReadiness: null, toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  createCategorizationRequestId: vi.fn(),
  companies: { sync: vi.fn() },
  classificationMemory: { search: mocks.classificationSearch, health: mocks.classificationHealth, currentCase: vi.fn() },
  ruleOperations: { prepareFromCase: vi.fn(), commit: vi.fn() },
  rules: { create: vi.fn(), lifecycle: vi.fn() },
  autopilot: { get: vi.fn(), listRuns: vi.fn(), getReadiness: vi.fn() },
  transactions: {
    list: mocks.list, categorize: mocks.categorize, stageCategorization: vi.fn(), commitCategorization: vi.fn(),
    reconcileCategorization: vi.fn(), retryCategorization: vi.fn(), undoCategorization: vi.fn(),
    post: vi.fn(), undo: vi.fn(), retry: vi.fn(), transfer: vi.fn(), bulkPost: vi.fn(),
  },
}));

import Queue from './Queue';

function transaction(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'TRANSACTION_GENERIC', companyId: 'COMPANY_GENERIC', qboId: 'PURCHASE_GENERIC', qboType: 'Purchase',
    date: '2026-07-28T00:00:00.000Z', payee: 'Generic supplier', memo: null, amount: -10.5,
    bankAccount: 'Operating account', status: 'PENDING', revision: 1, category: 'Generic expense',
    categoryQboId: 'EXPENSE_GENERIC', taxCalculation: null, taxCode: null, taxCodeQboId: null,
    splits: null, tagIds: [], suggestion: null, error: null, postedAt: null, postedBy: null,
    activeCategorizationAttempt: null, providerActionability: { disposition: 'WRITABLE' }, ...overrides,
  } as TransactionDto;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  mocks.list.mockResolvedValue({
    transactions: [transaction(), transaction({ id: 'TRANSACTION_OTHER', payee: 'Another supplier', bankAccount: 'Savings account' })],
    nextCursor: null,
    pendingCount: 2,
  });
  mocks.categorize.mockResolvedValue(transaction({ category: 'Office expense', categoryQboId: 'EXPENSE_OFFICE' }));
  mocks.tags = [];
  mocks.classificationSearch.mockResolvedValue({
    query: 'Generic supplier', companyId: 'COMPANY_GENERIC', scope: 'current_company', mode: 'hybrid', requestedMode: 'auto',
    degraded: false, degradedReason: null, status: 'no_match', noMatch: true, total: 0, items: [], nextCursor: null,
  });
  mocks.classificationHealth.mockResolvedValue({ configured: false, vectorAvailable: false, backlog: 0, progress: 0 });
});

async function renderQueue() {
  render(<Queue />);
  await screen.findByText('Generic supplier');
}

describe('Queue shared controls', () => {
  it('uses shared controls for account filtering and category selection without the legacy global picker handler', async () => {
    const user = userEvent.setup();
    await renderQueue();

    await user.click(screen.getByRole('combobox', { name: 'Account filter' }));
    await user.keyboard('oper{Enter}');
    expect(screen.getByText('Generic supplier')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Category for Generic supplier' }));
    await user.type(screen.getByRole('textbox', { name: 'Category for Generic supplier' }), 'office');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByRole('combobox', { name: 'Category for Generic supplier' })).toHaveTextContent(/Office expense/);
  });

  it('contains no native select in the complete Queue render tree', async () => {
    await renderQueue();

    expect(document.querySelectorAll('select')).toHaveLength(0);
  });

  it('keeps an unselected rule suggestion visible and described on the category trigger', async () => {
    mocks.list.mockResolvedValue({
      transactions: [transaction({
        category: null,
        categoryQboId: null,
        suggestion: {
          category: 'Office expense',
          categoryQboId: 'EXPENSE_OFFICE',
          source: 'rule',
          matchedRules: 2,
          winnerMatchText: 'office supply',
        },
      })],
      nextCursor: null,
      pendingCount: 1,
    });
    await renderQueue();

    const category = screen.getByRole('combobox', { name: 'Category for Generic supplier' });
    expect(category).toHaveTextContent('Office expense');
    expect(category).toHaveAccessibleDescription(
      'Suggested category: Office expense. Suggested by rule. Matched 2 rules — “office supply” won (topmost). Reorder in Rules.',
    );
    expect(screen.getByText('rule')).toHaveAttribute(
      'data-tip',
      'Matched 2 rules — “office supply” won (topmost). Reorder in Rules.',
    );
  });

  it('does not let shared-control type-ahead activate Queue shortcuts', async () => {
    const user = userEvent.setup();
    mocks.tags = [{ id: 'TAG_GENERIC', companyId: 'COMPANY_GENERIC', name: 'Generic tag', color: '#667788' }];
    await renderQueue();

    await user.click(screen.getByRole('combobox', { name: 'Account filter' }));
    await user.keyboard('txjk');

    expect(screen.queryByRole('button', { name: 'Generic tag' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
  });

  it('keeps tag interactions open but dismisses the tag picker on an outside click', async () => {
    const user = userEvent.setup();
    mocks.tags = [{ id: 'TAG_GENERIC', companyId: 'COMPANY_GENERIC', name: 'Generic tag', color: '#667788' }];
    mocks.categorize.mockResolvedValue(transaction({ tagIds: ['TAG_GENERIC'] }));
    await renderQueue();

    await user.click(screen.getAllByRole('button', { name: '+ tag' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Generic tag' }));
    expect(screen.getByRole('button', { name: 'Generic tag' })).toBeInTheDocument();

    await user.click(document.body);
    expect(screen.queryByRole('button', { name: 'Generic tag' })).not.toBeInTheDocument();
  });
});
