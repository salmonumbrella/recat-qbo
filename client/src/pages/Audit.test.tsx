import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Audit from './Audit';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  toast: vi.fn(),
  notifyQboMutation: vi.fn(),
  undoCategorization: vi.fn(),
  legacyUndo: vi.fn(),
  requestId: vi.fn(),
  qboMutationRevision: 0,
}));

vi.mock('../lib/api', () => ({
  audit: {
    list: mocks.list,
    exportUrl: (companyId: string) => `/api/companies/${companyId}/audit/export.csv`,
  },
  createCategorizationRequestId: mocks.requestId,
  transactions: {
    undoCategorization: mocks.undoCategorization,
    undo: mocks.legacyUndo,
  },
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'company-1',
    toast: mocks.toast,
    notifyQboMutation: mocks.notifyQboMutation,
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
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.qboMutationRevision = 0;
    mocks.requestId.mockReturnValue('undo-request-generic');
    mocks.undoCategorization.mockResolvedValue({ ok: true, outcome: 'VERIFIED', status: 'PENDING' });
    mocks.legacyUndo.mockResolvedValue({ status: 'PENDING' });
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

  it('runs a durable Undo from the audit entry and refreshes the log', async () => {
    mocks.list.mockResolvedValue({
      entries: [{
        ...blockedEntry,
        id: 'audit-posted',
        action: 'posted',
        transactionId: 'transaction-generic',
        undo: { kind: 'categorization' },
      }],
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(<Audit />);

    await user.click(await screen.findByRole('button', { name: /undo locked supplier/i }));

    expect(mocks.undoCategorization).toHaveBeenCalledWith(
      'transaction-generic',
      'undo-request-generic',
    );
    expect(mocks.legacyUndo).not.toHaveBeenCalled();
    expect(mocks.notifyQboMutation).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith('Reverted in QuickBooks.');
  });

  it('does not claim QuickBooks was reverted while durable Undo is still in progress', async () => {
    mocks.list.mockResolvedValue({
      entries: [{
        ...blockedEntry,
        id: 'audit-posted',
        action: 'posted',
        transactionId: 'transaction-generic',
        undo: { kind: 'categorization' },
      }],
      nextCursor: null,
    });
    mocks.undoCategorization.mockResolvedValue({
      ok: false,
      outcome: 'IN_PROGRESS',
      status: 'POSTED',
    });
    const user = userEvent.setup();
    render(<Audit />);

    await user.click(await screen.findByRole('button', { name: /undo locked supplier/i }));

    expect(mocks.notifyQboMutation).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith('Undo is still in progress. Check Audit again before retrying.');
    expect(mocks.toast).not.toHaveBeenCalledWith('Reverted in QuickBooks.');
  });

  it('runs a legacy Undo without allocating a durable operation ID', async () => {
    mocks.list.mockResolvedValue({
      entries: [{
        ...blockedEntry,
        id: 'audit-legacy-post',
        action: 'posted',
        transactionId: 'transaction-legacy',
        undo: { kind: 'legacy' },
      }],
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(<Audit />);

    await user.click(await screen.findByRole('button', { name: /undo locked supplier/i }));

    expect(mocks.legacyUndo).toHaveBeenCalledWith('transaction-legacy');
    expect(mocks.undoCategorization).not.toHaveBeenCalled();
    expect(mocks.requestId).not.toHaveBeenCalled();
    expect(mocks.notifyQboMutation).toHaveBeenCalledTimes(1);
  });

  it('describes a dry-run requeue without claiming QuickBooks was changed', async () => {
    mocks.list.mockResolvedValue({
      entries: [{
        ...blockedEntry,
        id: 'audit-dry-run',
        action: 'dry-run',
        transactionId: 'transaction-dry-run',
        undo: { kind: 'legacy' },
      }],
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(<Audit />);

    await user.click(await screen.findByRole('button', { name: /undo locked supplier/i }));

    expect(mocks.legacyUndo).toHaveBeenCalledWith('transaction-dry-run');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/move this dry run back to the queue/i));
    expect(mocks.toast).toHaveBeenCalledWith('Dry run moved back to the queue.');
    expect(mocks.toast).not.toHaveBeenCalledWith('Reverted in QuickBooks.');
  });

  it('refreshes the log when a blocked Undo returns an error', async () => {
    mocks.list.mockResolvedValue({
      entries: [{
        ...blockedEntry,
        id: 'audit-posted',
        action: 'posted',
        transactionId: 'transaction-generic',
        undo: { kind: 'categorization' },
      }],
      nextCursor: null,
    });
    mocks.undoCategorization.mockRejectedValue(new Error('QuickBooks reports this transaction as reconciled.'));
    const user = userEvent.setup();
    render(<Audit />);

    await user.click(await screen.findByRole('button', { name: /undo locked supplier/i }));

    await waitFor(() => expect(mocks.notifyQboMutation).toHaveBeenCalledTimes(1));
    expect(mocks.toast).toHaveBeenCalledWith('QuickBooks reports this transaction as reconciled.');
  });
});
