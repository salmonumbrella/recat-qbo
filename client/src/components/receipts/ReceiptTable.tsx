import { Link } from 'react-router-dom';
import type { ReceiptDto } from '@recat/shared';

interface ReceiptTableProps {
  receipts: ReceiptDto[];
  selected: Set<string>;
  onSelect(id: string, selected: boolean): void;
  onSelectAll(selected: boolean): void;
}

export default function ReceiptTable({
  receipts,
  selected,
  onSelect,
  onSelectAll,
}: ReceiptTableProps) {
  const allSelected = receipts.length > 0
    && receipts.every((receipt) => selected.has(receipt.id));
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--bd2)', borderRadius: 10 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
        <thead>
          <tr style={{ textAlign: 'left', background: 'var(--hl)' }}>
            <th style={{ padding: 10 }}>
              <input
                type="checkbox"
                aria-label="Select all receipts"
                checked={allSelected}
                disabled={receipts.length === 0}
                onChange={(event) => onSelectAll(event.target.checked)}
              />
            </th>
            {['Receipt', 'Vendor', 'Date', 'Total', 'Status', 'Source'].map((label) => (
              <th key={label} style={{ padding: 10, fontSize: 13 }}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {receipts.map((receipt) => (
            <tr key={receipt.id} style={{ borderTop: '1px solid var(--bd)' }}>
              <td style={{ padding: 10 }}>
                <input
                  type="checkbox"
                  aria-label={`Select ${receipt.filename}`}
                  checked={selected.has(receipt.id)}
                  onChange={(event) => onSelect(receipt.id, event.target.checked)}
                />
              </td>
              <td style={{ padding: 10 }}>
                <Link to={`/receipts/${receipt.id}`} style={{ color: 'var(--acc)' }}>
                  {receipt.filename}
                </Link>
              </td>
              <td style={{ padding: 10 }}>
                {receipt.currentExtraction?.vendorName ?? '—'}
              </td>
              <td style={{ padding: 10 }}>
                {receipt.currentExtraction?.receiptDate ?? '—'}
              </td>
              <td style={{ padding: 10, whiteSpace: 'nowrap' }}>
                {receipt.currentExtraction?.currency
                  && receipt.currentExtraction.totalAmount
                  ? `${receipt.currentExtraction.currency} ${receipt.currentExtraction.totalAmount}`
                  : '—'}
              </td>
              <td style={{ padding: 10 }}>{receipt.status.replaceAll('_', ' ')}</td>
              <td style={{ padding: 10 }}>{receipt.sourceKind.replaceAll('_', ' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {receipts.length === 0 && (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--mut)' }}>
          No receipts match these filters.
        </div>
      )}
    </div>
  );
}
