import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TAX_REFERENCE_TTL_MS,
  getTaxReadiness,
  refreshTaxReference,
  type TaxReferenceDeps,
} from './reference.js';

const profile = { usingSalesTax: true, partnerTaxEnabled: false };
const rates = [
  { qboId: 'RATE5', name: 'GST 5%', description: null, active: true, rateValue: 5, sourceUpdatedAt: '2026-07-27T16:00:00.000Z' },
  { qboId: 'RATE7', name: 'PST 7%', description: null, active: true, rateValue: 7, sourceUpdatedAt: null },
];

function code(qboId: string) {
  return {
    qboId,
    name: qboId,
    description: null,
    active: true,
    taxable: qboId !== 'OOS',
    purchaseRates: qboId === 'OOS' ? [] : [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' }],
    sourceUpdatedAt: '2026-07-27T16:00:00.000Z',
  };
}

function createDb(companyIds = ['company-1']) {
  const companies = new Map(
    companyIds.map((id) => [
      id,
      {
        id,
        taxReferenceRefreshedAt: null as Date | null,
        taxUsingSalesTax: null as boolean | null,
        taxSupportStatus: 'needs_setup',
        taxSupportReason: null as string | null,
      },
    ]),
  );
  const taxRates = new Map<string, Record<string, unknown>>();
  const taxCodes = new Map<string, Record<string, unknown>>();
  const key = (companyId: string, qboId: string) => `${companyId}:${qboId}`;

  const matching = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'qboId' && typeof value === 'object' && value !== null && 'notIn' in value) {
        return !(value.notIn as string[]).includes(row.qboId as string);
      }
      return row[key] === value;
    });
  const model = (rows: Map<string, Record<string, unknown>>) => ({
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...rows.values()].filter((row) => matching(row, where)),
    ),
    findUnique: vi.fn(async ({ where }: { where: { companyId_qboId: { companyId: string; qboId: string } } }) =>
      rows.get(key(where.companyId_qboId.companyId, where.companyId_qboId.qboId)) ?? null,
    ),
    upsert: vi.fn(async ({ where, create, update }: { where: { companyId_qboId: { companyId: string; qboId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const rowKey = key(where.companyId_qboId.companyId, where.companyId_qboId.qboId);
      const next = { ...(rows.get(rowKey) ?? create), ...update };
      rows.set(rowKey, next);
      return next;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      for (const row of rows.values()) if (matching(row, where)) Object.assign(row, data);
    }),
  });
  const db = {
    $queryRawUnsafe: vi.fn(async () => [{ locked: 1 }]),
    company: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const company = companies.get(where.id);
        if (!company) throw new Error('missing company');
        return company;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const company = companies.get(where.id);
        if (!company) throw new Error('missing company');
        return Object.assign(company, data);
      }),
    },
    qboTaxRate: model(taxRates),
    qboTaxCode: model(taxCodes),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };

  return {
    db,
    company: companies.get('company-1')!,
    companies,
    taxRates,
    taxCodes,
    taxCode: (companyId: string, qboId: string) => taxCodes.get(key(companyId, qboId)),
    taxRate: (companyId: string, qboId: string) => taxRates.get(key(companyId, qboId)),
  };
}

function depsWith(
  db: ReturnType<typeof createDb>,
  codes: ReturnType<typeof code>[],
  now = new Date('2026-07-27T12:00:00.000Z'),
  taxRates = rates,
): TaxReferenceDeps {
  return {
    db: db.db,
    now: () => now,
    getClient: vi.fn(async () => ({
      getTaxProfile: vi.fn(async () => profile),
      listTaxCodes: vi.fn(async () => codes),
      listTaxRates: vi.fn(async () => taxRates),
    })),
  };
}

describe('refreshTaxReference', () => {
  let cache: ReturnType<typeof createDb>;

  beforeEach(() => {
    cache = createDb();
  });

  it('marks disappeared references inactive in the same transaction', async () => {
    await refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('GST5'), code('OOS')]));
    await refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('OOS')]));

    expect(cache.taxCode('company-1', 'GST5')).toMatchObject({ active: false });
    expect(cache.db.$transaction.mock.calls.filter((call) => call[1] === undefined)).toHaveLength(2);
  });

  it('preserves the last usable cache after an upstream failure', async () => {
    await refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('GST5'), code('OOS')]));
    const failingDeps = depsWith(cache, [code('OOS')]);
    failingDeps.getClient = vi.fn(async () => {
      throw new Error('upstream unavailable');
    });

    await expect(refreshTaxReference('company-1', { force: true }, failingDeps)).rejects.toThrow('upstream unavailable');
    expect([...cache.taxCodes.values()].filter((row) => row.active === true)).toHaveLength(2);
    expect(cache.company).toMatchObject({
      taxSupportStatus: 'needs_setup',
      taxSupportReason: 'Tax reference refresh failed.',
    });
  });

  it('uses the 24-hour cache unless the refresh is forced', async () => {
    const firstDeps = depsWith(cache, [code('GST5')]);
    await refreshTaxReference('company-1', { force: true }, firstDeps);
    const cachedDeps = depsWith(cache, [code('OOS')], new Date('2026-07-28T11:59:59.999Z'));

    await refreshTaxReference('company-1', {}, cachedDeps);
    expect(cachedDeps.getClient).not.toHaveBeenCalled();
    expect((await getTaxReadiness('company-1', cachedDeps)).taxCodes.map((item) => item.qboId)).toEqual(['GST5']);

    await refreshTaxReference('company-1', { force: true }, cachedDeps);
    expect(cachedDeps.getClient).toHaveBeenCalledTimes(1);
    expect(cache.taxCode('company-1', 'GST5')).toMatchObject({ active: false });
    expect(TAX_REFERENCE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('reads readiness from one repeatable-read database snapshot', async () => {
    await refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('GST5')]));
    cache.db.$transaction.mockClear();

    await getTaxReadiness('company-1', depsWith(cache, [code('GST5')]));

    expect(cache.db.$transaction).toHaveBeenCalledTimes(1);
    expect(cache.db.$transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: 'RepeatableRead',
    });
  });

  it('fails closed when a tax code references an unknown rate', async () => {
    const badCode = {
      ...code('GST5'),
      purchaseRates: [{ taxRateQboId: 'MISSING', taxTypeApplicable: 'TaxOnAmount' }],
    };

    await expect(refreshTaxReference('company-1', { force: true }, depsWith(cache, [badCode]))).rejects.toThrow(
      'unknown tax rate',
    );
    expect(cache.taxCodes.size).toBe(0);
    expect(cache.company).toMatchObject({
      taxSupportStatus: 'needs_setup',
      taxSupportReason: 'Tax reference refresh failed.',
    });
  });

  it('serializes concurrent refreshes so an older response cannot overwrite a newer one', async () => {
    let releaseProfile: (value: typeof profile) => void = () => undefined;
    const delayedProfile = new Promise<typeof profile>((resolve) => {
      releaseProfile = resolve;
    });
    const olderDeps = depsWith(cache, [code('GST5')]);
    olderDeps.getClient = vi.fn(async () => ({
      getTaxProfile: vi.fn(async () => delayedProfile),
      listTaxCodes: vi.fn(async () => [code('GST5')]),
      listTaxRates: vi.fn(async () => rates),
    }));
    const newerDeps = depsWith(cache, [code('OOS')]);

    const older = refreshTaxReference('company-1', { force: true }, olderDeps);
    await Promise.resolve();
    const newer = refreshTaxReference('company-1', { force: true }, newerDeps);
    await Promise.resolve();
    expect(newerDeps.getClient).not.toHaveBeenCalled();

    releaseProfile(profile);
    await Promise.all([older, newer]);

    expect(cache.taxCode('company-1', 'GST5')).toMatchObject({ active: false });
    expect(cache.taxCode('company-1', 'OOS')).toMatchObject({ active: true });
  });

  it('cleans up the company refresh queue after a rejection', async () => {
    const failingDeps = depsWith(cache, [code('GST5')]);
    failingDeps.getClient = vi.fn(async () => {
      throw new Error('first refresh fails');
    });

    await expect(refreshTaxReference('company-1', { force: true }, failingDeps)).rejects.toThrow('first refresh fails');
    await expect(refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('OOS')]))).resolves.toMatchObject({
      refreshed: true,
    });
  });

  it('preserves the upstream error when recording the diagnostic fails', async () => {
    const failingDeps = depsWith(cache, [code('GST5')]);
    failingDeps.getClient = vi.fn(async () => {
      throw new Error('upstream sentinel');
    });
    cache.db.company.update.mockRejectedValueOnce(new Error('diagnostic write sentinel'));

    await expect(refreshTaxReference('company-1', { force: true }, failingDeps)).rejects.toThrow('upstream sentinel');
  });

  it('keeps unsupported tax-code shapes normalized but not ready', async () => {
    const unsupportedCodes = [
      {
        ...code('COMPOUND'),
        purchaseRates: [
          { taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' },
          { taxRateQboId: 'RATE7', taxTypeApplicable: 'TaxOnAmount' },
        ],
      },
      { ...code('TAX_ON_TAX'), purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnTax' }] },
      { ...code('SALES_ONLY'), purchaseRates: [] },
      { ...code('INACTIVE_RATE'), purchaseRates: [{ taxRateQboId: 'OLD', taxTypeApplicable: 'TaxOnAmount' }] },
    ];
    const result = await refreshTaxReference(
      'company-1',
      { force: true },
      depsWith(cache, unsupportedCodes, new Date('2026-07-27T12:00:00.000Z'), [
        ...rates,
        { qboId: 'OLD', name: 'Old', description: null, active: false, rateValue: 5, sourceUpdatedAt: null },
      ]),
    );

    expect(result.readiness).toMatchObject({ status: 'needs_setup' });
    for (const taxCode of unsupportedCodes) {
      expect(cache.taxCode('company-1', taxCode.qboId)).toMatchObject({ active: true, combinedPurchaseRate: null });
    }
  });

  it.each([
    ['unknown taxable semantics', { taxable: null }],
    ['positive rate marked non-taxable', { taxable: false }],
    ['sales-only code', { purchaseRates: [] }],
    ['inactive code', { active: false }],
    ['compound code', { purchaseRates: [
      { taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' },
      { taxRateQboId: 'RATE7', taxTypeApplicable: 'TaxOnAmount' },
    ] }],
    ['non-amount component', { purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnTax' }] }],
  ] as const)('does not declare readiness for %s', async (_case, changes) => {
    const result = await refreshTaxReference(
      'company-1',
      { force: true },
      depsWith(cache, [{ ...code('GST5'), ...changes }]),
    );

    expect(result.readiness.status).toBe('needs_setup');
  });

  it('treats a missing tax-enabled preference as malformed rather than disabled', async () => {
    const deps = depsWith(cache, [code('GST5')]);
    deps.getClient = vi.fn(async () => ({
      getTaxProfile: vi.fn(async () => ({ usingSalesTax: null, partnerTaxEnabled: null })),
      listTaxCodes: vi.fn(async () => [code('GST5')]),
      listTaxRates: vi.fn(async () => rates),
    }));

    const result = await refreshTaxReference('company-1', { force: true }, deps);

    expect(result.readiness).toMatchObject({
      status: 'needs_setup',
      usingSalesTax: null,
      reason: 'QuickBooks tax preferences are malformed.',
    });
  });

  it.each([
    ['missing', null],
    ['non-finite', Number.NaN],
    ['negative', -1],
    ['outside storage bound', 1_000],
  ])('rejects a %s rate while preserving the prior cache', async (_case, rateValue) => {
    await refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('GST5')]));
    const malformedRates = [{ ...rates[0], rateValue }];

    await expect(
      refreshTaxReference(
        'company-1',
        { force: true },
        depsWith(cache, [code('GST5')], undefined, malformedRates),
      ),
    ).rejects.toThrow(/unsupported tax rate/i);
    expect(cache.taxRate('company-1', 'RATE5')).toMatchObject({ rateValue: 5 });
    expect(cache.company).toMatchObject({
      taxSupportStatus: 'needs_setup',
      taxSupportReason: 'Tax reference refresh failed.',
    });
  });

  it('ignores an unreferenced adjustment rate with null metadata', async () => {
    const adjustment = {
      qboId: 'UNREFERENCED_ADJUSTMENT',
      name: 'Filing adjustment without a percentage',
      description: null,
      active: true,
      rateValue: null,
      sourceUpdatedAt: null,
    };

    const result = await refreshTaxReference(
      'company-1',
      { force: true },
      depsWith(cache, [code('GST5')], undefined, [rates[0], adjustment]),
    );

    expect(result.readiness).toMatchObject({ status: 'ready' });
    expect(cache.taxRate('company-1', 'RATE5')).toMatchObject({ rateValue: 5 });
    expect(cache.taxRate('company-1', 'UNREFERENCED_ADJUSTMENT')).toBeUndefined();
  });

  it('fails closed when a tax code references an adjustment rate with null metadata', async () => {
    const adjustment = {
      qboId: 'REFERENCED_ADJUSTMENT',
      name: 'Referenced adjustment without a percentage',
      description: null,
      active: true,
      rateValue: null,
      sourceUpdatedAt: null,
    };
    const referencedAdjustment = {
      ...code('REFERENCED_ADJUSTMENT'),
      purchaseRates: [{ taxRateQboId: 'REFERENCED_ADJUSTMENT', taxTypeApplicable: 'TaxOnAmount' }],
    };
    const deps = depsWith(cache, [referencedAdjustment], undefined, [rates[0], adjustment]);

    await expect(
      refreshTaxReference('company-1', { force: true }, deps),
    ).rejects.toThrow(/unsupported tax rate/i);
    expect(cache.taxRates.size).toBe(0);
    expect(cache.company).toMatchObject({
      taxSupportStatus: 'needs_setup',
      taxSupportReason: 'Tax reference refresh failed.',
    });
  });

  it('persists normalized source timestamps for codes and rates', async () => {
    const rate7Code = {
      ...code('PST7'),
      purchaseRates: [{ taxRateQboId: 'RATE7', taxTypeApplicable: 'TaxOnAmount' }],
    };
    await refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('GST5'), rate7Code]));

    expect(cache.taxCode('company-1', 'GST5')).toMatchObject({
      sourceUpdatedAt: new Date('2026-07-27T16:00:00.000Z'),
    });
    expect(cache.taxRate('company-1', 'RATE5')).toMatchObject({
      sourceUpdatedAt: new Date('2026-07-27T16:00:00.000Z'),
    });
    expect(cache.taxRate('company-1', 'RATE7')).toMatchObject({ sourceUpdatedAt: null });
  });

  it('returns only active supported purchase codes from the complete cache', async () => {
    const unsupported = Array.from({ length: 101 }, (_, index) => ({
      ...code(`U${String(index).padStart(3, '0')}`),
      active: false,
    }));
    const supported = Array.from({ length: 101 }, (_, index) =>
      code(`S${String(index).padStart(3, '0')}`),
    );
    const nonTax = { ...code('OOS'), name: 'Explicit non-tax treatment' };
    const zero = {
      ...code('ZERO'),
      purchaseRates: [{ taxRateQboId: 'ZERO', taxTypeApplicable: 'TaxOnAmount' }],
    };

    const result = await refreshTaxReference(
      'company-1',
      { force: true },
      depsWith(cache, [...unsupported, ...supported, nonTax, zero], undefined, [
        ...rates,
        { ...rates[0], qboId: 'ZERO', rateValue: 0 },
      ]),
    );

    expect(result.readiness.taxCodes).toHaveLength(103);
    expect(result.readiness.taxCodes.map((item) => item.qboId)).toEqual([
      ...supported.map((item) => item.qboId),
      'OOS',
      'ZERO',
    ]);
    expect(cache.taxCodes).toHaveProperty('size', 204);
  });

  it('retains the exact rate of a supported simple purchase code', async () => {
    const fractionalRates = [{ qboId: 'RATE5', name: 'Exact', description: null, active: true, rateValue: 5.123456, sourceUpdatedAt: null }];

    const result = await refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('GST5')], undefined, fractionalRates));

    expect(result.readiness).toMatchObject({ status: 'ready' });
    expect(cache.taxCode('company-1', 'GST5')).toMatchObject({ combinedPurchaseRate: 5.123456 });
  });

  it('marks disappeared rates inactive without using an empty notIn filter', async () => {
    await refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('GST5')]));
    await refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('OOS')], undefined, []));

    expect(cache.taxRate('company-1', 'RATE5')).toMatchObject({ active: false });
    expect(cache.db.qboTaxRate.updateMany).toHaveBeenLastCalledWith({
      where: { companyId: 'company-1' },
      data: { active: false },
    });
  });

  it('marks disappeared codes inactive without using an empty notIn filter', async () => {
    await refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('GST5')]));
    await refreshTaxReference('company-1', { force: true }, depsWith(cache, [], undefined, []));

    expect(cache.taxCode('company-1', 'GST5')).toMatchObject({ active: false });
    expect(cache.db.qboTaxCode.updateMany).toHaveBeenLastCalledWith({
      where: { companyId: 'company-1' },
      data: { active: false },
    });
  });

  it('never changes another company\'s cached references', async () => {
    cache = createDb(['company-1', 'company-2']);
    await refreshTaxReference('company-2', { force: true }, depsWith(cache, [code('GST5')]));
    await refreshTaxReference('company-1', { force: true }, depsWith(cache, [code('OOS')], undefined, []));

    expect(cache.taxCode('company-2', 'GST5')).toMatchObject({ active: true });
    expect(cache.taxRate('company-2', 'RATE5')).toMatchObject({ active: true });
  });
});
