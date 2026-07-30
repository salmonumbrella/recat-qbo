import { useEffect, useRef, useState } from 'react';
import type { ReceiptCompanySettingsDto } from '@recat/shared';
import { receipts } from '../../lib/api';
import { useApp } from '../../state/AppContext';

interface ReceiptProcessingCardProps {
  companyId: string;
}

type SettingsPatch = Partial<Omit<ReceiptCompanySettingsDto, 'configVersion'>>;

export default function ReceiptProcessingCard({
  companyId,
}: ReceiptProcessingCardProps) {
  const { toast } = useApp();
  const [settings, setSettings] = useState<ReceiptCompanySettingsDto | null>(null);
  const [draft, setDraft] = useState<ReceiptCompanySettingsDto | null>(null);
  const [saving, setSaving] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    const sequence = ++request.current;
    setSettings(null);
    setDraft(null);
    receipts.settings.get(companyId)
      .then((result) => {
        if (request.current !== sequence) return;
        setSettings(result);
        setDraft(result);
      })
      .catch((error: unknown) => {
        if (request.current === sequence) {
          toast(error instanceof Error
            ? error.message
            : 'Could not load receipt processing settings');
        }
      });
    return () => {
      request.current += 1;
    };
  }, [companyId, toast]);

  const save = async (patch: SettingsPatch) => {
    if (!settings || !draft || saving) return;
    const previous = settings;
    setSaving(true);
    try {
      const updated = await receipts.settings.patch(companyId, patch);
      setSettings(updated);
      setDraft(updated);
      toast('Receipt processing settings saved');
    } catch (error) {
      setSettings(previous);
      setDraft(previous);
      toast(error instanceof Error ? error.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  if (!draft) {
    return (
      <section style={{ border: '1px solid var(--bd2)', borderRadius: 10, padding: 20 }}>
        Loading receipt processing settings…
      </section>
    );
  }

  const numeric = [
    {
      key: 'confidenceThreshold',
      label: 'Confidence threshold',
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      key: 'autoMatchThreshold',
      label: 'Auto-match threshold',
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: 'autoMatchMargin',
      label: 'Auto-match margin',
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: 'maxPages',
      label: 'Maximum pages',
      min: 1,
      max: 50,
      step: 1,
    },
  ] as const;
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
    <section style={{
      border: '1px solid var(--bd2)',
      borderRadius: 10,
      background: 'var(--card)',
      padding: '20px 24px',
      boxShadow: '0 1px 6px rgba(60,55,45,.05)',
    }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>Receipt processing</div>
      <p style={{ fontSize: 13.5, color: 'var(--mut)', lineHeight: 1.5 }}>
        Extract receipt metadata and propose transaction matches. Provider
        credentials come from instance AI settings and are never stored per company.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 13 }}>
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={saving}
          onChange={(event) => {
            const enabled = event.target.checked;
            setDraft((current) => current ? { ...current, enabled } : current);
            void save({ enabled });
          }}
        />
        Enable receipt processing
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12 }}>
        <label style={{ fontSize: 13 }}>
          Provider
          <select
            aria-label="Receipt provider"
            value={draft.provider}
            disabled={saving}
            onChange={(event) => {
              const provider = event.target.value as ReceiptCompanySettingsDto['provider'];
              setDraft((current) => current ? { ...current, provider } : current);
              void save({ provider });
            }}
            style={inputStyle}
          >
            <option value="openrouter">OpenRouter</option>
            <option value="custom">Custom OpenAI-compatible</option>
          </select>
        </label>
        <label style={{ fontSize: 13 }}>
          Vision model
          <input
            aria-label="Vision model"
            value={draft.model}
            disabled={saving}
            onChange={(event) => {
              const model = event.target.value;
              setDraft((current) => current ? { ...current, model } : current);
            }}
            onBlur={() => {
              if (draft.model !== settings?.model && draft.model.trim()) {
                void save({ model: draft.model.trim() });
              } else if (!draft.model.trim() && settings) {
                setDraft((current) => current
                  ? { ...current, model: settings.model }
                  : current);
              }
            }}
            style={inputStyle}
          />
        </label>
        {numeric.map((field) => (
          <label key={field.key} style={{ fontSize: 13 }}>
            {field.label}
            <input
              aria-label={field.label}
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              value={Number.isNaN(draft[field.key]) ? '' : draft[field.key]}
              disabled={saving}
              onChange={(event) => {
                const value = event.target.value === ''
                  ? Number.NaN
                  : Number(event.target.value);
                setDraft((current) => current
                  ? { ...current, [field.key]: value }
                  : current);
              }}
              onBlur={() => {
                const value = draft[field.key];
                const integerRequired = field.key !== 'confidenceThreshold';
                if (
                  !Number.isFinite(value)
                  || value < field.min
                  || value > field.max
                  || (integerRequired && !Number.isInteger(value))
                ) {
                  setDraft(settings);
                  return;
                }
                if (value !== settings?.[field.key]) {
                  void save({ [field.key]: value });
                }
              }}
              style={inputStyle}
            />
          </label>
        ))}
      </div>
      {saving && <div aria-live="polite" style={{ fontSize: 12.5, marginTop: 8 }}>Saving…</div>}
    </section>
  );
}
