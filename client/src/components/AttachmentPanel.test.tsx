import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createGrant: vi.fn(),
  stage: vi.fn(),
  attach: vi.fn(),
  list: vi.fn(),
  retry: vi.fn(),
  reconcile: vi.fn(),
  delete: vi.fn(),
  saveLocal: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  attachments: {
    createGrant: mocks.createGrant,
    stage: mocks.stage,
    attach: mocks.attach,
    list: mocks.list,
    retry: mocks.retry,
    reconcile: mocks.reconcile,
    delete: mocks.delete,
    saveLocal: mocks.saveLocal,
    downloadUrl: (_companyId: string, _transactionId: string, attachmentId: string) =>
      `/download/${attachmentId}`,
    previewUrl: (_companyId: string, _transactionId: string, attachmentId: string) =>
      `/preview/${attachmentId}`,
  },
}));

import AttachmentPanel from './AttachmentPanel';

const retained = {
  id: 'attachment-1',
  transactionId: 'transaction-1',
  filename: 'receipt.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1234,
  sourceKind: 'LOCAL_UPLOAD' as const,
  retainedLocally: true,
  status: 'ATTACHED' as const,
  qboAttached: true,
  canPreview: true,
  error: null,
};

const external = {
  ...retained,
  id: 'attachment-2',
  filename: 'external.pdf',
  sourceKind: 'QBO_EXTERNAL' as const,
  retainedLocally: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([retained, external]);
  mocks.createGrant.mockResolvedValue({
    uploadUrl: '/upload/grant-1',
    grant: 'secret',
    expiresAt: '2026-07-30T00:00:00.000Z',
    maxFileCount: 20,
    maxEncodedRequestBytes: 100_000_000,
  });
  mocks.stage.mockResolvedValue(['upload-1']);
  mocks.attach.mockResolvedValue({
    operationId: 'operation-1',
    status: 'VERIFIED',
    files: [retained],
    actions: { canRetry: false, requiresReconciliation: false },
  });
  mocks.saveLocal.mockResolvedValue(retained);
});

describe('AttachmentPanel', () => {
  it('loads attachments and exposes preview, local-save, and explicit deletion scopes', async () => {
    render(
      <AttachmentPanel
        companyId="company-1"
        transactionId="transaction-1"
        canMutate
        onCountChange={vi.fn()}
        toast={mocks.toast}
      />,
    );

    expect(await screen.findByText('receipt.pdf')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /preview receipt.pdf/i })).toHaveAttribute(
      'href',
      '/preview/attachment-1',
    );
    expect(screen.getByRole('link', { name: /download receipt.pdf/i })).toHaveAttribute(
      'href',
      '/download/attachment-1',
    );
    expect(screen.getByRole('button', { name: /save external.pdf locally/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete receipt.pdf/i })).toBeInTheDocument();
  });

  it('stages selected local files and attaches them with HTTPS imports', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AttachmentPanel
        companyId="company-1"
        transactionId="transaction-1"
        canMutate
        onCountChange={vi.fn()}
        toast={mocks.toast}
      />,
    );
    await screen.findByText('receipt.pdf');
    const file = new File(['receipt'], 'new.pdf', { type: 'application/pdf' });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(fileInput, file);
    await user.type(screen.getByLabelText(/https receipt urls/i), 'https://example.test/one.pdf');
    await user.click(screen.getByRole('button', { name: /attach 2 files/i }));

    await waitFor(() => expect(mocks.stage).toHaveBeenCalledWith(
      expect.objectContaining({ grant: 'secret' }),
      [file],
    ));
    expect(mocks.attach).toHaveBeenCalledWith('company-1', 'transaction-1', [
      { kind: 'upload', uploadId: 'upload-1' },
      { kind: 'https', url: 'https://example.test/one.pdf' },
    ]);
  });

  it('accepts files dropped onto the upload target', async () => {
    render(
      <AttachmentPanel
        companyId="company-1"
        transactionId="transaction-1"
        canMutate
        onCountChange={vi.fn()}
        toast={mocks.toast}
      />,
    );
    await screen.findByText('receipt.pdf');
    const file = new File(['receipt'], 'dropped.pdf', {
      type: 'application/pdf',
    });
    fireEvent.drop(screen.getByText(/choose files or drop them here/i).closest('label')!, {
      dataTransfer: { files: [file] },
    });

    expect(screen.getByRole('button', { name: /attach 1 file/i })).toBeEnabled();
  });

  it('offers reconciliation instead of blind retry for an uncertain operation', async () => {
    mocks.attach.mockResolvedValue({
      operationId: 'operation-uncertain',
      status: 'UNCERTAIN',
      files: [],
      actions: { canRetry: false, requiresReconciliation: true },
    });
    render(
      <AttachmentPanel
        companyId="company-1"
        transactionId="transaction-1"
        canMutate
        onCountChange={vi.fn()}
        toast={mocks.toast}
      />,
    );
    await screen.findByText('receipt.pdf');

    await userEvent.type(
      screen.getByLabelText(/https receipt urls/i),
      'https://example.test/one.pdf',
    );
    await userEvent.click(screen.getByRole('button', { name: /attach 1 file/i }));

    expect(await screen.findByRole('button', { name: /reconcile attachment upload/i }))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry attachment upload/i }))
      .not.toBeInTheDocument();
  });

  it('drops stale list completion after the company changes', async () => {
    let resolveFirst!: (value: typeof retained[]) => void;
    mocks.list
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce([]);
    const onCountChange = vi.fn();
    const view = render(
      <AttachmentPanel
        companyId="company-1"
        transactionId="transaction-1"
        canMutate
        onCountChange={onCountChange}
        toast={mocks.toast}
      />,
    );

    view.rerender(
      <AttachmentPanel
        companyId="company-2"
        transactionId="transaction-2"
        canMutate
        onCountChange={onCountChange}
        toast={mocks.toast}
      />,
    );
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    resolveFirst([retained]);

    await waitFor(() => expect(screen.queryByText('receipt.pdf')).not.toBeInTheDocument());
  });

  it('does not attach staged files after the transaction changes', async () => {
    let resolveStage!: (value: string[]) => void;
    mocks.stage.mockReturnValueOnce(new Promise((resolve) => {
      resolveStage = resolve;
    }));
    const view = render(
      <AttachmentPanel
        companyId="company-1"
        transactionId="transaction-1"
        canMutate
        onCountChange={vi.fn()}
        toast={mocks.toast}
      />,
    );
    await screen.findByText('receipt.pdf');
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(
      input,
      new File(['receipt'], 'stale.pdf', { type: 'application/pdf' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /attach 1 file/i }));
    await waitFor(() => expect(mocks.stage).toHaveBeenCalledTimes(1));

    view.rerender(
      <AttachmentPanel
        companyId="company-2"
        transactionId="transaction-2"
        canMutate
        onCountChange={vi.fn()}
        toast={mocks.toast}
      />,
    );
    resolveStage(['upload-stale']);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(
      view.container.querySelector('input[type="file"]'),
    ).not.toBeDisabled();
  });
});
