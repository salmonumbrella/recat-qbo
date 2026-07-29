import { isUsableSalesTaxCodeDto, isUsableTaxCodeDto } from '@recat/shared';
import type { TaxReadinessDto } from '@recat/shared';

export type TaxDirection = 'purchase' | 'sales';

export function usableTaxCodesForDirection(
  readiness: TaxReadinessDto | null,
  direction: TaxDirection,
) {
  const isSales = direction === 'sales';
  const status = isSales ? readiness?.salesStatus : readiness?.status;
  const taxCodes = isSales ? readiness?.salesTaxCodes : readiness?.taxCodes;
  return status === 'ready'
    ? (taxCodes ?? []).filter(
        (code) =>
          code.taxable === true &&
          (isSales ? isUsableSalesTaxCodeDto(code) : isUsableTaxCodeDto(code)),
      )
    : [];
}

export function isUsableTaxCodeForDirection(
  readiness: TaxReadinessDto | null,
  direction: TaxDirection,
  qboId: string,
): boolean {
  return usableTaxCodesForDirection(readiness, direction).some((code) => code.qboId === qboId);
}

export default function TaxCodePicker({
  id,
  label,
  readiness,
  value,
  onChange,
  disabled = false,
  direction = 'purchase',
}: {
  id: string;
  label: string;
  readiness: TaxReadinessDto | null;
  value: string | null;
  onChange: (qboId: string | null) => void;
  disabled?: boolean;
  direction?: TaxDirection;
}) {
  const isSales = direction === 'sales';
  const status = isSales ? readiness?.salesStatus : readiness?.status;
  const reason = isSales ? readiness?.salesReason : readiness?.reason;
  const taxLabel = isSales ? 'Sales tax' : 'Purchase tax';
  const usableCodes = usableTaxCodesForDirection(readiness, direction);
  const available = status === 'ready';
  const explanation = readiness === null
    ? 'Tax availability is unavailable. Continue with the no-tax workflow.'
    : status === 'unsupported' && readiness.usingSalesTax === false
      ? reason ?? `${taxLabel} is disabled. Continue with the no-tax workflow.`
      : status !== 'ready'
        ? reason ?? `${taxLabel} references are unavailable. Continue with the no-tax workflow.`
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
