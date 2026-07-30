import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ReceiptDetailDto,
  ReceiptEditablePatch,
  ReceiptExtractionDto,
} from '@recat/shared';
import { ApiError, receipts } from '../../lib/api';

interface ReceiptMetadataFormProps {
  companyId: string;
  receipt: ReceiptDetailDto;
  mutable: boolean;
  busy: boolean;
  onSaved(receipt: ReceiptDetailDto): void;
  onReload(): Promise<ReceiptDetailDto | null>;
  onBusy(busy: boolean): void;
}

const scalarFields: Array<{
  key: keyof ReceiptEditablePatch;
  label: string;
  type?: 'date' | 'text';
}> = [
  { key: 'receiptDate', label: 'Receipt date', type: 'date' },
  { key: 'documentTitle', label: 'Document title' },
  { key: 'vendorName', label: 'Vendor name' },
  { key: 'vendorTaxId', label: 'Vendor tax ID' },
  { key: 'vendorReceiptId', label: 'Vendor receipt ID' },
  { key: 'clientName', label: 'Client name' },
  { key: 'clientTaxId', label: 'Client tax ID' },
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'taxAmount', label: 'Tax amount' },
  { key: 'totalAmount', label: 'Total amount' },
  { key: 'currency', label: 'Currency' },
  { key: 'paymentMethod', label: 'Payment method' },
  { key: 'paymentIdentifier', label: 'Payment identifier' },
  { key: 'language', label: 'Language' },
  { key: 'documentType', label: 'Document type' },
  { key: 'category', label: 'Category' },
];

interface Draft {
  values: Record<string, string>;
  approved: boolean;
  lineItems: string;
  taxComponents: string;
  additionalFields: string;
}

function draftFrom(receipt: ReceiptDetailDto): Draft {
  const extraction = receipt.currentExtraction;
  const values: Record<string, string> = {
    description: extraction?.description ?? '',
    userNotes: receipt.userNotes ?? '',
  };
  for (const field of scalarFields) {
    const value = extraction?.[field.key as keyof ReceiptExtractionDto];
    values[field.key] = typeof value === 'string' ? value : '';
  }
  return {
    values,
    approved: receipt.approved,
    lineItems: JSON.stringify(extraction?.lineItems ?? [], null, 2),
    taxComponents: JSON.stringify(extraction?.taxComponents ?? [], null, 2),
    additionalFields: JSON.stringify(extraction?.additionalFields ?? [], null, 2),
  };
}

function parseJsonArray(value: string, label: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array.`);
  return parsed;
}

function rebaseDraft(current: Draft, previous: Draft, next: Draft): Draft {
  const values = { ...current.values };
  for (const [key, value] of Object.entries(next.values)) {
    if (current.values[key] === previous.values[key]) values[key] = value;
  }
  return {
    values,
    approved: current.approved === previous.approved
      ? next.approved
      : current.approved,
    lineItems: current.lineItems === previous.lineItems
      ? next.lineItems
      : current.lineItems,
    taxComponents: current.taxComponents === previous.taxComponents
      ? next.taxComponents
      : current.taxComponents,
    additionalFields: current.additionalFields === previous.additionalFields
      ? next.additionalFields
      : current.additionalFields,
  };
}

export default function ReceiptMetadataForm({
  companyId,
  receipt,
  mutable,
  busy,
  onSaved,
  onReload,
  onBusy,
}: ReceiptMetadataFormProps) {
  const [draft, setDraft] = useState(() => draftFrom(receipt));
  const [base, setBase] = useState(() => draftFrom(receipt));
  const baseRef = useRef(base);
  const receiptIdRef = useRef(receipt.id);
  const [baseRevision, setBaseRevision] = useState(receipt.revision);
  const [message, setMessage] = useState<string | null>(null);
  const [staleConflict, setStaleConflict] = useState(false);

  useEffect(() => {
    const next = draftFrom(receipt);
    if (receiptIdRef.current === receipt.id) {
      setDraft((current) => rebaseDraft(current, baseRef.current, next));
    } else {
      receiptIdRef.current = receipt.id;
      setDraft(next);
      setMessage(null);
      setStaleConflict(false);
    }
    baseRef.current = next;
    setBase(next);
    setBaseRevision(receipt.revision);
  }, [receipt.id, receipt.revision]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(base),
    [base, draft],
  );

  const setValue = (key: string, value: string) => {
    setDraft((current) => ({
      ...current,
      values: { ...current.values, [key]: value },
    }));
  };

  const save = async () => {
    const patch: ReceiptEditablePatch = {};
    for (const field of [...scalarFields, { key: 'description', label: '' }, {
      key: 'userNotes',
      label: '',
    }]) {
      const key = field.key as keyof ReceiptEditablePatch;
      if (draft.values[key] !== base.values[key]) {
        Object.assign(patch, { [key]: draft.values[key] === '' ? null : draft.values[key] });
      }
    }
    try {
      for (const key of ['subtotal', 'taxAmount', 'totalAmount'] as const) {
        const value = draft.values[key];
        if (value && !/^-?\d{1,14}(?:\.\d{1,4})?$/u.test(value)) {
          const label = scalarFields.find((field) => field.key === key)?.label;
          throw new Error(`${label ?? key} is invalid.`);
        }
      }
      const date = draft.values.receiptDate;
      if (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
        throw new Error('Receipt date is invalid.');
      }
      if (draft.lineItems !== base.lineItems) {
        patch.lineItems = parseJsonArray(draft.lineItems, 'Line items') as never;
      }
      if (draft.taxComponents !== base.taxComponents) {
        patch.taxComponents = parseJsonArray(
          draft.taxComponents,
          'Tax components',
        ) as never;
      }
      if (draft.additionalFields !== base.additionalFields) {
        patch.additionalFields = parseJsonArray(
          draft.additionalFields,
          'Additional fields',
        ) as never;
      }
      if (draft.approved !== base.approved) patch.approved = draft.approved;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Invalid structured fields.');
      return;
    }
    onBusy(true);
    setMessage(null);
    try {
      const updated = await receipts.patch(companyId, receipt.id, {
        expectedRevision: baseRevision,
        patch,
      });
      const next = draftFrom(updated);
      setDraft(next);
      baseRef.current = next;
      setBase(next);
      setBaseRevision(updated.revision);
      onSaved(updated);
      setStaleConflict(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RECEIPT_STALE') {
        const latest = await onReload();
        if (latest) setBaseRevision(latest.revision);
        setStaleConflict(true);
        setMessage('This receipt changed. Your edits are preserved; review and save again.');
      } else {
        setMessage(error instanceof Error ? error.message : 'Could not save receipt.');
      }
    } finally {
      onBusy(false);
    }
  };

  const inputStyle = {
    width: '100%',
    boxSizing: 'border-box' as const,
    border: '1px solid var(--bd2)',
    borderRadius: 7,
    padding: '8px 9px',
    background: 'var(--sur)',
    color: 'var(--ink)',
  };
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (dirty) void save();
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 10 }}>
        {scalarFields.map((field) => (
          <label key={field.key} style={{ fontSize: 13 }}>
            {field.label}
            <input
              aria-label={field.label}
              type={field.type ?? 'text'}
              value={draft.values[field.key] ?? ''}
              disabled={!mutable || busy}
              pattern={field.key === 'currency' ? '[A-Z]{3}' : undefined}
              onChange={(event) => setValue(field.key, event.target.value)}
              style={inputStyle}
            />
          </label>
        ))}
      </div>
      <label style={{ display: 'block', marginTop: 10, fontSize: 13 }}>
        Description
        <textarea
          aria-label="Description"
          value={draft.values.description ?? ''}
          disabled={!mutable || busy}
          onChange={(event) => setValue('description', event.target.value)}
          rows={3}
          style={inputStyle}
        />
      </label>
      <label style={{ display: 'block', marginTop: 10, fontSize: 13 }}>
        Notes
        <textarea
          aria-label="Notes"
          value={draft.values.userNotes ?? ''}
          disabled={!mutable || busy}
          onChange={(event) => setValue('userNotes', event.target.value)}
          rows={3}
          style={inputStyle}
        />
      </label>
      {([
        ['Line items', 'lineItems'],
        ['Tax components', 'taxComponents'],
        ['Additional fields', 'additionalFields'],
      ] as const).map(([label, key]) => (
        <label key={key} style={{ display: 'block', marginTop: 10, fontSize: 13 }}>
          {label} (JSON)
          <textarea
            aria-label={label}
            value={draft[key]}
            disabled={!mutable || busy}
            onChange={(event) => setDraft((current) => ({
              ...current,
              [key]: event.target.value,
            }))}
            rows={4}
            spellCheck={false}
            style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12 }}
          />
        </label>
      ))}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <input
          type="checkbox"
          checked={draft.approved}
          disabled={!mutable || busy}
          onChange={(event) => setDraft((current) => ({
            ...current,
            approved: event.target.checked,
          }))}
        />
        Approved
      </label>
      {receipt.currentExtraction && (
        <details style={{ marginTop: 12 }}>
          <summary>Raw extracted text</summary>
          <textarea
            aria-label="Raw extracted text"
            readOnly
            value={receipt.currentExtraction.rawExtractedText ?? ''}
            rows={8}
            style={{ ...inputStyle, marginTop: 7 }}
          />
        </details>
      )}
      {message && <div role="alert" style={{ marginTop: 10, color: 'var(--red)' }}>{message}</div>}
      {staleConflict && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const latest = baseRef.current;
            setDraft(latest);
            setBase(latest);
            setBaseRevision(receipt.revision);
            setStaleConflict(false);
            setMessage(null);
          }}
          style={{ marginTop: 10, marginRight: 8 }}
        >
          Discard local edits
        </button>
      )}
      {mutable && (
        <button type="submit" disabled={!dirty || busy} style={{ marginTop: 12 }}>
          Save changes
        </button>
      )}
    </form>
  );
}
