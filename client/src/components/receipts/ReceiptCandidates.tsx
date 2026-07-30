import type { ReceiptMatchCandidateDto } from '@recat/shared';

interface ReceiptCandidatesProps {
  candidates: ReceiptMatchCandidateDto[];
  mutable: boolean;
  busy: boolean;
  onConfirm(candidate: ReceiptMatchCandidateDto): void;
}

export default function ReceiptCandidates({
  candidates,
  mutable,
  busy,
  onConfirm,
}: ReceiptCandidatesProps) {
  if (candidates.length === 0) {
    return <div style={{ color: 'var(--mut)' }}>No matching transactions found.</div>;
  }
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {candidates.map((candidate) => {
        const canConfirm = mutable
          && !busy
          && candidate.state !== 'stale'
          && (candidate.transaction.status === 'PENDING'
            || candidate.transaction.status === 'ERROR');
        return (
          <article
            key={candidate.transactionId}
            style={{
              border: '1px solid var(--bd2)',
              borderRadius: 9,
              padding: 13,
              background: candidate.state === 'confirmed' ? 'var(--hl)' : 'var(--card)',
            }}
          >
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong>#{candidate.rank} {candidate.transaction.payee || 'Unnamed transaction'}</strong>
              <span style={{ marginLeft: 'auto', fontWeight: 650 }}>
                {candidate.score} / 100
              </span>
            </div>
            <div style={{ color: 'var(--mut)', fontSize: 13, marginTop: 4 }}>
              {new Date(candidate.transaction.date).toLocaleDateString()} ·{' '}
              {candidate.transaction.amount.toLocaleString()} ·{' '}
              {candidate.transaction.status}
              {candidate.transaction.memo ? ` · ${candidate.transaction.memo}` : ''}
            </div>
            <div style={{ fontSize: 12.5, marginTop: 7 }}>
              Amount {candidate.evidence.amountPoints} · Currency{' '}
              {candidate.evidence.currencyPoints} · Date {candidate.evidence.datePoints}
              {' '}· Vendor {candidate.evidence.vendorPoints} · Payment{' '}
              {candidate.evidence.paymentPoints}
            </div>
            <div style={{ color: 'var(--mut)', fontSize: 12.5, marginTop: 3 }}>
              Difference {candidate.evidence.amountDifferenceCents}¢
              {candidate.evidence.dateDifferenceDays === null
                ? ''
                : ` · ${candidate.evidence.dateDifferenceDays} day(s)`}
              {candidate.evidence.vendorSimilarity === null
                ? ''
                : ` · vendor similarity ${Math.round(candidate.evidence.vendorSimilarity * 100)}%`}
              {' '}· {candidate.state}
            </div>
            {mutable && candidate.state !== 'confirmed' && (
              <button
                type="button"
                disabled={!canConfirm}
                onClick={() => onConfirm(candidate)}
                style={{ marginTop: 9 }}
              >
                Confirm match
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
}
