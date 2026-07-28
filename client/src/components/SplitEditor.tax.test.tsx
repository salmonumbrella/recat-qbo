import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TaxReadinessDto, TransactionDto } from '@recat/shared';
import SplitEditor from './SplitEditor';

const toast = vi.fn();
vi.mock('../state/AppContext', () => ({
  useApp: () => ({ toast }),
}));

const READY: TaxReadinessDto = {
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
  }, {
    qboId: 'TAX_CODE_EXPLICIT_NONE',
    name: 'Explicit non-tax treatment',
    active: true,
    taxable: false,
    combinedPurchaseRate: null,
  }],
};

const TXN: TransactionDto = {
  id: 'TRANSACTION_GENERIC',
  companyId: 'COMPANY_GENERIC',
  qboId: 'PURCHASE_GENERIC',
  qboType: 'Purchase',
  date: '2026-07-28T00:00:00.000Z',
  payee: 'Generic supplier',
  memo: null,
  amount: -10.5,
  bankAccount: 'Generic bank',
  status: 'PENDING',
  revision: 2,
  category: null,
  categoryQboId: null,
  taxCalculation: 'TaxInclusive',
  taxCode: null,
  taxCodeQboId: null,
  splits: [
    {
      amount: -5,
      category: 'Generic expense',
      categoryQboId: 'EXPENSE_ACCOUNT',
      taxCode: 'Standard purchase tax',
      taxCodeQboId: 'TAX_CODE_STANDARD',
      tagIds: [],
      memo: 'First memo',
    },
    {
      amount: -5.5,
      category: 'Generic expense',
      categoryQboId: 'EXPENSE_ACCOUNT',
      taxCode: 'Standard purchase tax',
      taxCodeQboId: 'TAX_CODE_STANDARD',
      tagIds: [],
      memo: 'Second memo',
    },
  ],
  tagIds: [],
  suggestion: null,
  error: null,
  postedAt: null,
  postedBy: null,
  activeCategorizationAttempt: null,
};

describe('SplitEditor tax fields', () => {
  it('saves the calculation, memo, and purchase tax selection on every line', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <SplitEditor
        txn={TXN}
        tags={[]}
        catOpts={[{ group: 'Expenses', name: 'Generic expense' }]}
        taxReadiness={READY}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText('Tax calculation for split'),
      'TaxExcluded',
    );
    const firstMemo = screen.getByLabelText('Memo for split line 1');
    await user.clear(firstMemo);
    await user.type(firstMemo, 'Updated generic memo');
    await user.selectOptions(
      screen.getByLabelText('Purchase tax for split line 2'),
      'TAX_CODE_STANDARD',
    );
    await user.click(screen.getByRole('button', { name: /save split/i }));

    expect(onSave).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          memo: 'Updated generic memo',
          taxCodeQboId: 'TAX_CODE_STANDARD',
        }),
        expect.objectContaining({
          memo: 'Second memo',
          taxCodeQboId: 'TAX_CODE_STANDARD',
        }),
      ],
      'TaxExcluded',
    );
  });

  it('keeps the legacy split editor free of tax controls when readiness is disabled', () => {
    render(
      <SplitEditor
        txn={{ ...TXN, taxCalculation: null, splits: TXN.splits!.map((line) => ({
          ...line,
          taxCode: null,
          taxCodeQboId: null,
        })) }}
        tags={[]}
        catOpts={[{ group: 'Expenses', name: 'Generic expense' }]}
        taxReadiness={{
          status: 'unsupported',
          reason: 'Purchase tax is disabled.',
          usingSalesTax: false,
          refreshedAt: null,
          taxCodes: [],
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Tax calculation for split')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Purchase tax for split line 1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save split/i })).toBeEnabled();
  });

  it('allows taxable and explicit supported non-tax codes in the same split', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <SplitEditor
        txn={TXN}
        tags={[]}
        catOpts={[{ group: 'Expenses', name: 'Generic expense' }]}
        taxReadiness={READY}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText('Purchase tax for split line 2'),
      'TAX_CODE_EXPLICIT_NONE',
    );
    await user.click(screen.getByRole('button', { name: /save split/i }));

    expect(onSave).toHaveBeenCalledWith(
      [
        expect.objectContaining({ taxCodeQboId: 'TAX_CODE_STANDARD' }),
        expect.objectContaining({ taxCodeQboId: 'TAX_CODE_EXPLICIT_NONE' }),
      ],
      'TaxInclusive',
    );
  });

  it('explains that blank No tax is valid only when every split line is blank', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <SplitEditor
        txn={TXN}
        tags={[]}
        catOpts={[{ group: 'Expenses', name: 'Generic expense' }]}
        taxReadiness={READY}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText('Purchase tax for split line 2'),
      '',
    );
    await user.click(screen.getByRole('button', { name: /save split/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Blank No tax is valid only when every split line is No tax. Use an explicit supported non-tax code to mix treatments.',
    );
  });
});
