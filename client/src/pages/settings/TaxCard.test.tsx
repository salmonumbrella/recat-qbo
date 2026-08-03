import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, TaxReadinessDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  role: 'admin' as Role,
  readiness: {
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
  } as TaxReadinessDto | null,
  loading: false,
  refresh: vi.fn(),
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({
    role: mocks.role,
    taxReadiness: mocks.readiness,
    taxReadinessLoading: mocks.loading,
    refreshTaxReferences: mocks.refresh,
  }),
}));

import TaxCard from './TaxCard';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'admin';
  mocks.loading = false;
  mocks.refresh.mockResolvedValue(undefined);
});

describe('TaxCard', () => {
  it('shows readiness and lets an admin refresh references', async () => {
    render(<TaxCard />);

    expect(screen.getByText(/purchase tax ready/i)).toBeInTheDocument();
    expect(screen.getByText(/1 usable purchase tax code/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /refresh tax references/i }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it('shows readiness read-only to non-admin members', () => {
    mocks.role = 'categorizer';
    render(<TaxCard />);

    expect(screen.getByText(/purchase tax ready/i)).toBeInTheDocument();
    expect(screen.getByText(/only company administrators can refresh/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh tax references/i })).not.toBeInTheDocument();
  });
});
