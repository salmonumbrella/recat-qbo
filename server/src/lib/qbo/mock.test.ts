// The mock client must mirror the real client's multi-line semantics (C1):
// reads expose only holding lines (amount = holding sum), writes replace only
// holding lines, and undo pulls back only the previously written category
// lines — the whole write-back/undo path is exercised against it in tests and
// demo mode, so its arithmetic has to match production.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getMockRealm,
  mergePersistedMockRealm,
  MockQboClient,
  MOCK_REALM_BLUEBIRD,
  MOCK_REALM_HARBOR,
  resetMockRealms,
} from './mock.js';
import type { StagedCategorization } from '@recat/shared';
import { QboSyncTokenConflict, type RawPurchase } from './types.js';

const HOLDING_IDS = ['4', '5']; // Harbor: Ask My Accountant + Uncategorized Expense

function client(): MockQboClient {
  return new MockQboClient(MOCK_REALM_HARBOR, HOLDING_IDS);
}

/** Turn the SYSCO purchase (id 2, -486.12 in holding) into a two-line entity. */
function addCategorizedLine(): void {
  const realm = getMockRealm(MOCK_REALM_HARBOR);
  const entity = realm.txns.find((t) => t.qboId === '2' && t.qboType === 'Purchase');
  if (!entity) throw new Error('seed txn missing');
  entity.lines.push({ id: '2', amount: 50, accountQboId: '10' }); // Food purchases, already categorized
  entity.amount = -536.12;
}

beforeEach(() => {
  resetMockRealms();
});

describe('MockQboClient multi-line entity safety', () => {
  it('fetchTxn exposes only holding lines with amount = holding sum', async () => {
    addCategorizedLine();
    const txn = await client().fetchTxn('Purchase', '2');
    expect(txn).not.toBeNull();
    expect(txn?.amount).toBe(-486.12); // NOT the -536.12 entity total
    expect(txn?.lines).toHaveLength(1);
    expect(txn?.lines[0]).toMatchObject({ accountQboId: '4', amount: 486.12 });
  });

  it('recategorize replaces only the holding line; the categorized line and total survive', async () => {
    addCategorizedLine();
    const c = client();
    const txn = await c.fetchTxn('Purchase', '2');
    if (!txn) throw new Error('missing txn');

    await c.recategorize(txn, [
      { amount: -400, accountQboId: '10' },
      { amount: -86.12, accountQboId: '12' },
    ]);

    const entity = getMockRealm(MOCK_REALM_HARBOR).txns.find((t) => t.qboId === '2');
    if (!entity) throw new Error('missing entity');
    // The pre-existing $50 categorized line survived verbatim.
    expect(entity.lines.filter((l) => l.accountQboId === '10' && l.amount === 50)).toHaveLength(1);
    // No holding lines remain; the splits are present.
    expect(entity.lines.some((l) => HOLDING_IDS.includes(l.accountQboId))).toBe(false);
    // Entity total unchanged: 50 + 400 + 86.12.
    const total = entity.lines.reduce((a, l) => a + l.amount, 0);
    expect(total).toBeCloseTo(536.12, 2);
  });

  it('moveToAccount pulls back only the previously posted category lines (undo)', async () => {
    addCategorizedLine();
    const c = client();
    const txn = await c.fetchTxn('Purchase', '2');
    if (!txn) throw new Error('missing txn');
    await c.recategorize(txn, [{ amount: -486.12, accountQboId: '17' }]); // Meals & entertainment

    const posted = await c.fetchTxn('Purchase', '2');
    if (!posted) throw new Error('missing posted txn');
    await c.moveToAccount(posted, '4', ['17']);

    const entity = getMockRealm(MOCK_REALM_HARBOR).txns.find((t) => t.qboId === '2');
    if (!entity) throw new Error('missing entity');
    // Back in holding at the original amount; the $50 categorized line intact.
    expect(entity.lines.filter((l) => l.accountQboId === '4' && l.amount === 486.12)).toHaveLength(1);
    expect(entity.lines.filter((l) => l.accountQboId === '10' && l.amount === 50)).toHaveLength(1);
    expect(entity.lines.some((l) => l.accountQboId === '17')).toBe(false);
    expect(entity.lines.reduce((a, l) => a + l.amount, 0)).toBeCloseTo(536.12, 2);
  });

  it('moveToAccount fails loudly when no lines post to the given categories', async () => {
    const c = client();
    const txn = await c.fetchTxn('Purchase', '2');
    if (!txn) throw new Error('missing txn');
    await expect(c.moveToAccount(txn, '4', ['17'])).rejects.toThrow(/no lines posting/);
  });

  it('listTxnsInAccounts filters lines by the ids given (wizard candidate probing)', async () => {
    addCategorizedLine();
    const txns = await client().listTxnsInAccounts(['10']); // probe a non-holding account
    const sysco = txns.find((t) => t.qboId === '2');
    expect(sysco?.lines).toHaveLength(1);
    expect(sysco?.lines[0]?.accountQboId).toBe('10');
    expect(sysco?.amount).toBe(-50);
  });
});

describe('MockQboClient tax fixtures', () => {
  it('hydrates pre-tax persisted Purchase mutations into a coherent preparable raw body', async () => {
    const current = getMockRealm(MOCK_REALM_BLUEBIRD);
    const persistedBeforePurchaseTax = {
      realmId: MOCK_REALM_BLUEBIRD,
      legalName: 'Stale persisted fixture name',
      accounts: [],
      txns: current.txns.map((txn) =>
        txn.qboId === '14'
          ? {
              ...txn,
              syncToken: 7,
              memo: 'Persisted user mutation',
              lines: txn.lines.map((line) => ({
                ...line,
                memo: 'Persisted line mutation',
              })),
            }
          : txn,
      ),
      transfers: [
        {
          qboId: 'transfer-1000',
          amount: 25,
          fromAccountQboId: '1',
          toAccountQboId: '2',
          date: '2026-07-15',
          memo: 'Persisted transfer',
          lastUpdated: '2026-07-15T08:00:00.000Z',
        },
      ],
      nextId: 1001,
    };

    const hydrated = mergePersistedMockRealm(current, persistedBeforePurchaseTax);

    expect(hydrated.legalName).toBe('Bluebird Salon LLC');
    expect(hydrated.accounts).toBe(current.accounts);
    expect(hydrated.taxProfile).toEqual({ usingSalesTax: true, partnerTaxEnabled: false });
    expect(hydrated.taxCodes).toHaveLength(3);
    expect(hydrated.taxRates).toHaveLength(2);
    expect(hydrated.purchaseSnapshots).toHaveLength(2);
    expect(hydrated.txns.find((txn) => txn.qboId === '14')).toMatchObject({
      syncToken: 7,
      memo: 'Persisted user mutation',
    });
    expect(hydrated.transfers).toEqual(persistedBeforePurchaseTax.transfers);
    expect(hydrated.nextId).toBe(1001);
    Object.assign(current, hydrated);
    const client = new MockQboClient(MOCK_REALM_BLUEBIRD, ['3', '4']);
    const txn = await client.fetchTxn('Purchase', '14');
    const before = await client.fetchPurchaseSnapshot('14');
    if (!txn || !before) throw new Error('hydrated legacy Purchase missing');
    const prepared = await client.preparePurchaseRecategorization(
      txn,
      {
        transactionId: '00000000-0000-4000-8000-000000000014',
        revision: 1,
        taxCalculation: 'TaxExcluded',
        totals: {
          subtotalCents: -18_858,
          taxCents: -2_572,
          totalCents: -21_430,
        },
        lines: [{
          idx: 0,
          subtotalCents: -18_858,
          taxCents: -2_572,
          totalCents: -21_430,
          categoryQboId: '8',
          taxCodeQboId: before.lines[0]!.taxCodeQboId!,
          memo: 'Legacy hydrated preparation',
        }],
        tagIds: [],
      },
      before,
      'REQUEST_LEGACY_HYDRATED',
    );
    expect((txn.raw as RawPurchase).SyncToken).toBe('7');
    expect((txn.raw as RawPurchase).Line?.[0]?.Description).toBe(
      'Persisted line mutation',
    );
    expect(prepared.body.SyncToken).toBe('7');
  });

  it('derives coherent raw bodies from unusable or inconsistent persisted sets', () => {
    const current = getMockRealm(MOCK_REALM_BLUEBIRD);
    const txnsWithMutatedPurchase = current.txns.map((txn) =>
      txn.qboId === '14' ? { ...txn, syncToken: 7 } : txn);
    const staleTokenRaw = structuredClone(current.rawPurchases);
    const preservedRaw = staleTokenRaw.find((raw) => raw.Id === '15');
    if (!preservedRaw) throw new Error('preserved raw fixture missing');
    preservedRaw.LegacyUnknownDocumentField = { preserve: true };
    const incompleteRaw = structuredClone(staleTokenRaw);
    delete incompleteRaw[0]!.Line;
    const cases = [
      staleTokenRaw,
      staleTokenRaw.slice(0, 2),
      incompleteRaw,
    ];

    for (const rawPurchases of cases) {
      const hydrated = mergePersistedMockRealm(current, {
        txns: txnsWithMutatedPurchase,
        purchaseSnapshots: current.purchaseSnapshots,
        rawPurchases,
        transfers: current.transfers,
        nextId: current.nextId,
      });
      const purchaseEntities = hydrated.txns.filter(
        (txn) => txn.qboType === 'Purchase' && !txn.deleted,
      );
      expect(hydrated.rawPurchases).toHaveLength(purchaseEntities.length);
      for (const entity of purchaseEntities) {
        const raw = hydrated.rawPurchases.find((candidate) => candidate.Id === entity.qboId);
        expect(raw).toMatchObject({
          SyncToken: String(entity.syncToken),
          TxnDate: entity.date,
          TotalAmt: Math.abs(entity.amount),
          AccountRef: { value: entity.bankAccountQboId },
          Line: expect.any(Array),
        });
      }
      expect(
        hydrated.rawPurchases.find((candidate) => candidate.Id === '15')
          ?.LegacyUnknownDocumentField,
      ).toEqual({ preserve: true });
    }
  });

  it('derives only the Purchase with an unsupported persisted line before preparation', async () => {
    const current = getMockRealm(MOCK_REALM_BLUEBIRD);
    const malformedLines: RawPurchase['Line'][] = [
      [{}],
      [{
        Id: '1',
        Amount: 214.3,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {},
      }],
    ];
    const hydratedCases = malformedLines.map((Line) => {
      const rawPurchases = structuredClone(current.rawPurchases);
      const malformed = rawPurchases.find((raw) => raw.Id === '14');
      const coherentSibling = rawPurchases.find((raw) => raw.Id === '15');
      if (!malformed || !coherentSibling) throw new Error('raw fixture missing');
      malformed.Line = Line;
      coherentSibling.UnknownSiblingField = { preserve: true };
      return mergePersistedMockRealm(current, {
        txns: structuredClone(current.txns),
        purchaseSnapshots: structuredClone(current.purchaseSnapshots),
        rawPurchases,
        transfers: structuredClone(current.transfers),
        nextId: current.nextId,
      });
    });

    for (const hydrated of hydratedCases) {
      expect(
        hydrated.rawPurchases.find((raw) => raw.Id === '14')?.Line?.[0],
      ).toMatchObject({
        Id: '1',
        Amount: 214.3,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: '3' },
        },
      });
      expect(
        hydrated.rawPurchases.find((raw) => raw.Id === '15')
          ?.UnknownSiblingField,
      ).toEqual({ preserve: true });
    }

    Object.assign(current, hydratedCases[0]);
    const client = new MockQboClient(MOCK_REALM_BLUEBIRD, ['3', '4']);
    const txn = await client.fetchTxn('Purchase', '14');
    const before = await client.fetchPurchaseSnapshot('14');
    if (!txn || !before) throw new Error('reconciled Purchase missing');
    await expect(
      client.preparePurchaseRecategorization(
        txn,
        {
          transactionId: '00000000-0000-4000-8000-000000000014',
          revision: 1,
          taxCalculation: 'TaxExcluded',
          totals: {
            subtotalCents: -18_858,
            taxCents: -2_572,
            totalCents: -21_430,
          },
          lines: [{
            idx: 0,
            subtotalCents: -18_858,
            taxCents: -2_572,
            totalCents: -21_430,
            categoryQboId: '8',
            taxCodeQboId: before.lines[0]!.taxCodeQboId!,
            memo: 'Reconciled malformed raw line',
          }],
          tagIds: [],
        },
        before,
        'REQUEST_RECONCILED_LINE',
      ),
    ).resolves.toMatchObject({
      body: { Id: '14', SyncToken: '0' },
    });
  });

  it('ignores malformed persisted mutable state', () => {
    const current = getMockRealm(MOCK_REALM_BLUEBIRD);

    expect(() =>
      mergePersistedMockRealm(current, {
        txns: [{ qboId: '14', lines: null }],
        transfers: 'not-an-array',
        nextId: -1,
      }),
    ).not.toThrow();
    expect(
      mergePersistedMockRealm(current, {
        txns: [{ qboId: '14', lines: null }],
        transfers: 'not-an-array',
        nextId: -1,
      }),
    ).toEqual(current);
  });

  it('hydrates persisted prepared-write Purchase snapshots with legacy fallback', () => {
    const current = getMockRealm(MOCK_REALM_HARBOR);
    const genericSnapshot = {
      qboId: 'PURCHASE_GENERIC',
      syncToken: '8',
      totalCents: -1_000,
      accountQboId: 'ACCOUNT_PAYMENT_GENERIC',
      date: '2026-07-01',
      direction: 'purchase',
      globalTaxCalculation: 'TaxInclusive',
      totalTaxCents: -48,
      lines: [{
        id: 'LINE_GENERIC',
        amountCents: -952,
        description: 'generic memo',
        accountQboId: 'ACCOUNT_CATEGORY_GENERIC',
        customerQboId: null,
        classQboId: null,
        taxCodeQboId: 'TAX_CODE_STANDARD',
        taxAmountCents: -48,
        taxInclusiveCents: -1_000,
      }],
    } as const;
    const persistedBase = {
      txns: current.txns,
      transfers: current.transfers,
      nextId: current.nextId,
    };

    expect(mergePersistedMockRealm(current, {
      ...persistedBase,
      purchaseSnapshots: [genericSnapshot],
    }).purchaseSnapshots).toEqual([genericSnapshot]);
    expect(mergePersistedMockRealm(current, persistedBase).purchaseSnapshots).toBe(
      current.purchaseSnapshots,
    );
    expect(mergePersistedMockRealm(current, {
      ...persistedBase,
      purchaseSnapshots: [{ ...genericSnapshot, lines: null }],
    }).purchaseSnapshots).toBe(current.purchaseSnapshots);
  });

  it('keeps tax-disabled and tax-enabled realm fixtures isolated', async () => {
    const harbor = client();
    const bluebird = new MockQboClient(MOCK_REALM_BLUEBIRD, ['3', '4']);

    await expect(harbor.getTaxProfile()).resolves.toEqual({ usingSalesTax: false, partnerTaxEnabled: null });
    await expect(harbor.listTaxCodes()).resolves.toEqual([]);
    await expect(harbor.listTaxRates()).resolves.toEqual([]);
    await expect(bluebird.getTaxProfile()).resolves.toEqual({ usingSalesTax: true, partnerTaxEnabled: false });
  });

  it('returns deterministic single-rate, multi-component, and inactive tax codes', async () => {
    const bluebird = new MockQboClient(MOCK_REALM_BLUEBIRD, ['3', '4']);

    await expect(bluebird.listTaxRates()).resolves.toEqual([
      { qboId: 'GST5', name: 'GST 5%', description: null, active: true, rateValue: 5, sourceUpdatedAt: null },
      { qboId: 'PST7', name: 'PST 7%', description: null, active: true, rateValue: 7, sourceUpdatedAt: null },
    ]);
    await expect(bluebird.listTaxCodes()).resolves.toEqual([
      {
        qboId: 'GST',
        name: 'GST',
        description: 'Goods and services tax',
        active: true,
        taxable: true,
        purchaseRates: [{ taxRateQboId: 'GST5', taxTypeApplicable: 'TaxOnAmount' }],
        sourceUpdatedAt: null,
      },
      {
        qboId: 'GST-PST',
        name: 'GST + PST',
        description: null,
        active: true,
        taxable: true,
        purchaseRates: [
          { taxRateQboId: 'GST5', taxTypeApplicable: 'TaxOnAmount' },
          { taxRateQboId: 'PST7', taxTypeApplicable: 'TaxOnAmount' },
        ],
        sourceUpdatedAt: null,
      },
      {
        qboId: 'OLD-GST',
        name: 'Old GST',
        description: null,
        active: false,
        taxable: true,
        purchaseRates: [{ taxRateQboId: 'GST5', taxTypeApplicable: 'TaxOnAmount' }],
        sourceUpdatedAt: null,
      },
    ]);
  });

  it('returns signed purchase and refund snapshots with complete account-expense detail', async () => {
    const bluebird = new MockQboClient(MOCK_REALM_BLUEBIRD, ['3', '4']);

    await expect(bluebird.fetchPurchaseSnapshot('14')).resolves.toEqual({
      qboId: '14',
      syncToken: '0',
      totalCents: -21430,
      accountQboId: '1',
      date: '2026-07-10',
      direction: 'purchase',
      globalTaxCalculation: 'TaxExcluded',
      totalTaxCents: -2572,
      lines: [
        {
          id: '1',
          amountCents: -21430,
          description: 'Color stock',
          accountQboId: '3',
          customerQboId: 'customer-1',
          classQboId: 'class-1',
          taxCodeQboId: 'UNKNOWN-PURCHASE-TAX',
          taxAmountCents: -2572,
          taxInclusiveCents: null,
        },
      ],
    });

    await expect(bluebird.fetchPurchaseSnapshot('refund-14')).resolves.toMatchObject({
      totalCents: 21430,
      direction: 'refund',
      totalTaxCents: 2572,
      lines: [{ amountCents: 21430, taxAmountCents: 2572 }],
    });
  });
});

function addGenericLineWriteEntity(
  qboType: 'Purchase' | 'Deposit' | 'JournalEntry',
) {
  const realm = getMockRealm(MOCK_REALM_HARBOR);
  const qboId = `ENTITY_${qboType.toUpperCase()}_GENERIC`;
  realm.txns.push({
    qboId,
    qboType,
    syncToken: 7,
    date: '2026-07-01',
    payee: 'Generic Counterparty',
    memo: 'generic private note',
    amount: qboType === 'Deposit' ? 15 : -15,
    bankAccountQboId: '1',
    lines: [
      {
        id: 'LINE_HOLDING_GENERIC',
        amount: 10,
        accountQboId: '4',
        memo: 'generic holding memo',
      },
      {
        id: 'LINE_UNTOUCHED_GENERIC',
        amount: 5,
        accountQboId: '19',
        memo: 'generic untouched memo',
      },
    ],
    lastUpdated: '2026-07-01T00:00:00.000Z',
  });
  if (qboType === 'Purchase') {
    realm.rawPurchases.push({
      Id: qboId,
      SyncToken: '7',
      TxnDate: '2026-07-01',
      TotalAmt: 15,
      PrivateNote: 'generic private note',
      AccountRef: { value: '1', name: 'Generic payment account' },
      UnknownDocumentField: { preserve: true },
      Line: [
        {
          Id: 'LINE_HOLDING_GENERIC',
          Amount: 10,
          Description: 'generic holding memo',
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: '4', name: 'Generic holding account' },
          },
        },
        {
          Id: 'LINE_UNTOUCHED_GENERIC',
          Amount: 5,
          Description: 'generic untouched memo',
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: '19', name: 'Generic untouched account' },
          },
          UnknownLineField: { preserve: true },
        },
      ],
    });
  }
  return {
    realm,
    qboId,
    client: new MockQboClient(MOCK_REALM_HARBOR, ['4']),
  };
}

describe('MockQboClient prepared transfer line writes', () => {
  it.each(['Purchase', 'Deposit', 'JournalEntry'] as const)(
    'prepares, verifies, and persists one exact %s write',
    async (qboType) => {
      const fixture = addGenericLineWriteEntity(qboType);
      const txn = await fixture.client.fetchTxn(qboType, fixture.qboId);
      if (!txn) throw new Error('generic mock line-write fixture missing');
      const prepared = await fixture.client.prepareLineRecategorization(
        txn,
        [{
          amount: txn.amount,
          accountQboId: '17',
          memo: 'generic target memo',
        }],
        'request-1',
      );

      expect(prepared.body).toEqual(
        JSON.parse(JSON.stringify(prepared.body)) as Record<string, unknown>,
      );
      expect(prepared.body).toMatchObject({
        Id: fixture.qboId,
        SyncToken: '7',
        PrivateNote: 'generic private note',
      });
      expect(prepared.before.contentHash).not.toBe(prepared.expected.contentHash);
      expect(prepared.body.Line).toEqual(expect.arrayContaining([
        expect.objectContaining({
          Id: 'LINE_UNTOUCHED_GENERIC',
          Amount: 5,
          Description: 'generic untouched memo',
        }),
      ]));

      const result = await fixture.client.sendPreparedLineWrite(prepared);
      expect(result).toEqual({
        ok: true,
        newSyncToken: '8',
        snapshot: {
          ...prepared.expected,
          syncToken: '8',
        },
      });
      await expect(
        fixture.client.fetchLineWriteSnapshot(qboType, fixture.qboId),
      ).resolves.toEqual(result.snapshot);
      const entity = fixture.realm.txns.find(
        (candidate) =>
          candidate.qboType === qboType && candidate.qboId === fixture.qboId,
      );
      expect(entity).toMatchObject({
        syncToken: 8,
        lines: expect.arrayContaining([
          {
            id: 'LINE_UNTOUCHED_GENERIC',
            amount: 5,
            accountQboId: '19',
            memo: 'generic untouched memo',
          },
          expect.objectContaining({
            amount: 10,
            accountQboId: '17',
            memo: 'generic target memo',
          }),
        ]),
      });
      expect(entity?.lines.some((line) => line.accountQboId === '4')).toBe(false);

      await expect(
        fixture.client.sendPreparedLineWrite(prepared),
      ).rejects.toBeInstanceOf(QboSyncTokenConflict);
      expect(entity?.syncToken).toBe(8);
      expect(entity?.lines.filter((line) => line.accountQboId === '17')).toHaveLength(1);
    },
  );

  it('applies the shared prepared validation contract before mutation', async () => {
    const fixture = addGenericLineWriteEntity('Purchase');
    const txn = await fixture.client.fetchTxn('Purchase', fixture.qboId);
    if (!txn) throw new Error('generic mock line-write fixture missing');
    const prepared = await fixture.client.prepareLineRecategorization(
      txn,
      [{ amount: txn.amount, accountQboId: '17' }],
      'request-1',
    );
    const tampered = structuredClone(prepared);
    (tampered.body.Line as Record<string, unknown>[]).at(-1)!.Amount = 9;

    await expect(fixture.client.sendPreparedLineWrite(tampered)).rejects.toThrow(
      /request hash/i,
    );
    expect(
      fixture.realm.txns.find((candidate) => candidate.qboId === fixture.qboId),
    ).toMatchObject({ syncToken: 7 });
  });

  it('runs the transfer authority guard immediately before mock provider mutation', async () => {
    const fixture = addGenericLineWriteEntity('Purchase');
    const txn = await fixture.client.fetchTxn('Purchase', fixture.qboId);
    if (!txn) throw new Error('generic mock line-write fixture missing');
    const prepared = await fixture.client.prepareLineRecategorization(
      txn,
      [{ amount: txn.amount, accountQboId: '17' }],
      'request-1',
    );
    const guard = async () => {
      throw new Error('AUTHORITY_LOST_SENTINEL');
    };

    await expect(
      fixture.client.sendPreparedLineWrite(prepared, guard),
    ).rejects.toThrow('AUTHORITY_LOST_SENTINEL');
    expect(
      fixture.realm.txns.find((candidate) => candidate.qboId === fixture.qboId),
    ).toMatchObject({ syncToken: 7 });
  });

  it('captures the validated mock body before its first asynchronous boundary', async () => {
    const fixture = addGenericLineWriteEntity('Deposit');
    const txn = await fixture.client.fetchTxn('Deposit', fixture.qboId);
    if (!txn) throw new Error('generic mock line-write fixture missing');
    const prepared = await fixture.client.prepareLineRecategorization(
      txn,
      [{ amount: txn.amount, accountQboId: '17' }],
      'request-1',
    );

    const result = fixture.client.sendPreparedLineWrite(prepared);
    prepared.body.PrivateNote = 'mutation after send call';

    await expect(result).resolves.toMatchObject({ newSyncToken: '8' });
    await expect(
      fixture.client.fetchTxn('Deposit', fixture.qboId),
    ).resolves.toMatchObject({
      raw: { PrivateNote: 'generic private note' },
    });
  });

  it('accepts the same prepared identity after recursive JSONB-style key reordering', async () => {
    const fixture = addGenericLineWriteEntity('Deposit');
    const txn = await fixture.client.fetchTxn('Deposit', fixture.qboId);
    if (!txn) throw new Error('generic mock line-write fixture missing');
    const prepared = await fixture.client.prepareLineRecategorization(
      txn,
      [{ amount: txn.amount, accountQboId: '17' }],
      'request-1',
    );
    const reorder = (value: unknown): unknown => {
      if (value === null || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(reorder);
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(value).sort(
        (left, right) =>
          left.length - right.length || left.localeCompare(right),
      )) {
        Object.defineProperty(result, key, {
          value: reorder((value as Record<string, unknown>)[key]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    };
    const reloaded = reorder(prepared) as typeof prepared;

    expect(JSON.stringify(reloaded.body)).not.toBe(JSON.stringify(prepared.body));
    await expect(
      fixture.client.sendPreparedLineWrite(reloaded),
    ).resolves.toMatchObject({ newSyncToken: '8' });
  });

  it('routes direct recategorize through a verified prepared write', async () => {
    const fixture = addGenericLineWriteEntity('Deposit');
    const txn = await fixture.client.fetchTxn('Deposit', fixture.qboId);
    if (!txn) throw new Error('generic mock line-write fixture missing');

    await expect(
      fixture.client.recategorize(
        txn,
        [{ amount: txn.amount, accountQboId: '17' }],
      ),
    ).resolves.toEqual({ ok: true, newSyncToken: '8' });
    await expect(
      fixture.client.fetchLineWriteSnapshot('Deposit', fixture.qboId),
    ).resolves.toMatchObject({
      qboType: 'Deposit',
      qboId: fixture.qboId,
      syncToken: '8',
    });
  });

  it.each(['Deposit', 'JournalEntry'] as const)(
    'keeps the exact %s raw body coherent through prepared write, undo, reprepare, and persisted hydrate',
    async (qboType) => {
      const fixture = addGenericLineWriteEntity(qboType);
      const original = await fixture.client.fetchTxn(qboType, fixture.qboId);
      if (!original) throw new Error('generic mock line-write fixture missing');
      const prepared = await fixture.client.prepareLineRecategorization(
        original,
        [{ amount: original.amount, accountQboId: '17' }],
        'request-1',
      );
      await fixture.client.sendPreparedLineWrite(prepared);
      const posted = await fixture.client.fetchTxn(qboType, fixture.qboId);
      if (!posted) throw new Error('generic posted line-write fixture missing');

      await fixture.client.moveToAccount(posted, '4', ['17']);

      const undone = await fixture.client.fetchTxn(qboType, fixture.qboId);
      const snapshot = await fixture.client.fetchLineWriteSnapshot(
        qboType,
        fixture.qboId,
      );
      if (!undone || !snapshot) {
        throw new Error('generic undone line-write fixture missing');
      }
      expect(undone.raw).toMatchObject({
        Id: fixture.qboId,
        SyncToken: '9',
      });
      const rawLines = (undone.raw as { Line: Record<string, unknown>[] }).Line;
      const accountOf = (line: Record<string, unknown>): string | undefined => {
        const detail = qboType === 'Deposit'
          ? line.DepositLineDetail
          : line.JournalEntryLineDetail;
        return (
          detail as { AccountRef?: { value?: string } } | undefined
        )?.AccountRef?.value;
      };
      expect(rawLines.some((line) => accountOf(line) === '4')).toBe(true);
      expect(rawLines.some((line) => accountOf(line) === '17')).toBe(false);
      const reprepare = await fixture.client.prepareLineRecategorization(
        undone,
        [{ amount: undone.amount, accountQboId: '17' }],
        'request-2',
      );
      expect(reprepare.before).toEqual(snapshot);
      expect(reprepare.expected.contentHash).not.toBe(snapshot.contentHash);

      const persisted = structuredClone(fixture.realm);
      resetMockRealms();
      const freshRealm = getMockRealm(MOCK_REALM_HARBOR);
      Object.assign(
        freshRealm,
        mergePersistedMockRealm(freshRealm, persisted),
      );
      const hydratedClient = new MockQboClient(MOCK_REALM_HARBOR, ['4']);
      await expect(
        hydratedClient.fetchLineWriteSnapshot(qboType, fixture.qboId),
      ).resolves.toEqual(snapshot);
      const hydrated = await hydratedClient.fetchTxn(qboType, fixture.qboId);
      if (!hydrated) throw new Error('generic hydrated line-write fixture missing');
      await expect(
        hydratedClient.prepareLineRecategorization(
          hydrated,
          [{ amount: hydrated.amount, accountQboId: '17' }],
          'request-3',
        ),
      ).resolves.toMatchObject({ before: snapshot });
    },
  );

  it('returns null for a missing line-write snapshot', async () => {
    await expect(
      client().fetchLineWriteSnapshot('JournalEntry', 'MISSING_GENERIC'),
    ).resolves.toBeNull();
  });
});

describe('MockQboClient prepared Purchase writes', () => {
  it('shares exact prepare, replacement, readback, and restore semantics', async () => {
    const realm = getMockRealm(MOCK_REALM_HARBOR);
    realm.accounts.push(
      {
        qboId: 'ACCOUNT_HOLDING_GENERIC',
        name: 'Generic Holding',
        classification: 'Other',
        accountType: 'Other Current Asset',
        fullName: 'Generic Holding',
      },
      {
        qboId: 'ACCOUNT_CATEGORY_GENERIC',
        name: 'Generic Category',
        classification: 'Expenses',
        accountType: 'Expense',
        fullName: 'Expenses:Generic Category',
      },
      {
        qboId: 'ACCOUNT_PAYMENT_GENERIC',
        name: 'Generic Payment',
        classification: 'Bank',
        accountType: 'Bank',
        fullName: 'Generic Payment',
      },
      {
        qboId: 'ACCOUNT_UNTOUCHED_GENERIC',
        name: 'Generic Untouched',
        classification: 'Expenses',
        accountType: 'Expense',
        fullName: 'Expenses:Generic Untouched',
      },
    );
    realm.taxProfile = { usingSalesTax: true, partnerTaxEnabled: false };
    realm.taxRates.push({
      qboId: 'TAX_RATE_STANDARD',
      name: 'Generic standard rate',
      description: null,
      active: true,
      rateValue: 5,
      sourceUpdatedAt: null,
    });
    realm.taxCodes.push(
      {
        qboId: 'TAX_CODE_STANDARD',
        name: 'Generic standard code',
        description: null,
        active: true,
        taxable: true,
        purchaseRates: [{
          taxRateQboId: 'TAX_RATE_STANDARD',
          taxTypeApplicable: 'TaxOnAmount',
        }],
        sourceUpdatedAt: null,
      },
      {
        qboId: 'TAX_CODE_OLD_GENERIC',
        name: 'Generic previous code',
        description: null,
        active: true,
        taxable: true,
        purchaseRates: [{
          taxRateQboId: 'TAX_RATE_STANDARD',
          taxTypeApplicable: 'TaxOnAmount',
        }],
        sourceUpdatedAt: null,
      },
    );
    realm.txns.push({
      qboId: 'PURCHASE_GENERIC',
      qboType: 'Purchase',
      syncToken: 7,
      date: '2026-07-01',
      payee: 'Generic Entity',
      memo: 'generic private note',
      amount: -15,
      bankAccountQboId: 'ACCOUNT_PAYMENT_GENERIC',
      lines: [
        { id: 'LINE_HOLDING_GENERIC', amount: 10, accountQboId: 'ACCOUNT_HOLDING_GENERIC' },
        { id: '1000', amount: 5, accountQboId: 'ACCOUNT_UNTOUCHED_GENERIC' },
      ],
      lastUpdated: '2026-07-01T00:00:00.000Z',
    });
    const raw: RawPurchase = {
      Id: 'PURCHASE_GENERIC',
      SyncToken: '7',
      TxnDate: '2026-07-01',
      TotalAmt: 15,
      PaymentType: 'CreditCard',
      DocNumber: 'DOC_GENERIC',
      PrivateNote: 'generic private note',
      EntityRef: {
        value: 'ENTITY_GENERIC',
        name: 'Generic Entity',
        referenceKind: 'GenericVendor',
      },
      AccountRef: { value: 'ACCOUNT_PAYMENT_GENERIC', name: 'Generic Payment' },
      CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' },
      ExchangeRate: 1.25,
      DepartmentRef: { value: 'DEPARTMENT_GENERIC', name: 'Generic Department' },
      CustomDocumentProperty: { preserve: true },
      MetaData: { CreateTime: '2026-07-01T00:00:00Z' },
      GlobalTaxCalculation: 'TaxInclusive',
      TxnTaxDetail: { TotalTax: 0.75 },
      Line: [
        {
          Id: 'LINE_HOLDING_GENERIC',
          Amount: 10,
          DetailType: 'AccountBasedExpenseLineDetail',
          Description: 'generic holding',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'ACCOUNT_HOLDING_GENERIC', name: 'Generic Holding' },
            CustomerRef: { value: 'CUSTOMER_OLD_GENERIC', name: 'Generic Customer' },
            ClassRef: { value: 'CLASS_OLD_GENERIC', name: 'Generic Class' },
            TaxCodeRef: { value: 'TAX_CODE_OLD_GENERIC' },
            TaxAmount: 0.5,
            TaxInclusiveAmt: 10,
          },
        },
        {
          Id: '1000',
          Amount: 5,
          DetailType: 'AccountBasedExpenseLineDetail',
          Description: 'generic untouched',
          AccountBasedExpenseLineDetail: {
            AccountRef: {
              value: 'ACCOUNT_UNTOUCHED_GENERIC',
              name: 'Generic Untouched',
            },
            CustomerRef: {
              value: 'CUSTOMER_UNTOUCHED_GENERIC',
              name: 'Generic Customer',
            },
            ClassRef: { value: 'CLASS_UNTOUCHED_GENERIC', name: 'Generic Class' },
            TaxCodeRef: { value: 'TAX_CODE_STANDARD' },
            TaxAmount: 0.25,
          },
          CustomField: [{ Name: 'Generic field', StringValue: 'preserve me' }],
          UnknownLineProperty: { preserve: true },
        },
      ],
    };
    realm.rawPurchases.push(structuredClone(raw));
    const before = {
      qboId: 'PURCHASE_GENERIC',
      syncToken: '7',
      totalCents: -1_500,
      accountQboId: 'ACCOUNT_PAYMENT_GENERIC',
      date: '2026-07-01',
      direction: 'purchase',
      globalTaxCalculation: 'TaxInclusive',
      totalTaxCents: -75,
      lines: [
        {
          id: 'LINE_HOLDING_GENERIC',
          amountCents: -1_000,
          description: 'generic holding',
          accountQboId: 'ACCOUNT_HOLDING_GENERIC',
          customerQboId: 'CUSTOMER_OLD_GENERIC',
          classQboId: 'CLASS_OLD_GENERIC',
          taxCodeQboId: 'TAX_CODE_OLD_GENERIC',
          taxAmountCents: -50,
          taxInclusiveCents: -1_000,
        },
        {
          id: '1000',
          amountCents: -500,
          description: 'generic untouched',
          accountQboId: 'ACCOUNT_UNTOUCHED_GENERIC',
          customerQboId: 'CUSTOMER_UNTOUCHED_GENERIC',
          classQboId: 'CLASS_UNTOUCHED_GENERIC',
          taxCodeQboId: 'TAX_CODE_STANDARD',
          taxAmountCents: -25,
          taxInclusiveCents: null,
        },
      ],
    } as const;
    realm.purchaseSnapshots.push(structuredClone(before));
    const staged = {
      transactionId: '00000000-0000-4000-8000-000000000001',
      revision: 2,
      taxCalculation: 'TaxInclusive',
      totals: { subtotalCents: -952, taxCents: -48, totalCents: -1_000 },
      lines: [{
        idx: 0,
        subtotalCents: -952,
        taxCents: -48,
        totalCents: -1_000,
        categoryQboId: 'ACCOUNT_CATEGORY_GENERIC',
        taxCodeQboId: 'TAX_CODE_STANDARD',
        memo: 'generic memo',
      }],
      tagIds: [],
    } satisfies StagedCategorization;
    const c = new MockQboClient(MOCK_REALM_HARBOR, ['ACCOUNT_HOLDING_GENERIC']);
    const current = await c.fetchTxn('Purchase', 'PURCHASE_GENERIC');
    if (!current) throw new Error('generic fixture missing');
    expect(current.raw).toEqual(raw);

    const prepared = await c.preparePurchaseRecategorization(
      current,
      staged,
      structuredClone(before),
      'REQUEST_GENERIC',
    );
    expect(prepared.body).toMatchObject({
      PaymentType: raw.PaymentType,
      DocNumber: raw.DocNumber,
      PrivateNote: raw.PrivateNote,
      EntityRef: raw.EntityRef,
      AccountRef: raw.AccountRef,
      CurrencyRef: raw.CurrencyRef,
      ExchangeRate: raw.ExchangeRate,
      DepartmentRef: raw.DepartmentRef,
      CustomDocumentProperty: raw.CustomDocumentProperty,
      MetaData: raw.MetaData,
    });
    expect(prepared.body.Line![0]).toEqual(raw.Line![1]);
    const tamperedExpected = {
      ...prepared,
      expected: { ...prepared.expected, totalTaxCents: -9_999 },
    };
    await expect(c.sendPreparedWrite(tamperedExpected)).resolves.toEqual({
      ok: true,
      newSyncToken: '8',
    });
    await expect(c.fetchPurchaseSnapshot('PURCHASE_GENERIC')).resolves.toEqual({
      qboId: prepared.expected.qboId,
      syncToken: '8',
      totalCents: prepared.expected.totalCents,
      accountQboId: prepared.expected.accountQboId,
      date: prepared.expected.date,
      direction: prepared.expected.direction,
      globalTaxCalculation: prepared.expected.globalTaxCalculation,
      totalTaxCents: prepared.expected.totalTaxCents,
      lines: [
        before.lines[1],
        { ...prepared.expected.targetLines[0], id: '1001' },
      ],
    });

    const posted = await c.fetchTxn('Purchase', 'PURCHASE_GENERIC');
    if (!posted) throw new Error('generic posted fixture missing');
    const expectedPostedRaw: RawPurchase = {
      ...prepared.body,
      SyncToken: '8',
      Line: [
        prepared.body.Line![0]!,
        { ...prepared.body.Line![1]!, Id: '1001' },
      ],
    };
    expect(posted.raw).toEqual(expectedPostedRaw);
    const persistedRealm = structuredClone(realm);
    const hydrated = mergePersistedMockRealm(
      { ...structuredClone(realm), rawPurchases: [] } as never,
      persistedRealm,
    ) as typeof realm & { rawPurchases: RawPurchase[] };
    expect(
      hydrated.rawPurchases.find((candidate) => candidate.Id === expectedPostedRaw.Id),
    ).toEqual(expectedPostedRaw);
    const restore = await c.preparePurchaseRestore(posted, prepared, 'REQUEST_RESTORE_GENERIC');
    await expect(c.sendPreparedWrite(restore)).resolves.toEqual({ ok: true, newSyncToken: '9' });
    await expect(c.fetchPurchaseSnapshot('PURCHASE_GENERIC')).resolves.toEqual({
      ...before,
      syncToken: '9',
    });
  });

  it('rejects a stale prepared body before mutating mock state', async () => {
    const realm = getMockRealm(MOCK_REALM_HARBOR);
    const existing = realm.txns.find((txn) => txn.qboType === 'Purchase');
    if (!existing) throw new Error('mock fixture missing');
    const c = client();
    await expect(c.sendPreparedWrite({
      operation: 'recategorize',
      qboType: 'Purchase',
      qboId: existing.qboId,
      requestId: 'REQUEST_GENERIC',
      requestHash: 'hash-generic',
      body: { Id: existing.qboId, SyncToken: '999', Line: [] },
      before: {} as never,
      expected: {} as never,
    })).rejects.toThrow(/SyncToken conflict/);
    expect(existing.syncToken).toBe(0);
  });
});
