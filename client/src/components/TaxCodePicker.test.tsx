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
  it('shows no tax while ready without a selected tax code', () => {
    render(
      <TaxCodePicker
        id="tax-no-selection"
        label="Purchase tax"
        readiness={READY}
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Purchase tax' })).toHaveTextContent('No tax');
  });

  it('offers explicit no tax and only usable purchase tax codes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <TaxCodePicker
        id="tax-code"
        label="Purchase tax"
        readiness={READY}
        value={null}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Purchase tax' }));
    const picker = screen.getByRole('textbox', { name: 'Purchase tax' });
    expect(screen.getByRole('option', { name: 'No tax' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Standard purchase tax' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Inactive purchase tax' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Unsupported purchase tax' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Explicit non-tax treatment' })).not.toBeInTheDocument();

    await user.type(picker, 'standard');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('TAX_CODE_STANDARD');

    view.unmount();
    render(
      <TaxCodePicker
        id="tax-code"
        label="Purchase tax"
        readiness={READY}
        value="TAX_CODE_STANDARD"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Purchase tax' }));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('explains disabled purchase tax and prevents selection', () => {
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
    expect(screen.getByRole('combobox', { name: 'Purchase tax' })).toHaveTextContent('No tax');
    expect(screen.getByText(/purchase tax is disabled/i)).toBeInTheDocument();
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
    expect(screen.getByRole('combobox', { name: 'Purchase tax' })).toHaveTextContent('No tax');
    expect(screen.getByText(/tax availability is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('Standard purchase tax')).not.toBeInTheDocument();
  });

  it('uses sales readiness and sales tax codes when requested', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
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

    await user.click(screen.getByRole('combobox', { name: 'Sales tax' }));
    const picker = screen.getByRole('textbox', { name: 'Sales tax' });
    expect(screen.getByRole('option', { name: 'Standard sales tax' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Standard purchase tax' })).not.toBeInTheDocument();
    await user.type(picker, 'standard');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('SALES_TAX_CODE');
  });
});
