import { useState } from 'react';
import { isUsableTaxCodeDto } from '@recat/shared';
import { useApp } from '../../state/AppContext';

export default function TaxCard() {
  const {
    role,
    taxReadiness,
    taxReadinessLoading,
    refreshTaxReferences,
    toast,
  } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const isAdmin = role === 'admin';
  const usableCount =
    taxReadiness?.taxCodes.filter(isUsableTaxCodeDto).length ?? 0;
  const title = taxReadiness === null
    ? taxReadinessLoading
      ? 'Checking purchase tax…'
      : 'Purchase tax availability unavailable'
    : taxReadiness.status === 'ready'
      ? 'Purchase tax ready'
      : taxReadiness.status === 'unsupported' && taxReadiness.usingSalesTax === false
        ? 'Purchase tax disabled'
        : 'Purchase tax needs setup';

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshTaxReferences();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not refresh tax references');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--bd2)',
        borderRadius: 10,
        background: 'var(--card)',
        padding: '20px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        boxShadow: '0 1px 6px rgba(60,55,45,.05)',
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
          {taxReadiness?.status === 'ready'
            ? `${usableCount} usable purchase tax code${usableCount === 1 ? '' : 's'} available for manual categorization.`
            : taxReadiness?.reason ??
              'Recat could not load purchase tax references. The no-tax workflow remains available.'}
        </div>
        {!isAdmin && (
          <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 5 }}>
            Only company administrators can refresh tax references.
          </div>
        )}
      </div>
      {isAdmin && (
        <button
          className="btn-ghost"
          disabled={refreshing}
          onClick={() => {
            void refresh();
          }}
          style={{ opacity: refreshing ? 0.6 : 1 }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh tax references'}
        </button>
      )}
    </div>
  );
}
