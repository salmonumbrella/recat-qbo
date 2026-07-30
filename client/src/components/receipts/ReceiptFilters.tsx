import type {
  ReceiptDocumentStatus,
  ReceiptListParams,
} from '@recat/shared';

export type ReceiptQuickFilter =
  | { label: string; statuses: ReceiptDocumentStatus[]; duplicate?: false }
  | { label: 'Duplicates'; statuses: []; duplicate: true };

export const RECEIPT_QUICK_FILTERS: ReceiptQuickFilter[] = [
  { label: 'All', statuses: [] },
  { label: 'Needs review', statuses: ['NEEDS_REVIEW'] },
  { label: 'Ready', statuses: ['READY'] },
  { label: 'Matched', statuses: ['MATCHED'] },
  { label: 'Attached', statuses: ['ATTACHED'] },
  { label: 'Processing', statuses: ['QUEUED', 'PROCESSING'] },
  { label: 'Failed', statuses: ['FAILED'] },
  { label: 'Duplicates', statuses: [], duplicate: true },
];

interface ReceiptFiltersProps {
  quickLabel: string;
  search: string;
  onQuickFilter(filter: ReceiptQuickFilter): void;
  onSearch(value: string): void;
  filters: ReceiptListParams;
  onFilters(filters: ReceiptListParams): void;
  duplicateMode?: boolean;
}

export default function ReceiptFilters({
  quickLabel,
  search,
  onQuickFilter,
  onSearch,
  filters,
  onFilters,
  duplicateMode = false,
}: ReceiptFiltersProps) {
  const update = (patch: ReceiptListParams) => onFilters({
    ...filters,
    ...patch,
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        role="group"
        aria-label="Receipt status"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
      >
        {RECEIPT_QUICK_FILTERS.map((filter) => (
          <button
            key={filter.label}
            type="button"
            aria-pressed={quickLabel === filter.label}
            onClick={() => onQuickFilter(filter)}
            style={{
              border: '1px solid var(--bd2)',
              borderRadius: 99,
              padding: '6px 11px',
              background: quickLabel === filter.label ? 'var(--acc)' : 'var(--card)',
              color: quickLabel === filter.label ? '#fff' : 'var(--ink)',
              cursor: 'pointer',
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <input
        aria-label="Search receipts"
        type="search"
        value={search}
        disabled={duplicateMode}
        onChange={(event) => onSearch(event.target.value)}
        placeholder="Search vendor, filename, amount, or receipt ID"
        style={{
          width: 'min(100%, 480px)',
          border: '1px solid var(--bd2)',
          borderRadius: 8,
          padding: '9px 11px',
          background: 'var(--sur)',
          color: 'var(--ink)',
        }}
      />
      {!duplicateMode && <details>
        <summary>More filters</summary>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))',
          gap: 10,
          marginTop: 10,
        }}>
          <label>
            From
            <input
              aria-label="Receipt date from"
              type="date"
              value={filters.dateFrom ?? ''}
              onChange={(event) => update({ dateFrom: event.target.value || undefined })}
            />
          </label>
          <label>
            To
            <input
              aria-label="Receipt date to"
              type="date"
              value={filters.dateTo ?? ''}
              onChange={(event) => update({ dateTo: event.target.value || undefined })}
            />
          </label>
          <label>
            Document type
            <input
              aria-label="Document type filter"
              value={filters.documentTypes?.[0] ?? ''}
              onChange={(event) => update({
                documentTypes: event.target.value.trim()
                  ? [event.target.value]
                  : undefined,
              })}
            />
          </label>
          <label>
            Source
            <select
              aria-label="Receipt source filter"
              value={filters.sourceKinds?.[0] ?? ''}
              onChange={(event) => update({
                sourceKinds: event.target.value
                  ? [event.target.value as NonNullable<ReceiptListParams['sourceKinds']>[number]]
                  : undefined,
              })}
            >
              <option value="">All sources</option>
              <option value="WEB_UPLOAD">Web upload</option>
              <option value="API_UPLOAD">API upload</option>
              <option value="MCP_UPLOAD">MCP upload</option>
            </select>
          </label>
          <label>
            Match state
            <select
              aria-label="Receipt match filter"
              value={filters.matched === undefined
                ? ''
                : filters.matched ? 'matched' : 'unmatched'}
              onChange={(event) => update({
                matched: event.target.value === ''
                  ? undefined
                  : event.target.value === 'matched',
              })}
            >
              <option value="">All</option>
              <option value="matched">Matched</option>
              <option value="unmatched">Unmatched</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <input
              type="checkbox"
              checked={filters.missingInfo ?? false}
              onChange={(event) => update({ missingInfo: event.target.checked })}
            />
            Missing information
          </label>
        </div>
      </details>}
    </div>
  );
}
