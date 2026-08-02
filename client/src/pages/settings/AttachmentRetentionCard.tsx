import { useEffect, useState } from 'react';
import type { AttachmentStoragePolicyDto } from '@recat/shared';
import { companies as companiesApi } from '../../lib/api';
import { useApp } from '../../state/AppContext';
import { errMsg } from './format';

const MIB = 1024n * 1024n;
const GIB = 1024n * MIB;

function formatBytes(value: string): string {
  const bytes = BigInt(value);
  if (bytes >= GIB) return `${Number((bytes * 10n) / GIB) / 10} GiB`;
  if (bytes >= MIB) return `${Number((bytes * 10n) / MIB) / 10} MiB`;
  return `${bytes.toString()} bytes`;
}

export default function AttachmentRetentionCard() {
  const { activeCompany, role, session, updateCompany, toast } = useApp();
  const [retained, setRetained] = useState(activeCompany?.retainAttachmentFiles ?? true);
  const [saving, setSaving] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [policy, setPolicy] = useState<AttachmentStoragePolicyDto | null>(null);
  const [quotaOverride, setQuotaOverride] = useState('');
  const [retentionOverride, setRetentionOverride] = useState('');
  const isAdmin = role === 'admin';
  const isInstanceAdmin = session?.isInstanceAdmin === true;
  const retentionDays = policy?.retentionDays ?? 365;

  useEffect(() => {
    setRetained(activeCompany?.retainAttachmentFiles ?? true);
  }, [activeCompany?.id, activeCompany?.retainAttachmentFiles]);

  useEffect(() => {
    if (!activeCompany) {
      setPolicy(null);
      return;
    }
    const companyId = activeCompany.id;
    let cancelled = false;
    companiesApi.attachmentStoragePolicy(companyId)
      .then((next) => {
        if (cancelled) return;
        setPolicy(next);
        setQuotaOverride(next.companyQuotaOverrideBytes ?? '');
        setRetentionOverride(next.companyRetentionOverrideDays?.toString() ?? '');
      })
      .catch(() => {
        if (!cancelled) setPolicy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompany?.id]);

  if (!activeCompany) return null;

  const change = async () => {
    if (!isAdmin || saving) return;
    const previous = retained;
    const next = !previous;
    setRetained(next);
    setSaving(true);
    try {
      await updateCompany({ retainAttachmentFiles: next });
      toast(next
        ? `Future receipt uploads will be retained in Recat for ${retentionDays} days`
        : 'Future receipt uploads will be kept in QuickBooks only');
    } catch (error) {
      setRetained(previous);
      toast(errMsg(error));
    } finally {
      setSaving(false);
    }
  };

  const savePolicy = async () => {
    if (!isInstanceAdmin || policySaving || !activeCompany) return;
    if (quotaOverride !== '' && !/^\d+$/.test(quotaOverride)) {
      toast('Company quota must be a whole number of bytes');
      return;
    }
    const parsedRetention = retentionOverride === '' ? null : Number(retentionOverride);
    if (parsedRetention !== null && !Number.isInteger(parsedRetention)) {
      toast('Retention must be a whole number of days');
      return;
    }
    setPolicySaving(true);
    try {
      await updateCompany({
        attachmentQuotaBytes: quotaOverride === '' ? null : quotaOverride,
        attachmentRetentionDays: parsedRetention,
      });
      const next = await companiesApi.attachmentStoragePolicy(activeCompany.id);
      setPolicy(next);
      setQuotaOverride(next.companyQuotaOverrideBytes ?? '');
      setRetentionOverride(next.companyRetentionOverrideDays?.toString() ?? '');
      toast('Attachment storage policy updated');
    } catch (error) {
      toast(errMsg(error));
    } finally {
      setPolicySaving(false);
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--bd2)',
        borderRadius: 10,
        background: 'var(--card)',
        padding: '20px 24px',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        alignItems: 'start',
        gap: 16,
        boxShadow: '0 1px 6px rgba(60,55,45,.05)',
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Receipt file retention</div>
        <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
          Keep an application copy for up to {retentionDays} days after upload,
          subject to a {formatBytes(policy?.companyQuotaBytes ?? '1073741824')} company quota. When
          disabled, the application copy is released after it is attached to
          QuickBooks. Changes affect future uploads only.
        </div>
        {policy && (
          <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 6 }}>
            {formatBytes(policy.companyUsageBytes)} used by this company;{' '}
            {formatBytes(policy.instanceUsageBytes)} of {formatBytes(policy.instanceQuotaBytes)} used instance-wide.
          </div>
        )}
        {!isAdmin && (
          <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 6 }}>
            Only company administrators can change this setting.
          </div>
        )}
        {isInstanceAdmin && policy && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 14, alignItems: 'end' }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
              Company quota override (bytes)
              <input
                aria-label="Company quota override in bytes"
                inputMode="numeric"
                value={quotaOverride}
                placeholder={policy.companyQuotaBytes}
                disabled={policySaving}
                onChange={(event) => setQuotaOverride(event.target.value.trim())}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
              Retention override (days)
              <input
                aria-label="Retention override in days"
                inputMode="numeric"
                value={retentionOverride}
                placeholder={policy.retentionDays.toString()}
                disabled={policySaving}
                onChange={(event) => setRetentionOverride(event.target.value.trim())}
              />
            </label>
            <button type="button" disabled={policySaving} onClick={savePolicy}>
              {policySaving ? 'Saving…' : 'Save storage policy'}
            </button>
          </div>
        )}
      </div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          aria-label="Retain receipt files"
          checked={retained}
          disabled={!isAdmin || saving}
          onChange={change}
          style={{ width: 18, height: 18, accentColor: 'var(--acc)' }}
        />
        {saving ? 'Saving…' : retained ? 'On' : 'Off'}
      </label>
    </div>
  );
}
