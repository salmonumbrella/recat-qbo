import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AttachmentDto,
  AttachmentOperationDto,
  AttachmentSourceInput,
} from '@recat/shared';
import { ApiError, attachments } from '../lib/api';

const MAX_FILES = 20;
const MAX_REQUEST_BYTES = 100_000_000;

function message(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return 'Attachment request failed';
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function httpsUrls(input: string): string[] {
  return input
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

interface AttachmentPanelProps {
  companyId: string;
  transactionId: string;
  canMutate: boolean;
  onCountChange: (count: number) => void;
  toast: (message: string) => void;
}

export default function AttachmentPanel({
  companyId,
  transactionId,
  canMutate,
  onCountChange,
  toast,
}: AttachmentPanelProps) {
  const [items, setItems] = useState<AttachmentDto[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [urlsText, setUrlsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<AttachmentOperationDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AttachmentDto | null>(null);
  const requestSequence = useRef(0);
  const mutationSequence = useRef(0);
  const onCountChangeRef = useRef(onCountChange);
  const toastRef = useRef(toast);
  const identity = `${companyId}:${transactionId}`;

  useEffect(() => {
    onCountChangeRef.current = onCountChange;
    toastRef.current = toast;
  }, [onCountChange, toast]);

  const load = useCallback(async (refresh = false) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const next = await attachments.list(companyId, transactionId, refresh);
      if (sequence !== requestSequence.current) return;
      setItems(next);
      onCountChangeRef.current(next.length);
    } catch (error) {
      if (sequence === requestSequence.current) toastRef.current(message(error));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [companyId, transactionId]);

  useEffect(() => {
    requestSequence.current += 1;
    mutationSequence.current += 1;
    setItems([]);
    setFiles([]);
    setUrlsText('');
    setOperation(null);
    setDeleteTarget(null);
    setBusy(false);
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [identity, load]);

  const urls = useMemo(() => httpsUrls(urlsText), [urlsText]);
  const sourceCount = files.length + urls.length;
  const localBytes = files.reduce((total, file) => total + file.size, 0);
  const invalidUrl = urls.find((url) => {
    try {
      return new URL(url).protocol !== 'https:';
    } catch {
      return true;
    }
  });
  const tooMany = sourceCount > MAX_FILES;
  const tooLarge = localBytes >= MAX_REQUEST_BYTES;
  const canAttach = canMutate && !busy && sourceCount > 0 && !invalidUrl && !tooMany && !tooLarge;

  const finishOperation = async (next: AttachmentOperationDto) => {
    setOperation(next);
    if (next.status === 'VERIFIED' || next.status === 'DELETED') {
      setFiles([]);
      setUrlsText('');
      await load();
    }
  };

  const attach = async () => {
    if (!canAttach) return;
    const sequence = ++mutationSequence.current;
    setBusy(true);
    try {
      const sources: AttachmentSourceInput[] = [];
      if (files.length > 0) {
        const grant = await attachments.createGrant(companyId, files.length, localBytes);
        if (sequence !== mutationSequence.current) return;
        const uploadIds = await attachments.stage(grant, files);
        if (sequence !== mutationSequence.current) return;
        sources.push(...uploadIds.map((uploadId) => ({ kind: 'upload' as const, uploadId })));
      }
      sources.push(...urls.map((url) => ({ kind: 'https' as const, url })));
      const next = await attachments.attach(companyId, transactionId, sources);
      if (sequence !== mutationSequence.current) return;
      await finishOperation(next);
    } catch (error) {
      if (sequence === mutationSequence.current) toast(message(error));
    } finally {
      if (sequence === mutationSequence.current) setBusy(false);
    }
  };

  const continueOperation = async (kind: 'retry' | 'reconcile') => {
    if (!operation || busy) return;
    const sequence = ++mutationSequence.current;
    setBusy(true);
    try {
      const next = kind === 'retry'
        ? await attachments.retry(companyId, transactionId, operation.operationId)
        : await attachments.reconcile(companyId, transactionId, operation.operationId);
      if (sequence !== mutationSequence.current) return;
      await finishOperation(next);
    } catch (error) {
      if (sequence === mutationSequence.current) toast(message(error));
    } finally {
      if (sequence === mutationSequence.current) setBusy(false);
    }
  };

  const saveLocal = async (item: AttachmentDto) => {
    if (busy) return;
    const sequence = ++mutationSequence.current;
    setBusy(true);
    try {
      await attachments.saveLocal(companyId, transactionId, item.id);
      if (sequence !== mutationSequence.current) return;
      await load();
      if (sequence === mutationSequence.current) toast(`${item.filename} saved locally`);
    } catch (error) {
      if (sequence === mutationSequence.current) toast(message(error));
    } finally {
      if (sequence === mutationSequence.current) setBusy(false);
    }
  };

  const remove = async (scope: 'local' | 'everywhere') => {
    if (!deleteTarget || busy) return;
    const sequence = ++mutationSequence.current;
    setBusy(true);
    try {
      const next = await attachments.delete(
        companyId,
        transactionId,
        deleteTarget.id,
        scope,
      );
      if (sequence !== mutationSequence.current) return;
      setDeleteTarget(null);
      await finishOperation(next);
    } catch (error) {
      if (sequence === mutationSequence.current) toast(message(error));
    } finally {
      if (sequence === mutationSequence.current) setBusy(false);
    }
  };

  return (
    <section
      aria-label="Transaction attachments"
      onClick={(event) => event.stopPropagation()}
      style={{
        borderTop: '1px solid var(--rowbd)',
        background: 'color-mix(in srgb, var(--card) 92%, var(--bg))',
        padding: 14,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <strong style={{ fontSize: 13.5 }}>Receipts and attachments</strong>
        <button
          type="button"
          className="btn-ghost"
          disabled={loading || busy}
          onClick={() => void load(true)}
          aria-label="Refresh QuickBooks attachments"
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {items.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0', display: 'grid', gap: 7 }}>
          {items.map((item) => (
            <li
              key={item.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                minWidth: 0,
              }}
            >
              <span aria-hidden="true">📎</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.filename}
                </span>
                <span style={{ color: 'var(--fnt)', fontSize: 11.5 }}>
                  {sizeLabel(item.sizeBytes)} · {item.status.toLowerCase().replaceAll('_', ' ')}
                  {item.retainedLocally ? ' · retained' : ' · QuickBooks only'}
                </span>
              </span>
              {item.canPreview && (
                <a
                  href={attachments.previewUrl(companyId, transactionId, item.id)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Preview ${item.filename}`}
                  className="btn-ghost"
                >
                  Preview
                </a>
              )}
              {item.status !== 'DELETED' && (
                <a
                  href={attachments.downloadUrl(companyId, transactionId, item.id)}
                  aria-label={`Download ${item.filename}`}
                  className="btn-ghost"
                  download
                >
                  Download
                </a>
              )}
              {canMutate && item.sourceKind === 'QBO_EXTERNAL' && !item.retainedLocally && (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() => void saveLocal(item)}
                  aria-label={`Save ${item.filename} locally`}
                >
                  Save local
                </button>
              )}
              {canMutate && item.status !== 'DELETED' && (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() => setDeleteTarget(item)}
                  aria-label={`Delete ${item.filename}`}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : !loading ? (
        <div style={{ color: 'var(--fnt)', fontSize: 12.5, margin: '10px 0' }}>
          No attachments yet.
        </div>
      ) : null}

      {canMutate && (
        <div style={{ borderTop: '1px solid var(--rowbd)', paddingTop: 10, display: 'grid', gap: 8 }}>
          <label
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!busy) setFiles(Array.from(event.dataTransfer.files));
            }}
            style={{
              fontSize: 12.5,
              color: 'var(--mut)',
              border: '1px dashed var(--rowbd)',
              borderRadius: 8,
              padding: 10,
            }}
          >
            Local files
            <span style={{ display: 'block', fontSize: 11.5, marginTop: 3 }}>
              Choose files or drop them here
            </span>
            <input
              type="file"
              multiple
              disabled={busy}
              onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))}
              style={{ display: 'block', marginTop: 5, maxWidth: '100%' }}
            />
          </label>
          <label style={{ fontSize: 12.5, color: 'var(--mut)' }}>
            HTTPS receipt URLs (one per line)
            <textarea
              aria-label="HTTPS receipt URLs"
              className="input"
              value={urlsText}
              disabled={busy}
              onChange={(event) => setUrlsText(event.target.value)}
              rows={2}
              placeholder="https://example.com/receipt.pdf"
              style={{ display: 'block', width: '100%', marginTop: 5, resize: 'vertical' }}
            />
          </label>
          {invalidUrl && <div role="alert" style={{ color: 'var(--erT)', fontSize: 12 }}>HTTPS URLs only.</div>}
          {tooMany && <div role="alert" style={{ color: 'var(--erT)', fontSize: 12 }}>Choose at most 20 files.</div>}
          {tooLarge && (
            <div role="alert" style={{ color: 'var(--erT)', fontSize: 12 }}>
              The encoded QuickBooks request must stay below 100 MB.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="btn-primary" disabled={!canAttach} onClick={() => void attach()}>
              {busy ? 'Working…' : `Attach ${sourceCount} ${sourceCount === 1 ? 'file' : 'files'}`}
            </button>
            {operation?.actions.requiresReconciliation && (
              <button
                type="button"
                className="btn-ghost"
                disabled={busy}
                onClick={() => void continueOperation('reconcile')}
                aria-label="Reconcile attachment upload"
              >
                Reconcile uncertain upload
              </button>
            )}
            {operation?.actions.canRetry && !operation.actions.requiresReconciliation && (
              <button
                type="button"
                className="btn-ghost"
                disabled={busy}
                onClick={() => void continueOperation('retry')}
                aria-label="Retry attachment upload"
              >
                Retry failed files
              </button>
            )}
            {operation?.status === 'PARTIAL' && (
              <span role="status" style={{ color: 'var(--amT)', fontSize: 12.5 }}>
                Some files attached. Only failed files will be retried.
              </span>
            )}
            {operation?.status === 'UNCERTAIN' && (
              <span role="status" style={{ color: 'var(--amT)', fontSize: 12.5 }}>
                QuickBooks may have received the upload. Reconcile before retrying.
              </span>
            )}
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          role="dialog"
          aria-label={`Delete ${deleteTarget.filename}`}
          style={{
            marginTop: 10,
            border: '1px solid var(--erD)',
            borderRadius: 8,
            padding: 10,
            fontSize: 12.5,
          }}
        >
          <div>
            Remove <strong>{deleteTarget.filename}</strong> from Recat only, or from both Recat and
            QuickBooks?
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void remove('local')}>
              Delete local copy
            </button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void remove('everywhere')}>
              Delete everywhere
            </button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setDeleteTarget(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
