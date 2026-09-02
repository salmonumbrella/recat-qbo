import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClassificationPastDecisionItem } from '@recat/shared';
import { classificationMemory } from '../../lib/api';
import { fmtDate } from '../../lib/format';

const buttonStyle = {
  border: '1px solid var(--bd)', background: 'var(--card)', color: 'var(--ink)',
  borderRadius: 7, padding: '7px 10px', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit',
} as const;

function actionSummary(item: ClassificationPastDecisionItem): string {
  const { categoryName, taxCalculation, taxCodeName, tagNames } = item.actionSummary;
  return [categoryName, taxCalculation, taxCodeName, tagNames.length > 0 ? tagNames.join(', ') : null]
    .filter((value): value is string => value !== null)
    .join(' · ');
}

export default function PastDecisionsSection({ companyId }: { companyId: string }) {
  const requestRef = useRef(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ClassificationPastDecisionItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  const load = useCallback(async (append: boolean, pageCursor?: string) => {
    const requestId = ++requestRef.current;
    setState('loading');
    setError(null);
    try {
      const page = await classificationMemory.pastDecisions(companyId, {
        kind: 'all', limit: 20, ...(append && pageCursor ? { cursor: pageCursor } : {}),
      });
      if (requestRef.current !== requestId) return;
      setItems((current) => append
        ? [...current, ...page.items.filter((item) => !current.some(({ kind, id }) => kind === item.kind && id === item.id))]
        : page.items);
      setCursor(page.nextCursor);
      setState('ready');
    } catch (loadError) {
      if (requestRef.current !== requestId) return;
      setError(loadError instanceof Error ? loadError.message : 'Past decisions are unavailable.');
      setState('error');
    }
  }, [companyId]);

  useEffect(() => {
    requestRef.current += 1;
    setItems([]);
    setCursor(null);
    setError(null);
    setState('loading');
    void load(false);
    return () => {
      requestRef.current += 1;
    };
  }, [companyId, load]);

  return (
    <section aria-labelledby="past-decisions-heading" style={{ marginTop: 28 }}>
      <h2 id="past-decisions-heading" style={{ fontSize: 18, margin: '0 0 8px' }}>Past Decisions</h2>
      <p style={{ color: 'var(--mut)', fontSize: 13, margin: '0 0 12px' }}>
        Verified decisions and advisory historical observations are read-only records.
      </p>
      {state === 'loading' && items.length === 0 && (
        <div role="status">Loading past decisions…</div>
      )}
      {state === 'error' && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" style={buttonStyle} onClick={() => void load(false)}>
            Retry past decisions
          </button>
        </div>
      )}
      {state === 'ready' && items.length === 0 && (
        <p>No prior decisions or historical observations are available for this company.</p>
      )}
      <div style={{ display: 'grid', gap: 10 }}>
        {items.map((item) => (
          <article
            key={`${item.kind}-${item.id}`}
            id={`classification-${item.kind}-${item.id}`}
            style={{ border: '1px solid var(--bd)', borderRadius: 8, padding: 12, background: 'var(--card)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <strong>{item.kind === 'classification_case' ? 'Verified decision' : 'Advisory historical observation'}</strong>
              <span style={{ color: 'var(--mut)', fontSize: 13 }}>{item.payee}</span>
            </div>
            {item.memo && <p style={{ margin: '8px 0 0' }}>{item.memo}</p>}
            <p style={{ margin: '8px 0 0' }}>{actionSummary(item)}</p>
            {item.kind === 'classification_case' ? (
              <>
                <p style={{ margin: '8px 0 0', color: 'var(--mut)', fontSize: 13 }}>
                  Verified {fmtDate(item.verifiedAt)}
                </p>
                <p style={{ margin: '8px 0 0', fontSize: 13 }}>{item.rationale}</p>
                {item.invalidatedAt && (
                  <p style={{ margin: '8px 0 0', color: 'var(--mut)', fontSize: 13 }}>
                    Invalidated: {item.invalidationReason ?? 'No reason recorded'}
                  </p>
                )}
              </>
            ) : (
              <>
                <p style={{ margin: '8px 0 0', color: 'var(--mut)', fontSize: 13 }}>
                  Observed {fmtDate(item.observedAt)} · Source status {item.sourceStatus ?? 'unknown'}
                </p>
                <p style={{ margin: '8px 0 0', color: 'var(--mut)', fontSize: 13 }}>
                  Observed Recat revision {item.observedRecatRevision} · Observed QBO revision {item.observedQboRevision}
                </p>
                {item.supersededByCaseId && (
                  <p style={{ margin: '8px 0 0', fontSize: 13 }}>Superseded by verified decision</p>
                )}
              </>
            )}
          </article>
        ))}
      </div>
      {state === 'loading' && items.length > 0 && <div role="status">Loading past decisions…</div>}
      {state === 'ready' && cursor && (
        <button type="button" style={{ ...buttonStyle, marginTop: 12 }} onClick={() => void load(true, cursor)}>
          Load more past decisions
        </button>
      )}
    </section>
  );
}
