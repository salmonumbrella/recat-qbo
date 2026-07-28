import { isUsableTaxCodeDto } from '@recat/shared';
import type { TaxReadinessDto } from '@recat/shared';

export default function TaxCodePicker({
  id,
  label,
  readiness,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  readiness: TaxReadinessDto | null;
  value: string | null;
  onChange: (qboId: string | null) => void;
  disabled?: boolean;
}) {
  const usableCodes = readiness?.status === 'ready'
    ? readiness.taxCodes.filter(isUsableTaxCodeDto)
    : [];
  const available = readiness?.status === 'ready';
  const explanation = readiness === null
    ? 'Tax availability is unavailable. Continue with the no-tax workflow.'
    : readiness.status === 'unsupported' && readiness.usingSalesTax === false
      ? readiness.reason ?? 'Purchase tax is disabled. Continue with the no-tax workflow.'
      : readiness.status !== 'ready'
        ? readiness.reason ?? 'Purchase tax references are unavailable. Continue with the no-tax workflow.'
        : null;

  return (
    <span style={{ display: 'block' }}>
      <label htmlFor={id} style={{ display: 'block', fontSize: 12, color: 'var(--mut)', marginBottom: 4 }}>
        {label}
      </label>
      <select
        id={id}
        value={available ? value ?? '' : ''}
        disabled={disabled || !available}
        onChange={(event) => onChange(event.target.value || null)}
        className="select"
        style={{ width: '100%' }}
      >
        <option value="">No tax</option>
        {usableCodes.map((code) => (
          <option key={code.qboId} value={code.qboId}>
            {code.name}
          </option>
        ))}
      </select>
      {explanation && (
        <span style={{ display: 'block', color: 'var(--mut)', fontSize: 12, marginTop: 4 }}>
          {explanation}
        </span>
      )}
    </span>
  );
}
