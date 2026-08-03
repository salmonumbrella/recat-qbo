import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  patch: vi.fn(),
  reprocess: vi.fn(),
  confirmMatch: vi.fn(),
  attach: vi.fn(),
  undo: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  role: 'categorizer' as 'viewer' | 'categorizer',
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => ({ receiptId: 'receipt-1' }),
    useNavigate: () => mocks.navigate,
  };
});

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    code: string | undefined;

    constructor(_status: number, message: string, code?: string) {
      super(message);
      this.code = code;
    }
  },
  createCategorizationRequestId: () =>
    '00000000-0000-4000-8000-000000000081',
  receipts: {
    detail: mocks.detail,
    previewUrl: (companyId: string, receiptId: string) =>
      `/api/companies/${companyId}/receipts/${receiptId}/preview`,
    patch: mocks.patch,
    confirmMatch: mocks.confirmMatch,
    attach: mocks.attach,
    undo: mocks.undo,
    reprocess: mocks.reprocess,
    rematch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'company-1',
    role: mocks.role,
    toast: mocks.toast,
  }),
}));

import ReceiptDetail from './ReceiptDetail';
import { ApiError } from '../../lib/api';

const detail = {
  id: 'receipt-1',
  filename: 'synthetic.pdf',
  contentType: 'application/pdf',
  sizeBytes: '10',
  sha256: 'a'.repeat(64),
  sourceKind: 'WEB_UPLOAD',
  status: 'READY',
  generation: 1,
  revision: 2,
  pageCount: 1,
  retentionPolicy: true,
  retainedLocally: true,
  approved: false,
  userNotes: null,
  manuallyEdited: false,
  lastExportedAt: null,
  matchedTransactionId: null,
  transactionAttachmentId: null,
  currentExtraction: {
    id: 'attempt-1',
    generation: 1,
    status: 'succeeded',
    receiptDate: '2026-07-30',
    documentTitle: 'Synthetic receipt',
    vendorName: 'Synthetic Vendor',
    vendorTaxId: null,
    vendorReceiptId: 'synthetic-1',
    clientName: null,
    clientTaxId: null,
    description: 'Synthetic description',
    lineItems: [],
    subtotal: '10',
    taxAmount: '1',
    totalAmount: '11',
    currency: 'USD',
    convertedAmount: null,
    conversionRate: null,
    paymentMethod: 'card',
    paymentIdentifier: null,
    language: 'en',
    additionalFields: [],
    rawExtractedText: 'Synthetic raw text',
    documentType: 'receipt',
    category: 'Synthetic category',
    extractionConfidence: 0.91,
    taxComponents: [{
      label: 'Tax A',
      rate: '0.10',
      amount: '1',
      confidence: 0.9,
    }],
    parseSalvaged: true,
    warnings: ['synthetic warning'],
    model: 'synthetic/model',
    promptVersion: 'synthetic-v1',
    schemaVersion: 'synthetic-v1',
    tokensIn: 10,
    tokensOut: 5,
    costUsd: '0.01',
    durationMs: 100,
    errorCode: null,
    startedAt: '2026-07-30T00:00:00.000Z',
    completedAt: '2026-07-30T00:00:01.000Z',
  },
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:01.000Z',
  previousId: 'receipt-prev',
  nextId: 'receipt-next',
  attempts: [],
  candidates: [{
    transactionId: 'transaction-1',
    transactionRevision: 4,
    rank: 1,
    score: 92,
    state: 'proposed',
    evidence: {
      amountPoints: 55,
      currencyPoints: 10,
      datePoints: 10,
      vendorPoints: 15,
      paymentPoints: 2,
      amountDifferenceCents: 0,
      dateDifferenceDays: 0,
      vendorSimilarity: 0.9,
    },
    transaction: {
      id: 'transaction-1',
      date: '2026-07-30T00:00:00.000Z',
      payee: 'Synthetic Vendor',
      memo: 'Synthetic memo',
      amount: -11,
      status: 'PENDING',
      revision: 4,
    },
  }],
  events: [],
  attachment: null,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'categorizer';
  mocks.detail.mockResolvedValue(detail);
  mocks.confirmMatch.mockResolvedValue({
    ...detail,
    revision: 3,
    status: 'MATCHED',
    matchedTransactionId: 'transaction-1',
  });
  mocks.attach.mockResolvedValue({
    ...detail,
    revision: 4,
    status: 'ATTACHING',
  });
  mocks.undo.mockResolvedValue({
    operationId: 'operation-undo',
    status: 'DELETING',
    files: [],
    actions: { canRetry: false, requiresReconciliation: false },
  });
  mocks.reprocess.mockResolvedValue({
    ...detail,
    revision: 3,
    status: 'QUEUED',
  });
  mocks.patch.mockImplementation((_companyId, _receiptId, input) =>
    Promise.resolve({
      ...detail,
      revision: input.expectedRevision + 1,
      userNotes: input.patch.userNotes ?? detail.userNotes,
    }));
});

describe('ReceiptDetail', () => {
  it('renders extraction, tax, match evidence, and explicit attach flow', async () => {
    render(<ReceiptDetail />);

    expect(await screen.findByTitle('Receipt preview')).toHaveAttribute(
      'src',
      '/api/companies/company-1/receipts/receipt-1/preview',
    );
    expect(screen.getByDisplayValue('Synthetic Vendor')).toBeInTheDocument();
    expect(screen.getByText('Tax A')).toBeInTheDocument();
    expect(screen.getByText('92 / 100')).toBeInTheDocument();
    expect(screen.getByText(/amount 55/i)).toBeInTheDocument();
    expect(screen.getByText(/salvaged/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /confirm match/i }));
    expect(mocks.confirmMatch).toHaveBeenCalledWith(
      'company-1',
      'receipt-1',
      'transaction-1',
      {
        expectedReceiptRevision: 2,
        expectedTransactionRevision: 4,
      },
    );
    await userEvent.click(await screen.findByRole('button', {
      name: /attach to quickbooks/i,
    }));
    expect(mocks.attach).toHaveBeenCalled();
  });

  it('uses arrow navigation only outside editable controls', async () => {
    render(<ReceiptDetail />);
    await screen.findByDisplayValue('Synthetic Vendor');

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(mocks.navigate).toHaveBeenCalledWith('/receipts/receipt-next');
    screen.getByLabelText('Vendor name').focus();
    fireEvent.keyDown(document, { key: 'ArrowLeft' });

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));
  });

  it('refreshes the editor revision after an action updates the same receipt', async () => {
    render(<ReceiptDetail />);
    await screen.findByDisplayValue('Synthetic Vendor');

    await userEvent.click(screen.getByRole('button', { name: 'Reprocess' }));
    await userEvent.type(screen.getByLabelText('Notes'), 'Synthetic note');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith(
      'company-1',
      'receipt-1',
      expect.objectContaining({ expectedRevision: 3 }),
    ));
  });

  it('validates decimal edits before calling the API', async () => {
    render(<ReceiptDetail />);
    const total = await screen.findByLabelText('Total amount');
    await userEvent.clear(total);
    await userEvent.type(total, 'not-a-number');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Total amount is invalid');
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('renders images safely and hides mutation controls from viewers', async () => {
    mocks.role = 'viewer';
    mocks.detail.mockResolvedValue({ ...detail, contentType: 'image/png' });
    render(<ReceiptDetail />);

    expect(await screen.findByRole('img', { name: /preview of synthetic.pdf/i }))
      .toHaveAttribute(
        'src',
        '/api/companies/company-1/receipts/receipt-1/preview',
      );
    expect(screen.queryByRole('button', { name: 'Reprocess' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Vendor name')).toBeDisabled();
  });

  it('resumes an in-flight attachment operation with current fences', async () => {
    mocks.detail.mockResolvedValue({
      ...detail,
      status: 'ATTACHING',
      matchedTransactionId: 'transaction-1',
    });
    render(<ReceiptDetail />);
    await userEvent.click(await screen.findByRole('button', {
      name: 'Resume attachment',
    }));

    expect(mocks.attach).toHaveBeenCalledWith('company-1', 'receipt-1', {
      expectedReceiptRevision: 2,
      expectedTransactionRevision: 4,
    });
  });

  it('resumes an in-flight attachment undo with current fences', async () => {
    mocks.detail.mockResolvedValue({
      ...detail,
      status: 'ATTACHING',
      matchedTransactionId: 'transaction-1',
      transactionAttachmentId: 'attachment-1',
    });
    render(<ReceiptDetail />);
    await userEvent.click(await screen.findByRole('button', {
      name: 'Resume attachment undo',
    }));

    expect(mocks.undo).toHaveBeenCalledWith('company-1', 'receipt-1', {
      expectedReceiptRevision: 2,
      expectedTransactionRevision: 4,
    });
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it('preserves stale edits and lets the user discard them for server values', async () => {
    mocks.detail
      .mockResolvedValueOnce(detail)
      .mockResolvedValue({ ...detail, revision: 3, userNotes: 'Server note' });
    mocks.patch.mockRejectedValueOnce(
      new ApiError(409, 'Receipt changed', 'RECEIPT_STALE'),
    );
    render(<ReceiptDetail />);
    const notes = await screen.findByLabelText('Notes');
    await userEvent.type(notes, 'Local note');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('edits are preserved');
    expect(notes).toHaveValue('Local note');
    await userEvent.click(screen.getByRole('button', { name: 'Discard local edits' }));
    expect(notes).toHaveValue('Server note');
  });
});
