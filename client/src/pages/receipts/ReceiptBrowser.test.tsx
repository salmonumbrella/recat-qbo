import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  batchApprove: vi.fn(),
  batchReprocess: vi.fn(),
  batchDelete: vi.fn(),
  export: vi.fn(),
  upload: vi.fn(),
  duplicates: vi.fn(),
  toast: vi.fn(),
  role: 'categorizer' as 'viewer' | 'categorizer',
}));

vi.mock('../../lib/api', () => ({
  createCategorizationRequestId: () =>
    '00000000-0000-4000-8000-000000000061',
  receipts: {
    list: mocks.list,
    batchApprove: mocks.batchApprove,
    batchDelete: mocks.batchDelete,
    batchReprocess: mocks.batchReprocess,
    export: mocks.export,
    upload: mocks.upload,
    duplicates: mocks.duplicates,
  },
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'company-1',
    role: mocks.role,
    toast: mocks.toast,
  }),
}));

import ReceiptBrowser from './ReceiptBrowser';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'categorizer';
  mocks.list.mockResolvedValue({
    receipts: [{
      id: '00000000-0000-4000-8000-000000000071',
      filename: 'synthetic.pdf',
      status: 'READY',
      revision: 2,
      approved: false,
      sourceKind: 'WEB_UPLOAD',
      currentExtraction: {
        vendorName: 'Invented Vendor',
        receiptDate: '2026-07-30',
        totalAmount: '11',
        currency: 'USD',
      },
      createdAt: '2026-07-30T00:00:00.000Z',
    }],
    total: 1,
    page: 1,
    pageSize: 20,
  });
  mocks.batchApprove.mockResolvedValue({ updated: 1 });
  mocks.batchReprocess.mockResolvedValue({ updated: 1 });
  mocks.batchDelete.mockResolvedValue({ updated: 1 });
  mocks.export.mockResolvedValue(new Blob(['synthetic']));
  mocks.upload.mockResolvedValue({ receipts: [] });
  mocks.duplicates.mockResolvedValue([]);
});

describe('ReceiptBrowser', () => {
  it('filters, selects, and batch approves current revisions', async () => {
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);

    expect(await screen.findByText('synthetic.pdf')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Needs review' }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(
      'company-1',
      expect.objectContaining({ statuses: ['NEEDS_REVIEW'] }),
    ));
    await userEvent.click(screen.getByRole('checkbox', {
      name: /select synthetic.pdf/i,
    }));
    await userEvent.click(screen.getByRole('button', { name: /approve selected/i }));

    expect(mocks.batchApprove).toHaveBeenCalledWith('company-1', {
      receipts: [{
        id: '00000000-0000-4000-8000-000000000071',
        expectedRevision: 2,
      }],
    });
  });

  it('applies date, type, source, match, and missing-information filters', async () => {
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    await screen.findByText('synthetic.pdf');
    await userEvent.click(screen.getByText('More filters'));
    await userEvent.type(screen.getByLabelText('Receipt date from'), '2026-07-01');
    await userEvent.type(screen.getByLabelText('Document type filter'), 'receipt');
    await userEvent.selectOptions(screen.getByLabelText('Receipt source filter'), 'WEB_UPLOAD');
    await userEvent.selectOptions(screen.getByLabelText('Receipt match filter'), 'unmatched');
    await userEvent.click(screen.getByLabelText('Missing information'));

    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(
      'company-1',
      expect.objectContaining({
        dateFrom: '2026-07-01',
        documentTypes: ['receipt'],
        sourceKinds: ['WEB_UPLOAD'],
        matched: false,
        missingInfo: true,
      }),
    ));
  });

  it('batch reprocesses and deletes using the visible current revision', async () => {
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    const checkbox = await screen.findByRole('checkbox', {
      name: /select synthetic.pdf/i,
    });
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole('button', { name: /reprocess selected/i }));
    expect(mocks.batchReprocess).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({
        receipts: [{
          id: '00000000-0000-4000-8000-000000000071',
          expectedRevision: 2,
        }],
      }),
    );

    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole('button', { name: /delete selected/i }));
    expect(mocks.batchDelete).toHaveBeenCalledWith('company-1', {
      receipts: [{
        id: '00000000-0000-4000-8000-000000000071',
        expectedRevision: 2,
      }],
    });
  });

  it('lets viewers select and export without exposing mutation actions', async () => {
    mocks.role = 'viewer';
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:synthetic-export'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    await userEvent.click(await screen.findByRole('checkbox', {
      name: /select synthetic.pdf/i,
    }));

    expect(screen.queryByRole('button', { name: /approve selected/i }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /export selected/i }));
    expect(mocks.export).toHaveBeenCalledWith('company-1', {
      documentIds: ['00000000-0000-4000-8000-000000000071'],
    });
  });

  it('renders duplicate groups with navigable receipt links', async () => {
    const duplicate = {
      ...(await mocks.list()).receipts[0],
      id: '00000000-0000-4000-8000-000000000072',
      filename: 'synthetic-copy.pdf',
    };
    mocks.duplicates.mockResolvedValue([{
      key: 'synthetic-group',
      reason: 'document_identity',
      receipts: [
        (await mocks.list()).receipts[0],
        duplicate,
      ],
    }]);
    render(<MemoryRouter><ReceiptBrowser /></MemoryRouter>);
    await screen.findByText('synthetic.pdf');
    await userEvent.click(screen.getByRole('button', { name: 'Duplicates' }));

    expect(await screen.findByText('same receipt identity')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Sort receipts')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Search receipts')).toBeDisabled();
    expect(screen.getAllByRole('link', { name: 'synthetic-copy.pdf' }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          href: expect.stringContaining(
            '/receipts/00000000-0000-4000-8000-000000000072',
          ),
        }),
      ]));
  });
});
