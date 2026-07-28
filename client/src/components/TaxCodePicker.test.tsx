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
    },
    {
      qboId: 'TAX_CODE_INACTIVE',
      name: 'Inactive purchase tax',
      active: false,
      taxable: true,
      combinedPurchaseRate: 7,
    },
    {
      qboId: 'TAX_CODE_UNSUPPORTED',
      name: 'Unsupported purchase tax',
      active: true,
      taxable: true,
      combinedPurchaseRate: null,
    },
  ],
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
});
