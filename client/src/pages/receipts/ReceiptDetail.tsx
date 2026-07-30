import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  ReceiptDetailDto,
  ReceiptMatchCandidateDto,
} from '@recat/shared';
import {
  createCategorizationRequestId,
  receipts,
} from '../../lib/api';
import ReceiptCandidates from '../../components/receipts/ReceiptCandidates';
import ReceiptMetadataForm from '../../components/receipts/ReceiptMetadataForm';
import ReceiptPreview from '../../components/receipts/ReceiptPreview';
import { useApp } from '../../state/AppContext';

type ReceiptAction =
  | 'save'
  | 'reprocess'
  | 'rematch'
  | 'confirm'
  | 'attach'
  | 'undo'
  | 'delete'
  | null;

function editableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement
    ? target
    : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  if (element === null) return false;
  return element.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(element.tagName);
}

export default function ReceiptDetail() {
  const { receiptId } = useParams<{ receiptId: string }>();
  const navigate = useNavigate();
  const { activeCompanyId, role, toast } = useApp();
  const [detail, setDetail] = useState<ReceiptDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<ReceiptAction>(null);
  const sequence = useRef(0);
  const mutable = role === 'admin' || role === 'categorizer';

  const reload = useCallback(async (): Promise<ReceiptDetailDto | null> => {
    if (!activeCompanyId || !receiptId) return null;
    const request = ++sequence.current;
    setLoading(true);
    try {
      const result = await receipts.detail(activeCompanyId, receiptId);
      if (sequence.current !== request) return null;
      setDetail(result);
      return result;
    } catch (error) {
      if (sequence.current === request) {
        toast(error instanceof Error ? error.message : 'Could not load receipt');
      }
      return null;
    } finally {
      if (sequence.current === request) setLoading(false);
    }
  }, [activeCompanyId, receiptId, toast]);

  useEffect(() => {
    sequence.current += 1;
    setDetail(null);
    void reload();
    return () => {
      sequence.current += 1;
    };
  }, [reload]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!detail || editableTarget(event.target)) return;
      if (event.key === 'ArrowLeft' && detail.previousId) {
        navigate(`/receipts/${detail.previousId}`);
      }
      if (event.key === 'ArrowRight' && detail.nextId) {
        navigate(`/receipts/${detail.nextId}`);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [detail, navigate]);

  const run = async (
    nextAction: Exclude<ReceiptAction, null>,
    operation: () => Promise<ReceiptDetailDto>,
  ) => {
    if (action !== null) return;
    setAction(nextAction);
    try {
      setDetail(await operation());
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Receipt action failed');
      await reload();
    } finally {
      setAction(null);
    }
  };

  if (!activeCompanyId || !receiptId) {
    return <div style={{ padding: 32 }}>Choose a receipt.</div>;
  }
  if (loading && !detail) return <div style={{ padding: 32 }}>Loading receipt…</div>;
  if (!detail) return <div style={{ padding: 32 }}>Receipt not found.</div>;

  const confirmedCandidate = detail.candidates.find((candidate) =>
    candidate.transactionId === detail.matchedTransactionId);
  const attachRevision = confirmedCandidate?.transactionRevision;
  const canReprocess = ['NEEDS_REVIEW', 'READY', 'FAILED'].includes(detail.status);
  const canRematch = detail.currentExtraction?.status === 'succeeded'
    && !['ATTACHING', 'ATTACHED'].includes(detail.status);

  const confirm = (candidate: ReceiptMatchCandidateDto) => void run(
    'confirm',
    () => receipts.confirmMatch(
      activeCompanyId,
      detail.id,
      candidate.transactionId,
      {
        expectedReceiptRevision: detail.revision,
        expectedTransactionRevision: candidate.transactionRevision,
      },
    ),
  );

  return (
    <main style={{ maxWidth: 1440, margin: '0 auto', padding: '22px clamp(12px,2.5vw,28px) 70px' }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <button type="button" onClick={() => navigate('/receipts')}>Back to receipts</button>
        <h1 style={{ fontSize: 21, margin: 0 }}>{detail.filename}</h1>
        <span style={{ color: 'var(--mut)' }}>{detail.status.replaceAll('_', ' ')}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>
          <button
            type="button"
            disabled={!detail.previousId}
            onClick={() => detail.previousId && navigate(`/receipts/${detail.previousId}`)}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!detail.nextId}
            onClick={() => detail.nextId && navigate(`/receipts/${detail.nextId}`)}
          >
            Next
          </button>
        </div>
      </div>
      {mutable && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          {canReprocess && (
            <button
              type="button"
              disabled={action !== null}
              onClick={() => void run('reprocess', () => receipts.reprocess(
                activeCompanyId,
                detail.id,
                {
                  expectedRevision: detail.revision,
                  idempotencyKey: createCategorizationRequestId(),
                },
              ))}
            >
              Reprocess
            </button>
          )}
          {canRematch && (
            <button
              type="button"
              disabled={action !== null}
              onClick={() => void run('rematch', () => receipts.rematch(
                activeCompanyId,
                detail.id,
                detail.revision,
              ))}
            >
              Find matches
            </button>
          )}
          {detail.status === 'MATCHED' && attachRevision !== undefined && (
            <button
              type="button"
              disabled={action !== null}
              onClick={() => void run('attach', async () => {
                await receipts.attach(activeCompanyId, detail.id, {
                  expectedReceiptRevision: detail.revision,
                  expectedTransactionRevision: attachRevision,
                });
                return receipts.detail(activeCompanyId, detail.id);
              })}
            >
              Attach to QuickBooks
            </button>
          )}
          {detail.status === 'ATTACHING' && (
            <button
              type="button"
              disabled={action !== null || attachRevision === undefined}
              onClick={() => attachRevision !== undefined && void run(
                detail.transactionAttachmentId === null ? 'attach' : 'undo',
                async () => {
                  const operation = detail.transactionAttachmentId === null
                    ? receipts.attach
                    : receipts.undo;
                  await operation(activeCompanyId, detail.id, {
                    expectedReceiptRevision: detail.revision,
                    expectedTransactionRevision: attachRevision,
                  });
                  return receipts.detail(activeCompanyId, detail.id);
                },
              )}
            >
              {detail.transactionAttachmentId === null
                ? 'Resume attachment'
                : 'Resume attachment undo'}
            </button>
          )}
          {detail.status === 'ATTACHED' && attachRevision !== undefined && (
            <button
              type="button"
              disabled={action !== null}
              onClick={() => void run('undo', async () => {
                await receipts.undo(activeCompanyId, detail.id, {
                  expectedReceiptRevision: detail.revision,
                  expectedTransactionRevision: attachRevision,
                });
                return receipts.detail(activeCompanyId, detail.id);
              })}
            >
              Undo attachment
            </button>
          )}
          {!['ATTACHING', 'ATTACHED'].includes(detail.status) && (
            <button
              type="button"
              disabled={action !== null}
              onClick={() => {
                if (!window.confirm('Delete this receipt?')) return;
                setAction('delete');
                receipts.delete(activeCompanyId, detail.id, detail.revision)
                  .then(() => navigate('/receipts'))
                  .catch((error: unknown) => {
                    toast(error instanceof Error ? error.message : 'Could not delete receipt');
                  })
                  .finally(() => setAction(null));
              }}
            >
              Delete receipt
            </button>
          )}
        </div>
      )}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(300px,1fr) minmax(360px,1fr)',
        gap: 18,
        alignItems: 'start',
      }} className="receipt-detail-grid">
        <section style={{ border: '1px solid var(--bd2)', borderRadius: 10, overflow: 'hidden', background: 'var(--card)' }}>
          <ReceiptPreview companyId={activeCompanyId} receipt={detail} />
        </section>
        <div style={{ display: 'grid', gap: 18 }}>
          <section style={{ border: '1px solid var(--bd2)', borderRadius: 10, padding: 16, background: 'var(--card)' }}>
            <h2 style={{ fontSize: 17, marginTop: 0 }}>Receipt details</h2>
            {detail.manuallyEdited && (
              <div style={{ color: 'var(--mut)', fontSize: 13, marginBottom: 9 }}>
                This receipt includes manual edits.
              </div>
            )}
            <ReceiptMetadataForm
              companyId={activeCompanyId}
              receipt={detail}
              mutable={mutable}
              busy={action !== null}
              onBusy={(busy) => setAction(busy ? 'save' : null)}
              onSaved={setDetail}
              onReload={reload}
            />
            {detail.currentExtraction?.taxComponents.length ? (
              <div style={{ marginTop: 12 }}>
                <strong>Detected taxes</strong>
                {detail.currentExtraction.taxComponents.map((component, index) => (
                  <div key={`${component.label}-${index}`}>
                    <span>{component.label}</span>: {component.amount ?? '—'}
                    {component.rate ? ` (${component.rate})` : ''}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
          <section style={{ border: '1px solid var(--bd2)', borderRadius: 10, padding: 16, background: 'var(--card)' }}>
            <h2 style={{ fontSize: 17, marginTop: 0 }}>Transaction matches</h2>
            <ReceiptCandidates
              candidates={detail.candidates}
              mutable={mutable}
              busy={action !== null}
              onConfirm={confirm}
            />
          </section>
          <section style={{ border: '1px solid var(--bd2)', borderRadius: 10, padding: 16 }}>
            <h2 style={{ fontSize: 17, marginTop: 0 }}>Extraction history</h2>
            <div style={{ fontSize: 13 }}>
              {detail.currentExtraction && (
                <div style={{ display: 'grid', gap: 4 }}>
                  <div>
                    {detail.currentExtraction.model} · confidence{' '}
                    {detail.currentExtraction.extractionConfidence === null
                    ? '—'
                    : `${Math.round(detail.currentExtraction.extractionConfidence * 100)}%`}
                    {' '}· {detail.currentExtraction.tokensIn + detail.currentExtraction.tokensOut} tokens
                    {detail.currentExtraction.costUsd
                      ? ` · USD ${detail.currentExtraction.costUsd}`
                      : ''}
                    {detail.currentExtraction.parseSalvaged ? ' · salvaged parse' : ''}
                  </div>
                  <div>
                    Prompt {detail.currentExtraction.promptVersion} · schema{' '}
                    {detail.currentExtraction.schemaVersion} · duration{' '}
                    {detail.currentExtraction.durationMs === null
                      ? '—'
                      : `${detail.currentExtraction.durationMs} ms`}
                  </div>
                  {(detail.currentExtraction.convertedAmount !== null
                    || detail.currentExtraction.conversionRate !== null) && (
                    <div>
                      Converted amount {detail.currentExtraction.convertedAmount ?? '—'} · rate{' '}
                      {detail.currentExtraction.conversionRate ?? '—'}
                    </div>
                  )}
                  {detail.currentExtraction.errorCode && (
                    <div role="alert">Extraction error: {detail.currentExtraction.errorCode}</div>
                  )}
                  {detail.currentExtraction.warnings.length > 0 && (
                    <ul aria-label="Extraction warnings" style={{ margin: 0, paddingLeft: 20 }}>
                      {detail.currentExtraction.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {detail.attempts.map((attempt) => (
                <div key={attempt.id} style={{ paddingTop: 6 }}>
                  Generation {attempt.generation} · {attempt.status} · {attempt.model}
                </div>
              ))}
            </div>
          </section>
          <section style={{ border: '1px solid var(--bd2)', borderRadius: 10, padding: 16 }}>
            <h2 style={{ fontSize: 17, marginTop: 0 }}>Activity</h2>
            {detail.events.map((event) => (
              <div key={event.id} style={{ fontSize: 13, padding: '5px 0' }}>
                {event.action.replaceAll('_', ' ')} · {new Date(event.createdAt).toLocaleString()}
              </div>
            ))}
            {detail.events.length === 0 && <div style={{ color: 'var(--mut)' }}>No activity yet.</div>}
          </section>
        </div>
      </div>
    </main>
  );
}
