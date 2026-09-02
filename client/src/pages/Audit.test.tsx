import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Audit from './Audit';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  toast: vi.fn(),
  qboMutationRevision: 0,
}));

vi.mock('../lib/api', () => ({
  audit: {
    list: mocks.list,
    exportUrl: (companyId: string) => `/api/companies/${companyId}/audit/export.csv`,
  },
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'company-1',
    toast: mocks.toast,
    qboMutationRevision: mocks.qboMutationRevision,
  }),
}));

vi.mock('./settings/AutopilotCard', () => ({
  AutopilotQueueStatus: () => <div>Autopilot summary</div>,
}));

const blockedEntry = {
  id: 'audit-1',
  companyId: 'company-1',
  at: '2026-09-02T16:00:00.000Z',
  actor: 'Vladimir',
  payee: 'Locked supplier',
  amount: -10.5,
  action: 'blocked' as const,
  before: 'Uncategorized Expense',
  after: 'Blocked — reconciled in QuickBooks',
};

describe('Audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.qboMutationRevision = 0;
    mocks.list.mockResolvedValue({ entries: [blockedEntry], nextCursor: null });
  });

  it('describes mutation outcomes accurately and renders blocked attempts', async () => {
    render(<Audit />);

    expect(await screen.findByText('Locked supplier')).toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(screen.getByText(/every attempt to change quickbooks and its verified outcome/i))
      .toBeInTheDocument();
  });

  it('reloads the current audit page after a QuickBooks mutation signal', async () => {
    const view = render(<Audit />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    mocks.qboMutationRevision += 1;
    view.rerender(<Audit />);

    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });
});
