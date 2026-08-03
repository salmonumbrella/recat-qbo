import { useEffect, useState } from 'react';
import { useApp } from '../../state/AppContext';
import { errMsg } from './format';

export default function AttachmentRetentionCard() {
  const { activeCompany, role, updateCompany, toast } = useApp();
  const [retained, setRetained] = useState(activeCompany?.retainAttachmentFiles ?? true);
  const [saving, setSaving] = useState(false);
  const isAdmin = role === 'admin';

  useEffect(() => {
    setRetained(activeCompany?.retainAttachmentFiles ?? true);
  }, [activeCompany?.id, activeCompany?.retainAttachmentFiles]);

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
        ? 'Future receipt uploads will be retained in Recat'
        : 'Future receipt uploads will be kept in QuickBooks only');
    } catch (error) {
      setRetained(previous);
      toast(errMsg(error));
    } finally {
      setSaving(false);
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
        <div style={{ fontSize: 15, fontWeight: 600 }}>Receipt file retention</div>
        <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
          Keep an application copy after it is attached to QuickBooks. Changes affect
          future uploads only; existing receipts are not deleted or copied.
        </div>
        {!isAdmin && (
          <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 6 }}>
            Only company administrators can change this setting.
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
