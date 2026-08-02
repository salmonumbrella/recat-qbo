import { beforeEach, describe, expect, it } from 'vitest';
import {
  getReceiptSettings,
  resolveReceiptProvider,
  updateReceiptSettings,
  type ReceiptCompanyConfigRow,
  type ReceiptSettingsDeps,
} from './settings.js';

const configuredInstance = {
  aiEndpoint: 'https://provider.example.invalid/v1',
  aiApiKey: 'custom-private-key',
  openrouterApiKey: 'router-private-key',
  openrouterReferer: 'https://recat.example.invalid',
  openrouterTitle: 'Recat',
};

function createDeps(): ReceiptSettingsDeps & {
  rows: Map<string, ReceiptCompanyConfigRow>;
} {
  const rows = new Map<string, ReceiptCompanyConfigRow>();
  const db: ReceiptSettingsDeps['db'] = {
    receiptCompanyConfig: {
      findUnique: async ({ where }) => rows.get(where.companyId) ?? null,
      upsert: async ({ where, create, update }) => {
        const next = rows.has(where.companyId)
          ? { ...rows.get(where.companyId)!, ...update }
          : create;
        rows.set(where.companyId, next);
        return next;
      },
    },
  };
  return {
    rows,
    db,
    getInstanceSettings: async () => configuredInstance,
    withSerializableTransaction: async (callback) => callback(db),
  };
}

describe('receipt processing settings', () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    deps = createDeps();
  });

  it('defaults to disabled OpenRouter vision extraction without secrets', async () => {
    const settings = await getReceiptSettings('company-1', deps);

    expect(settings).toMatchObject({
      enabled: false,
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      confidenceThreshold: 0.8,
      autoMatchThreshold: 85,
      autoMatchMargin: 15,
      maxPages: 20,
    });
    expect(settings).not.toHaveProperty('apiKey');
    expect(JSON.stringify(settings)).not.toContain('private-key');
    expect(deps.rows).toHaveLength(0);
  });

  it('preserves an existing explicit opt-in', async () => {
    deps.rows.set('company-1', {
      companyId: 'company-1',
      enabled: true,
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      confidenceThreshold: 0.8,
      autoMatchThreshold: 85,
      autoMatchMargin: 15,
      maxPages: 20,
      configVersion: 'b'.repeat(64),
    });

    await expect(getReceiptSettings('company-1', deps)).resolves.toMatchObject({
      enabled: true,
      configVersion: 'b'.repeat(64),
    });
  });

  it('requires the selected provider credentials before enabling', async () => {
    const unavailable: ReceiptSettingsDeps = {
      ...deps,
      getInstanceSettings: async () => ({
        ...configuredInstance,
        openrouterApiKey: '',
      }),
    };

    await expect(updateReceiptSettings(
      'company-1',
      { enabled: true, provider: 'openrouter' },
      unavailable,
    )).rejects.toMatchObject({ code: 'RECEIPT_SETTING_INVALID' });
    expect(deps.rows).toHaveLength(0);
  });

  it('can remain disabled without resolving unavailable credentials', async () => {
    const unavailable: ReceiptSettingsDeps = {
      ...deps,
      getInstanceSettings: async () => ({
        ...configuredInstance,
        openrouterApiKey: '',
      }),
    };
    await updateReceiptSettings(
      'company-1',
      { enabled: false },
      unavailable,
    );
    await expect(resolveReceiptProvider(
      'company-1',
      unavailable,
    )).resolves.toMatchObject({
      settings: { enabled: false },
      apiBase: '',
      apiKey: '',
      headers: {},
    });
  });

  it('requires both a custom endpoint and key', async () => {
    const unavailable: ReceiptSettingsDeps = {
      ...deps,
      getInstanceSettings: async () => ({
        ...configuredInstance,
        aiApiKey: '',
      }),
    };

    await expect(updateReceiptSettings(
      'company-1',
      { enabled: true, provider: 'custom' },
      unavailable,
    )).rejects.toMatchObject({ code: 'RECEIPT_SETTING_INVALID' });
  });

  it('changes configVersion when model policy changes', async () => {
    const before = await getReceiptSettings('company-1', deps);
    const unchanged = await updateReceiptSettings(
      'company-1',
      { autoMatchThreshold: 85 },
      deps,
    );
    const after = await updateReceiptSettings(
      'company-1',
      { autoMatchThreshold: 90 },
      deps,
    );

    expect(unchanged.configVersion).toBe(before.configVersion);
    expect(after.configVersion).not.toBe(before.configVersion);
  });

  it('rejects unknown fields and out-of-range values without writing', async () => {
    await expect(updateReceiptSettings(
      'company-1',
      { maxPages: 51, apiKey: 'must-not-be-accepted' } as never,
      deps,
    )).rejects.toMatchObject({ code: 'RECEIPT_SETTING_INVALID' });
    expect(deps.rows).toHaveLength(0);
  });

  it('resolves provider secrets only through the server-internal boundary', async () => {
    await updateReceiptSettings('company-1', { enabled: true }, deps);
    const openrouter = await resolveReceiptProvider('company-1', deps);
    expect(openrouter).toEqual({
      settings: await getReceiptSettings('company-1', deps),
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'router-private-key',
      headers: {
        'HTTP-Referer': 'https://recat.example.invalid',
        'X-Title': 'Recat',
      },
    });

    await updateReceiptSettings(
      'company-1',
      { enabled: true, provider: 'custom' },
      deps,
    );
    await expect(resolveReceiptProvider('company-1', deps)).resolves.toMatchObject({
      apiBase: 'https://provider.example.invalid/v1',
      apiKey: 'custom-private-key',
      headers: {},
    });
  });

  it('isolates persisted settings by company', async () => {
    await updateReceiptSettings('company-1', { maxPages: 5 }, deps);
    await updateReceiptSettings(
      'company-2',
      { confidenceThreshold: 0.5 },
      deps,
    );

    await expect(getReceiptSettings('company-1', deps)).resolves.toMatchObject({
      maxPages: 5,
      confidenceThreshold: 0.8,
    });
    await expect(getReceiptSettings('company-2', deps)).resolves.toMatchObject({
      maxPages: 20,
      confidenceThreshold: 0.5,
    });
  });
});
