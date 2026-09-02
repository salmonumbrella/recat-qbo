import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuleAffectedTransactionDto, RuleAffectedTransactionFilter } from '@recat/shared';
import { rules } from '../../lib/api';
import { fmtDate, fmtMoney } from '../../lib/format';

const buttonStyle = {
  border: '1px solid var(--bd)', background: 'var(--card)', color: 'var(--ink)',
  borderRadius: 7, padding: '7px 10px', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit',
} as const;

const filters: RuleAffectedTransactionFilter[] = ['all', 'pending', 'posted'];

function filterLabel(filter: RuleAffectedTransactionFilter): string {
  return filter.slice(0, 1).toUpperCase() + filter.slice(1);
}

export default function RuleAffectedTransactionsSection({
  companyId,
  ruleId,
}: {
  companyId: string;
  ruleId: string;
}) {
  const [status, setStatus] = useState<RuleAffectedTransactionFilter>('all');
  const [opened, setOpened] = useState(false);
  const requestRef = useRef(0);
  const [items, setItems] = useState<RuleAffectedTransactionDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState({ matchedCount: 0, pendingCount: 0, postedCount: 0 });
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (
    append: boolean,
    nextStatus: RuleAffectedTransactionFilter,
    pageCursor?: string,
  ) => {
    const requestId = ++requestRef.current;
    setState('loading');
    setError(null);
    try {
      const page = await rules.affectedTransactions(companyId, ruleId, {
        status: nextStatus, limit: 20, ...(append && pageCursor ? { cursor: pageCursor } : {}),
      });
      if (requestRef.current !== requestId) return;
      setItems((current) => append
        ? [...current, ...page.items.filter((item) => !current.some(({ transactionId }) => transactionId === item.transactionId))]
        : page.items);
      setCursor(page.nextCursor);
      setCounts({
        matchedCount: page.matchedCount,
        pendingCount: page.pendingCount,
        postedCount: page.postedCount,
      });
      setState('ready');
    } catch (loadError) {
      if (requestRef.current !== requestId) return;
      setError(loadError instanceof Error ? loadError.message : 'Affected transactions are unavailable.');
      setState('error');
    }
  }, [companyId, ruleId]);

  useEffect(() => {
    requestRef.current += 1;
    setStatus('all');
    setOpened(false);
    setItems([]);
    setCursor(null);
    setCounts({ matchedCount: 0, pendingCount: 0, postedCount: 0 });
    setState('idle');
    setError(null);
    return () => {
      requestRef.current += 1;
    };
  }, [companyId, ruleId]);

  const open = () => {
    setOpened(true);
    void load(false, status);
  };

  const chooseFilter = (nextStatus: RuleAffectedTransactionFilter) => {
    setStatus(nextStatus);
    setItems([]);
    setCursor(null);
    void load(false, nextStatus);
  };

  return (
    <section aria-label="Affected transactions" style={{ marginTop: 14 }}>
      {!opened ? (
        <button type="button" style={buttonStyle} onClick={open}>View affected transactions</button>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>{counts.matchedCount} matched · {counts.pendingCount} pending · {counts.postedCount} posted</strong>
            {filters.map((filter) => (
              <button
                key={filter}
                type="button"
                style={buttonStyle}
                aria-pressed={status === filter}
                onClick={() => chooseFilter(filter)}
              >
                {filterLabel(filter)}
              </button>
            ))}
          </div>
          {state === 'loading' && items.length === 0 && <div role="status">Loading affected transactions…</div>}
          {state === 'error' && (
            <div role="alert">
              <p>{error}</p>
              <button type="button" style={buttonStyle} onClick={() => void load(false, status)}>
                Retry affected transactions
              </button>
            </div>
          )}
          {state === 'ready' && items.length === 0 && <p>No affected transactions match this filter.</p>}
          <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
            {items.map((item) => (
              <article
                key={item.transactionId}
                style={{ border: '1px solid var(--bd)', borderRadius: 8, padding: 10, background: 'var(--card)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <span>{fmtDate(item.date)} · {item.payee}</span>
                  <strong>{fmtMoney(item.amountCents / 100)}</strong>
                </div>
                {item.memo && <p style={{ margin: '7px 0 0', color: 'var(--mut)', fontSize: 13 }}>{item.memo}</p>}
                <p style={{ margin: '7px 0 0', color: 'var(--mut)', fontSize: 13 }}>{item.status}</p>
                {!item.ruleWins && item.winningRuleId !== null && <p style={{ margin: '7px 0 0', fontSize: 13 }}>Another enabled rule currently wins</p>}
              </article>
            ))}
          </div>
          {state === 'loading' && items.length > 0 && <div role="status">Loading affected transactions…</div>}
          {state === 'ready' && cursor && (
            <button type="button" style={{ ...buttonStyle, marginTop: 12 }} onClick={() => void load(true, status, cursor)}>
              Load more affected transactions
            </button>
          )}
        </>
      )}
    </section>
  );
}
