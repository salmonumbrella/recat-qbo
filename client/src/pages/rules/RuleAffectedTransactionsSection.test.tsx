import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleAffectedTransactionDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  affectedTransactions: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  rules: { affectedTransactions: mocks.affectedTransactions },
}));

import RuleAffectedTransactionsSection from './RuleAffectedTransactionsSection';

function affected(
  overrides: Partial<RuleAffectedTransactionDto> = {},
): RuleAffectedTransactionDto {
  return {
    transactionId: 'transaction-1',
    qboType: 'Purchase',
    qboId: 'purchase-1',
    date: '2026-08-30',
    payee: 'Northwind Fuel',
    memo: 'Fleet card',
    amountCents: -1250,
    status: 'POSTED',
    ruleWins: false,
    winningRuleId: 'other-rule',
    ...overrides,
  };
}

function page(items: RuleAffectedTransactionDto[], nextCursor: string | null = null) {
  return { matchedCount: 3, pendingCount: 1, postedCount: 2, items, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.affectedTransactions.mockReset();
  mocks.affectedTransactions.mockResolvedValue(page([]));
});

describe('RuleAffectedTransactionsSection', () => {
  it('stays closed until requested, then renders bounded counts and losing-rule context without actions', async () => {
    mocks.affectedTransactions.mockResolvedValue(page([affected()], 'next-page'));
    const user = userEvent.setup();
    render(<RuleAffectedTransactionsSection companyId="company-a" ruleId="rule-a" />);

    expect(mocks.affectedTransactions).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'View affected transactions' }));

    expect(await screen.findByText(/3 matched.*1 pending.*2 posted/i)).toBeInTheDocument();
    expect(screen.getByText(/Another enabled rule currently wins/i)).toBeInTheDocument();
    expect(screen.getByText('−$12.50')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /prepare|commit|activate|edit/i })).not.toBeInTheDocument();
    expect(mocks.affectedTransactions).toHaveBeenCalledWith('company-a', 'rule-a', {
      status: 'all', limit: 20,
    });
  });

  it('does not claim another enabled rule wins when no enabled rule wins the transaction', async () => {
    mocks.affectedTransactions.mockResolvedValue(page([affected({ winningRuleId: null })]));
    const user = userEvent.setup();
    render(<RuleAffectedTransactionsSection companyId="company-a" ruleId="rule-a" />);

    await user.click(screen.getByRole('button', { name: 'View affected transactions' }));

    expect(await screen.findByText(/Northwind Fuel/)).toBeInTheDocument();
    expect(screen.queryByText(/Another enabled rule currently wins/i)).not.toBeInTheDocument();
  });

  it('changes the filter and appends a deduplicated next page', async () => {
    mocks.affectedTransactions
      .mockResolvedValueOnce(page([affected()], 'cursor-2'))
      .mockResolvedValueOnce(page([affected({ transactionId: 'transaction-2', status: 'PENDING' })], 'cursor-3'))
      .mockResolvedValueOnce(page([
        affected({ transactionId: 'transaction-2', status: 'PENDING' }),
        affected({ transactionId: 'transaction-3', status: 'PENDING' }),
      ]));
    const user = userEvent.setup();
    render(<RuleAffectedTransactionsSection companyId="company-a" ruleId="rule-a" />);

    await user.click(screen.getByRole('button', { name: 'View affected transactions' }));
    await screen.findByText(/Northwind Fuel/);
    await user.click(screen.getByRole('button', { name: 'Pending' }));
    await user.click(await screen.findByRole('button', { name: 'Load more affected transactions' }));

    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(mocks.affectedTransactions).toHaveBeenLastCalledWith('company-a', 'rule-a', {
      status: 'pending', limit: 20, cursor: 'cursor-3',
    });
  });

  it('retries an independent affected-transaction load failure', async () => {
    mocks.affectedTransactions
      .mockRejectedValueOnce(new Error('Affected transactions are unavailable.'))
      .mockResolvedValueOnce(page([]));
    const user = userEvent.setup();
    render(<RuleAffectedTransactionsSection companyId="company-a" ruleId="rule-a" />);

    await user.click(screen.getByRole('button', { name: 'View affected transactions' }));
    await user.click(await screen.findByRole('button', { name: 'Retry affected transactions' }));

    expect(await screen.findByText('No affected transactions match this filter.')).toBeInTheDocument();
  });

  it('discards a late response after changing its filter', async () => {
    const first = deferred<ReturnType<typeof page>>();
    mocks.affectedTransactions
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(page([affected({ transactionId: 'pending-transaction', status: 'PENDING', payee: 'Pending Vendor' })]));
    const user = userEvent.setup();
    render(<RuleAffectedTransactionsSection companyId="company-a" ruleId="rule-a" />);

    await user.click(screen.getByRole('button', { name: 'View affected transactions' }));
    await waitFor(() => expect(mocks.affectedTransactions).toHaveBeenCalledWith('company-a', 'rule-a', {
      status: 'all', limit: 20,
    }));
    await user.click(screen.getByRole('button', { name: 'Pending' }));
    expect(await screen.findByText(/Pending Vendor/)).toBeInTheDocument();
    await act(async () => first.resolve(page([affected({ payee: 'All Vendor' })])));

    expect(screen.queryByText(/All Vendor/)).not.toBeInTheDocument();
    expect(screen.getByText(/Pending Vendor/)).toBeInTheDocument();
  });
});
