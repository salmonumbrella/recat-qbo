import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TaxReadinessDto } from '@recat/shared';
import TaxCodePicker from './TaxCodePicker';

const READY: TaxReadinessDto = {
  status: 'ready',
  reason: null,
  usingSalesTax: true,
  refreshedAt: '2026-07-28T00:00:00.000Z',
  taxCodes: [
    {
      qboId: 'TAX_CODE_STANDARD',
      name: 'Standard purchase tax',
      active: true,
      taxable: true,
      combinedPurchaseRate: 5,
      combinedSalesRate: null,
    },
    {
      qboId: 'TAX_CODE_INACTIVE',
      name: 'Inactive purchase tax',
      active: false,
      taxable: true,
      combinedPurchaseRate: 7,
      combinedSalesRate: null,
    },
    {
      qboId: 'TAX_CODE_UNSUPPORTED',
      name: 'Unsupported purchase tax',
      active: true,
      taxable: true,
      combinedPurchaseRate: null,
      combinedSalesRate: null,
    },
    {
      qboId: 'TAX_CODE_EXPLICIT_NONE',
      name: 'Explicit non-tax treatment',
      active: true,
      taxable: false,
      combinedPurchaseRate: null,
      combinedSalesRate: null,
    },
  ],
  salesStatus: 'needs_setup',
  salesReason: null,
  salesTaxCodes: [],
};

describe('TaxCodePicker', () => {
  it('offers explicit no tax and only usable purchase tax codes', async () => {
    const onChange = vi.fn();
    render(
      <TaxCodePicker
        id="tax-code"
        label="Purchase tax"
        readiness={READY}
        value={null}
        onChange={onChange}
      />,
    );

    const picker = screen.getByLabelText('Purchase tax');
    expect(picker).toHaveTextContent('No tax');
    expect(picker).toHaveTextContent('Standard purchase tax');
    expect(picker).not.toHaveTextContent('Inactive purchase tax');
    expect(picker).not.toHaveTextContent('Unsupported purchase tax');
    expect(picker).not.toHaveTextContent('Explicit non-tax treatment');

    await userEvent.selectOptions(picker, 'TAX_CODE_STANDARD');
    expect(onChange).toHaveBeenCalledWith('TAX_CODE_STANDARD');
    await userEvent.selectOptions(picker, '');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('explains disabled purchase tax while keeping no tax explicit', () => {
    render(
      <TaxCodePicker
        id="tax-disabled"
        label="Purchase tax"
        readiness={{
          status: 'unsupported',
          reason: 'Purchase tax is disabled.',
          usingSalesTax: false,
          refreshedAt: null,
          taxCodes: [],
          salesStatus: 'unsupported',
          salesReason: 'Sales tax is disabled.',
          salesTaxCodes: [],
        }}
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Purchase tax')).toBeDisabled();
    expect(screen.getByText(/purchase tax is disabled/i)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'No tax' })).toBeInTheDocument();
  });

  it('explains unavailable readiness without inventing tax choices', () => {
    render(
      <TaxCodePicker
        id="tax-unavailable"
        label="Purchase tax"
        readiness={null}
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Purchase tax')).toBeDisabled();
    expect(screen.getByText(/tax availability is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('Standard purchase tax')).not.toBeInTheDocument();
  });

  it('uses sales readiness and sales tax codes when requested', async () => {
    const onChange = vi.fn();
    render(
      <TaxCodePicker
        id="sales-tax-code"
        label="Sales tax"
        direction="sales"
        readiness={{
          ...READY,
          salesStatus: 'ready',
          salesReason: null,
          salesTaxCodes: [{
            qboId: 'SALES_TAX_CODE',
            name: 'Standard sales tax',
            active: true,
            taxable: true,
            combinedPurchaseRate: null,
            combinedSalesRate: 5,
          }],
        }}
        value={null}
        onChange={onChange}
      />,
    );

    const picker = screen.getByLabelText('Sales tax');
    expect(picker).toHaveTextContent('Standard sales tax');
    expect(picker).not.toHaveTextContent('Standard purchase tax');
    await userEvent.selectOptions(picker, 'SALES_TAX_CODE');
    expect(onChange).toHaveBeenCalledWith('SALES_TAX_CODE');
  });
});
