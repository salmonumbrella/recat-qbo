import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ClassificationSearchHit, ClassificationSearchMode } from '@recat/shared';
import {
  classificationMemory,
  type ClassificationSearchPageDto,
  type ClassificationSemanticHealthDto,
} from '../lib/api';

interface ClassificationMemoryPanelProps {
  companyId: string;
  initialQuery?: string;
  transactionId?: string;
  title?: string;
  autoSearch?: boolean;
}

function readable(value: string): string {
  return value.replaceAll('_', ' ');
}

function sourceLabel(hit: ClassificationSearchHit): string {
  if (hit.kind === 'classification_case') return 'case';
  if (hit.kind === 'rule_candidate') return 'candidate';
  if (hit.kind === 'rule') return 'rule';
  return 'knowledge record';
}

function sourceHref(hit: ClassificationSearchHit): string {
  const query = new URLSearchParams({ source: hit.kind, sourceId: hit.sourceId });
  return `/rules?${query.toString()}`;
}

function verifiedLabel(value: string | null): string {
  if (value === null) return 'Not independently verified';
  return `Verified ${new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(value))}`;
}

function searchState(result: ClassificationSearchPageDto): string {
  const mode = `${readable(result.mode)} results`;
  if (!result.degraded) return mode;
  return `${mode} · Degraded: ${readable(result.degradedReason ?? 'semantic unavailable')}`;
}

function BackfillState({ health }: { health: ClassificationSemanticHealthDto | null }) {
  if (health === null) return null;
  if (!health.configured) return <span>Semantic search not configured</span>;
  if (!health.vectorAvailable) return <span>Semantic index unavailable</span>;
  if (health.backlog > 0 || health.expectedState === 'building') {
    return (
      <span>
        Semantic backfill · {health.backlog} remaining · {Math.round(health.progress * 100)}%
      </span>
    );
  }
  return <span>Semantic index ready</span>;
}

export default function ClassificationMemoryPanel({
  companyId,
  initialQuery = '',
  transactionId,
  title = 'Classification knowledge',
  autoSearch = false,
}: ClassificationMemoryPanelProps) {
  const [query, setQuery] = useState(initialQuery);
  const [mode, setMode] = useState<ClassificationSearchMode>('hybrid');
  const [result, setResult] = useState<ClassificationSearchPageDto | null>(null);
  const [health, setHealth] = useState<ClassificationSemanticHealthDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => setQuery(initialQuery), [initialQuery]);

  useEffect(() => {
    requestRef.current += 1;
    setResult(null);
    setHealth(null);
    setError(null);
    setBusy(false);
  }, [companyId, transactionId]);

  const search = useCallback(async (overrideQuery?: string) => {
    const requestedQuery = (overrideQuery ?? query).trim();
    if (!requestedQuery) return;
    const requestId = ++requestRef.current;
    setBusy(true);
    setError(null);
    setResult(null);
    const [searchOutcome, healthOutcome] = await Promise.allSettled([
      classificationMemory.search(companyId, {
        query: requestedQuery,
        mode,
        scope: 'current_company',
        ...(transactionId === undefined ? {} : { transactionId }),
        limit: 20,
      }),
      classificationMemory.health(companyId),
    ]);
    if (requestRef.current !== requestId) return;
    if (healthOutcome.status === 'fulfilled') setHealth(healthOutcome.value);
    else setHealth(null);
    if (searchOutcome.status === 'fulfilled') setResult(searchOutcome.value);
    else setError(searchOutcome.reason instanceof Error
      ? searchOutcome.reason.message
      : 'Classification search is unavailable.');
    setBusy(false);
  }, [companyId, mode, query, transactionId]);

  useEffect(() => {
    if (!autoSearch || !initialQuery.trim()) return;
    void search(initialQuery);
    // Search once for each transaction/query identity. Mode changes remain an
    // explicit user action so we never issue a semantic request implicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSearch, companyId, initialQuery, transactionId]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void search();
  };

  return (
    <section aria-label={title} style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 650, marginBottom: 8 }}>{title}</div>
      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ flex: '1 1 220px' }}>
          <span className="sr-only">Classification search</span>
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search vendors, rationale, categories…"
            maxLength={256}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </label>
        <label>
          <span className="sr-only">Search mode</span>
          <select
            aria-label="Search mode"
            className="select"
            value={mode}
            onChange={(event) => setMode(event.target.value as ClassificationSearchMode)}
          >
            <option value="exact">Exact</option>
            <option value="lexical">Lexical</option>
            <option value="hybrid">Hybrid</option>
            <option value="semantic">Semantic</option>
          </select>
        </label>
        <button className="btn-ghost" type="submit" disabled={busy || !query.trim()}>
          {busy ? 'Searching…' : 'Search knowledge'}
        </button>
      </form>
      {(result !== null || health !== null) && (
        <div role="status" style={{ fontSize: 12.5, color: 'var(--mut)', marginTop: 8 }}>
          {result && <span>{searchState(result)}</span>}
          {result && health && <span> · </span>}
          <BackfillState health={health} />
        </div>
      )}
      {error && <div role="alert" style={{ color: 'var(--erT)', marginTop: 10 }}>{error}</div>}
      {result?.noMatch && !error && (
        <div style={{ color: 'var(--mut)', marginTop: 12 }}>Nothing matched this classification context.</div>
      )}
      {result && !result.noMatch && (
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          {result.items.slice(0, 20).map((hit) => {
            const summary = hit.actionSummary;
            return (
              <article
                key={hit.id}
                id={`classification-${hit.kind}-${hit.sourceId}`}
                style={{ border: '1px solid var(--bd2)', borderRadius: 9, padding: 13 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <strong>{hit.vendorName ?? readable(hit.kind)}</strong>
                    <div style={{ color: 'var(--mut)', fontSize: 12.5 }}>{hit.companyName}</div>
                  </div>
                  <span className={hit.executable ? 'pill-ok' : 'pill-am'}>
                    {hit.executable ? 'Executable' : 'Advisory'}
                  </span>
                </div>
                <div style={{ marginTop: 7, fontSize: 13.5 }}>
                  {summary
                    ? `${summary.categoryName} · ${readable(summary.taxCalculation)}${summary.taxCodeName ? ` · ${summary.taxCodeName}` : ''}`
                    : 'No executable category or tax action'}
                </div>
                <div style={{ color: 'var(--mut)', fontSize: 12.5, marginTop: 5 }}>
                  Matched in {hit.matchedIn.map(readable).join(' · ')} · {hit.evidenceCount} verified evidence · {hit.conflictingEvidenceCount} conflict
                  {hit.conflictingEvidenceCount === 1 ? '' : 's'} · {verifiedLabel(hit.verifiedAt)}
                </div>
                {hit.rationale && <p style={{ margin: '8px 0 0', fontSize: 13.5 }}>{hit.rationale}</p>}
                {hit.conflicts.slice(0, 10).map((conflict) => (
                  <div key={conflict.id} role="alert" style={{ color: 'var(--amT)', fontSize: 12.5, marginTop: 6 }}>
                    {conflict.reason}
                  </div>
                ))}
                <a href={sourceHref(hit)} style={{ display: 'inline-block', marginTop: 8, fontSize: 12.5 }}>
                  Open source {sourceLabel(hit)}
                </a>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
