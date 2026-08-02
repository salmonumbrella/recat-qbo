// Multi-line entity safety (C1): mapping exposes ONLY holding-account lines
// with amount = the holding-line sum, and the write-side rebuild replaces only
// those lines — everything else on the entity survives verbatim.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { QboAuthError } from './types.js';
import {
  RealQboClient,
  exchangeAuthCode,
  mapDeposit,
  mapJournalEntry,
  mapPurchase,
  mapPurchaseSnapshot,
  mapTaxCode,
  mapTaxProfile,
  mapTaxRate,
  parseStatementReport,
  parseTransactionListReport,
  rebuildDepositLines,
  rebuildJournalEntryLines,
  rebuildPurchaseLines,
  sumLinesPostingTo,
  type RawDeposit,
  type RawJournalEntry,
  type RawPurchase,
  type RawReport,
} from './real.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OAuth token errors', () => {
  it('uses a typed reason and omits the upstream body from token endpoint errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'invalid_client',
            error_description: 'bad secret SECRET_SENTINEL',
          }),
          { status: 401 },
        ),
      ),
    );

    const error = await exchangeAuthCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://recat.example/qbo/callback',
      code: 'auth-code',
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(QboAuthError);
    expect(error).toMatchObject({ reason: 'INVALID_CLIENT_CREDENTIALS' });
    expect((error as Error).message).not.toContain('SECRET_SENTINEL');
  });

  it('maps fetch failures to Intuit unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const error = await exchangeAuthCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://recat.example/qbo/callback',
      code: 'auth-code',
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(QboAuthError);
    expect(error).toMatchObject({ reason: 'INTUIT_UNAVAILABLE' });
  });
});

function realClient(
  onTokensRefreshed = vi.fn(async () => undefined),
  holdingAccountQboIds: string[] = [],
) {
  return {
    client: new RealQboClient({
      realmId: 'realm/1',
      environment: 'sandbox',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokens: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      holdingAccountQboIds,
      onTokensRefreshed,
    }),
    onTokensRefreshed,
  };
}

describe('RealQboClient purchase-tax HTTP seam', () => {
  it('requests and normalizes valid and malformed tax profiles', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { Preferences: [{ TaxPrefs: { UsingSalesTax: true, PartnerTaxEnabled: false } }] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { Preferences: [{ TaxPrefs: { UsingSalesTax: 'yes' } }] },
      })));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = realClient();

    await expect(client.getTaxProfile()).resolves.toEqual({ usingSalesTax: true, partnerTaxEnabled: false });
    await expect(client.getTaxProfile()).resolves.toEqual({ usingSalesTax: null, partnerTaxEnabled: null });
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain(
      'select * from Preferences startposition 1 maxresults 1000',
    );
  });

  it.each([
    ['TaxCode', 'listTaxCodes', (index: number) => ({ Id: `C${index}`, Name: `Code ${index}`, Taxable: true })],
    ['TaxRate', 'listTaxRates', (index: number) => ({ Id: `R${index}`, Name: `Rate ${index}`, RateValue: 5 })],
  ] as const)('paginates %s queries and normalizes every page', async (entity, method, row) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { [entity]: Array.from({ length: 1_000 }, (_, index) => row(index)) },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { [entity]: [row(1_000)] },
      })));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = realClient();

    const result = await client[method]();

    expect(result).toHaveLength(1_001);
    expect(result[0]?.qboId).toBe(entity === 'TaxCode' ? 'C0' : 'R0');
    expect(result.at(-1)?.sourceUpdatedAt).toBeNull();
    expect(decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]))).toContain(
      `select * from ${entity} startposition 1001 maxresults 1000`,
    );
  });

  it('propagates a later tax-reference page failure', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: {
          TaxCode: Array.from({ length: 1_000 }, (_, index) => ({ Id: `C${index}`, Name: `Code ${index}` })),
        },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Fault: { Error: [{ Detail: 'later page sentinel' }] },
      }), { status: 500 })));

    await expect(realClient().client.listTaxCodes()).rejects.toThrow('later page sentinel');
  });

  it('reads a signed Purchase snapshot and returns null for a QBO not-found response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Purchase: {
          Id: 'P/1',
          SyncToken: '2',
          TotalAmt: 10,
          Line: [{ Amount: 10, AccountBasedExpenseLineDetail: { TaxAmount: 1 } }],
        },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Fault: { Error: [{ Detail: 'Object Not Found' }] },
      }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = realClient();

    await expect(client.fetchPurchaseSnapshot('P/1')).resolves.toMatchObject({
      qboId: 'P/1',
      direction: 'purchase',
      totalCents: -1_000,
      lines: [{ amountCents: -1_000, taxAmountCents: -100 }],
    });
    await expect(client.fetchPurchaseSnapshot('missing')).resolves.toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/purchase/P%2F1?minorversion=75');
  });

  it('refreshes once after a 401 and retries a tax-profile request', async () => {
    const onTokensRefreshed = vi.fn(async () => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'retry-access',
        refresh_token: 'retry-refresh',
        expires_in: 3600,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        QueryResponse: { Preferences: [{ TaxPrefs: { UsingSalesTax: true } }] },
      })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(realClient(onTokensRefreshed).client.getTaxProfile()).resolves.toMatchObject({ usingSalesTax: true });
    expect(onTokensRefreshed).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'retry-access' }));
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer retry-access' });
  });

  it('posts a complete non-tax Purchase recategorization payload without adding tax fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Purchase: { SyncToken: '4' },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const raw = twoLinePurchase();
    const txn = mapPurchase(raw, new Set(['4']));

    await expect(
      realClient(undefined, ['4']).client.recategorize(txn, [
        { amount: -100, accountQboId: '17', memo: 'client dinner' },
      ]),
    ).resolves.toEqual({ ok: true, newSyncToken: '4' });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/purchase?minorversion=75');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as RawPurchase;
    expect(body).toMatchObject({
      Id: raw.Id,
      AccountRef: raw.AccountRef,
      EntityRef: raw.EntityRef,
      SyncToken: txn.syncToken,
    });
    expect(body.Line?.[0]).toEqual(raw.Line?.[1]);
    expect(body.Line?.[1]).toMatchObject({
      Amount: 100,
      Description: 'client dinner',
      AccountBasedExpenseLineDetail: { AccountRef: { value: '17' } },
    });
    expect(JSON.stringify(body)).not.toMatch(/TaxCodeRef|TaxAmount|TaxInclusiveAmt/);
  });
});

const HOLDING = new Set(['4']);

describe('tax read normalization', () => {
  it('normalizes purchase rate components without retaining the raw response', () => {
    expect(
      mapTaxCode({
        Id: 'GST5',
        Name: 'GST 5%',
        Active: true,
        Taxable: true,
        PurchaseTaxRateList: {
          TaxRateDetail: [{ TaxRateRef: { value: 'RATE5' }, TaxTypeApplicable: 'TaxOnAmount' }],
        },
      }),
    ).toEqual({
      qboId: 'GST5',
      name: 'GST 5%',
      description: null,
      active: true,
      taxable: true,
      purchaseRates: [{ taxRateQboId: 'RATE5', taxTypeApplicable: 'TaxOnAmount' }],
      sourceUpdatedAt: null,
    });
  });

  it('rejects a malformed purchase component before it reaches the cache', () => {
    expect(() =>
      mapTaxCode({
        Id: 'GST-PST',
        Name: 'GST + PST',
        PurchaseTaxRateList: {
          TaxRateDetail: [
            { TaxRateRef: { value: 'GST5' }, TaxTypeApplicable: 'TaxOnAmount' },
            { TaxTypeApplicable: 'TaxOnTax' },
          ],
        },
      }),
    ).toThrow(/rate reference/i);
  });

  it('normalizes profile, rate, and purchase snapshot fields into safe values', () => {
    expect(mapTaxProfile({ TaxPrefs: { UsingSalesTax: true, PartnerTaxEnabled: false } })).toEqual({
      usingSalesTax: true,
      partnerTaxEnabled: false,
    });
    expect(
      mapTaxRate({ Id: 'RATE5', Name: 'GST', Description: 'Goods and services tax', Active: true, RateValue: 5 }),
    ).toEqual({
      qboId: 'RATE5',
      name: 'GST',
      description: 'Goods and services tax',
      active: true,
      rateValue: 5,
      sourceUpdatedAt: null,
    });
    expect(
      mapPurchaseSnapshot({
        Id: 'P-1',
        SyncToken: '7',
        TxnDate: '2026-07-27',
        TotalAmt: 105,
        Credit: true,
        AccountRef: { value: 'bank-1' },
        GlobalTaxCalculation: 'TaxInclusive',
        TxnTaxDetail: { TotalTax: 5 },
        Line: [
          {
            Id: '1',
            Amount: 105,
            Description: 'Lunch',
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: '17' },
              CustomerRef: { value: 'customer-1' },
              ClassRef: { value: 'class-1' },
              TaxCodeRef: { value: 'UNKNOWN-CODE' },
              TaxAmount: 5,
              TaxInclusiveAmt: 105,
            },
          },
        ],
      }),
    ).toEqual({
      qboId: 'P-1',
      syncToken: '7',
      totalCents: 10500,
      accountQboId: 'bank-1',
      date: '2026-07-27',
      direction: 'refund',
      globalTaxCalculation: 'TaxInclusive',
      totalTaxCents: 500,
      lines: [
        {
          id: '1',
          amountCents: 10500,
          description: 'Lunch',
          accountQboId: '17',
          customerQboId: 'customer-1',
          classQboId: 'class-1',
          taxCodeQboId: 'UNKNOWN-CODE',
          taxAmountCents: 500,
          taxInclusiveCents: 10500,
        },
      ],
    });
  });

  it('normalizes all purchase monetary fields as negative without double-inverting negative raw values', () => {
    expect(
      mapPurchaseSnapshot({
        Id: 'P-2',
        SyncToken: '1',
        TotalAmt: -105,
        Credit: false,
        TxnTaxDetail: { TotalTax: -5 },
        Line: [
          {
            Amount: -105,
            AccountBasedExpenseLineDetail: {
              TaxAmount: -5,
              TaxInclusiveAmt: -105,
            },
          },
        ],
      }),
    ).toMatchObject({
      totalCents: -10_500,
      direction: 'purchase',
      totalTaxCents: -500,
      lines: [
        {
          amountCents: -10_500,
          taxAmountCents: -500,
          taxInclusiveCents: -10_500,
        },
      ],
    });
  });

  it('preserves malformed tax preferences and rates as unavailable metadata', () => {
    expect(mapTaxProfile({ TaxPrefs: {} })).toEqual({
      usingSalesTax: null,
      partnerTaxEnabled: null,
    });
    expect(mapTaxProfile({ TaxPrefs: { UsingSalesTax: 'yes' } } as never).usingSalesTax).toBeNull();
    expect(mapTaxRate({ Id: 'MISSING', Name: 'Missing' }).rateValue).toBeNull();
    expect(mapTaxRate({ Id: 'NEGATIVE', Name: 'Negative', RateValue: -1 }).rateValue).toBeNull();
    expect(mapTaxRate({ Id: 'TOO_HIGH', Name: 'Too high', RateValue: 1_000 }).rateValue).toBeNull();
  });

  it('normalizes optional source timestamps and rejects malformed timestamps', () => {
    expect(
      mapTaxCode({
        Id: 'GST5',
        Name: 'GST 5%',
        MetaData: { LastUpdatedTime: '2026-07-27T09:10:11-07:00' },
      }).sourceUpdatedAt,
    ).toBe('2026-07-27T16:10:11.000Z');
    expect(mapTaxRate({ Id: 'RATE5', Name: 'GST' }).sourceUpdatedAt).toBeNull();
    expect(() =>
      mapTaxRate({
        Id: 'BROKEN',
        Name: 'Broken',
        MetaData: { LastUpdatedTime: 'not-a-timestamp' },
      }),
    ).toThrow(/source timestamp/i);
  });

  it.each(['false', 0, null])('rejects a present non-boolean Active value %j', (active) => {
    expect(() =>
      mapTaxCode({ Id: 'CODE', Name: 'Code', Active: active } as never),
    ).toThrow(/Active/i);
    expect(() =>
      mapTaxRate({ Id: 'RATE', Name: 'Rate', Active: active, RateValue: 5 } as never),
    ).toThrow(/Active/i);
  });

  it('defaults absent Active to true but rejects empty tax identities', () => {
    expect(mapTaxCode({ Id: 'CODE', Name: 'Code' }).active).toBe(true);
    expect(mapTaxRate({ Id: 'RATE', Name: 'Rate', RateValue: 5 }).active).toBe(true);
    expect(() => mapTaxCode({ Id: ' ', Name: 'Code' })).toThrow(/Id/i);
    expect(() => mapTaxRate({ Id: '', Name: 'Rate', RateValue: 5 })).toThrow(/Id/i);
    expect(() =>
      mapTaxCode({
        Id: 'CODE',
        Name: 'Code',
        PurchaseTaxRateList: {
          TaxRateDetail: [{ TaxRateRef: { value: '' }, TaxTypeApplicable: 'TaxOnAmount' }],
        },
      }),
    ).toThrow(/rate reference/i);
  });

  it.each([123, {}, '', 'not-a-timestamp'])(
    'rejects malformed source timestamp %j',
    (lastUpdatedTime) => {
      expect(() =>
        mapTaxRate({
          Id: 'RATE',
          Name: 'Rate',
          RateValue: 5,
          MetaData: { LastUpdatedTime: lastUpdatedTime },
        } as never),
      ).toThrow(/source timestamp/i);
    },
  );
});

/** Two-line purchase: $100 parked in holding + $50 already categorized. */
function twoLinePurchase(): RawPurchase {
  return {
    Id: '42',
    SyncToken: '3',
    TxnDate: '2026-07-01',
    TotalAmt: 150,
    EntityRef: { value: 'v1', name: 'COSTCO WHSE #1123' },
    AccountRef: { value: '1', name: 'Checking ·4821' },
    Line: [
      {
        Id: '1',
        Amount: 100,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: { AccountRef: { value: '4', name: 'Ask My Accountant' } },
      },
      {
        Id: '2',
        Amount: 50,
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: 'Shelf brackets',
        AccountBasedExpenseLineDetail: { AccountRef: { value: '19', name: 'Office supplies' } },
      },
    ],
  };
}

describe('mapPurchase (multi-line)', () => {
  it('amount is the holding-line sum, not TotalAmt', () => {
    const txn = mapPurchase(twoLinePurchase(), HOLDING);
    expect(txn.amount).toBe(-100); // NOT -150
  });

  it('lines contain only the holding-account lines', () => {
    const txn = mapPurchase(twoLinePurchase(), HOLDING);
    expect(txn.lines).toHaveLength(1);
    expect(txn.lines[0]).toMatchObject({ accountQboId: '4', amount: 100 });
  });

  it('keeps the natural sign for credits', () => {
    const txn = mapPurchase({ ...twoLinePurchase(), Credit: true }, HOLDING);
    expect(txn.amount).toBe(100);
  });

  it('maps an entity with no holding lines to zero amount and no lines', () => {
    const txn = mapPurchase(twoLinePurchase(), new Set(['999']));
    expect(txn.amount).toBe(-0);
    expect(txn.lines).toHaveLength(0);
  });
});

describe('rebuildPurchaseLines (multi-line write safety)', () => {
  it('replaces only holding lines; the categorized line survives verbatim and the total is unchanged', () => {
    const raw = twoLinePurchase();
    const rebuilt = rebuildPurchaseLines(raw, HOLDING, [
      { amount: -60, accountQboId: '17', memo: 'client dinner' },
      { amount: -40, accountQboId: '14' },
    ]);

    // The already-categorized $50 Office supplies line is untouched.
    const kept = rebuilt.find((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.value === '19');
    expect(kept).toEqual(raw.Line?.[1]);

    // No holding line remains; the new category lines are present.
    expect(rebuilt.some((l) => l.AccountBasedExpenseLineDetail?.AccountRef?.value === '4')).toBe(false);
    expect(rebuilt.filter((l) => ['17', '14'].includes(l.AccountBasedExpenseLineDetail?.AccountRef?.value ?? ''))).toHaveLength(2);

    // Entity total unchanged: 50 + 60 + 40 = 150.
    const total = rebuilt.reduce((a, l) => a + (l.Amount ?? 0), 0);
    expect(total).toBeCloseTo(150, 2);
  });

  it('does not add tax fields to existing categorization payload lines', () => {
    const rebuilt = rebuildPurchaseLines(twoLinePurchase(), HOLDING, [
      { amount: -100, accountQboId: '17', memo: 'client dinner' },
    ]);
    const detail = rebuilt.find(
      (line) => line.AccountBasedExpenseLineDetail?.AccountRef?.value === '17',
    )?.AccountBasedExpenseLineDetail;

    expect(detail).toEqual({ AccountRef: { value: '17' } });
    expect(detail).not.toHaveProperty('TaxCodeRef');
    expect(detail).not.toHaveProperty('TaxAmount');
    expect(detail).not.toHaveProperty('TaxInclusiveAmt');
  });
});

describe('rebuildDepositLines', () => {
  const deposit: RawDeposit = {
    Id: '7',
    SyncToken: '0',
    TotalAmt: 300,
    DepositToAccountRef: { value: '1', name: 'Checking ·4821' },
    Line: [
      {
        Id: '1',
        Amount: 200,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: '4', name: 'Ask My Accountant' }, Entity: { value: 'c9', name: 'Square' } },
      },
      {
        Id: '2',
        Amount: 100,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: { AccountRef: { value: '7', name: 'Sales — food' } },
      },
    ],
  };

  it('keeps non-holding lines, preserves the payer Entity, and keeps the total', () => {
    const rebuilt = rebuildDepositLines(deposit, HOLDING, [{ amount: 200, accountQboId: '8' }]);
    expect(rebuilt.find((l) => l.DepositLineDetail?.AccountRef?.value === '7')).toEqual(deposit.Line?.[1]);
    const newLine = rebuilt.find((l) => l.DepositLineDetail?.AccountRef?.value === '8');
    expect(newLine?.DepositLineDetail?.Entity).toEqual({ value: 'c9', name: 'Square' });
    expect(rebuilt.reduce((a, l) => a + (l.Amount ?? 0), 0)).toBeCloseTo(300, 2);
  });

  it('mapDeposit amount is the holding-line sum', () => {
    expect(mapDeposit(deposit, HOLDING).amount).toBe(200);
  });
});

describe('rebuildJournalEntryLines', () => {
  const je: RawJournalEntry = {
    Id: '11',
    SyncToken: '0',
    Line: [
      {
        Id: '1',
        Amount: 80,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '4', name: 'Ask My Accountant' } },
      },
      {
        Id: '2',
        Amount: 20,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '23', name: 'Rent' } },
      },
      {
        Id: '3',
        Amount: 100,
        DetailType: 'JournalEntryLineDetail',
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '1', name: 'Checking ·4821' } },
      },
    ],
  };

  it('replaces only the holding Debit line; other Debits and all Credits survive', () => {
    const rebuilt = rebuildJournalEntryLines(je, HOLDING, [{ amount: -80, accountQboId: '17' }]);
    expect(rebuilt.find((l) => l.JournalEntryLineDetail?.AccountRef?.value === '23')).toEqual(je.Line?.[1]);
    expect(rebuilt.find((l) => l.JournalEntryLineDetail?.PostingType === 'Credit')).toEqual(je.Line?.[2]);
    expect(rebuilt.some((l) => l.JournalEntryLineDetail?.AccountRef?.value === '4')).toBe(false);
    // Debits still balance the credit: 20 + 80 = 100.
    const debits = rebuilt
      .filter((l) => l.JournalEntryLineDetail?.PostingType === 'Debit')
      .reduce((a, l) => a + (l.Amount ?? 0), 0);
    expect(debits).toBeCloseTo(100, 2);
  });

  it('mapJournalEntry amount is minus the holding-debit sum', () => {
    expect(mapJournalEntry(je, HOLDING).amount).toBe(-80);
  });
});

describe('sumLinesPostingTo', () => {
  it('sums only the raw lines posting to the given accounts', () => {
    const txn = mapPurchase(twoLinePurchase(), HOLDING);
    expect(sumLinesPostingTo(txn, new Set(['19']))).toBe(50);
    expect(sumLinesPostingTo(txn, new Set(['4']))).toBe(100);
    expect(sumLinesPostingTo(txn, new Set(['999']))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reports API parsing — Intuit report JSON → normalized QboStatement /
// account-transaction rows. Fixtures follow the documented Rows/Columns shape
// (Section rows with Header/Summary, nested Rows.Row, ColData value+id).
// ---------------------------------------------------------------------------

const plReport: RawReport = {
  Columns: {
    Column: [
      { ColTitle: '', ColType: 'Account' },
      { ColTitle: 'Total', ColType: 'Money' },
    ],
  },
  Rows: {
    Row: [
      {
        type: 'Section',
        group: 'Income',
        Header: { ColData: [{ value: 'Income' }, { value: '' }] },
        Rows: {
          Row: [
            { type: 'Data', ColData: [{ value: 'Sales — food', id: '7' }, { value: '4200.00' }] },
            { type: 'Data', ColData: [{ value: 'Sales — beverage', id: '8' }, { value: '1,150.50' }] },
          ],
        },
        Summary: { ColData: [{ value: 'Total Income' }, { value: '5350.50' }] },
      },
      {
        type: 'Section',
        group: 'COGS',
        Header: { ColData: [{ value: 'Cost of Goods Sold' }, { value: '' }] },
        Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Food purchases', id: '10' }, { value: '900.00' }] }] },
        Summary: { ColData: [{ value: 'Total Cost of Goods Sold' }, { value: '900.00' }] },
      },
      { type: 'Section', group: 'GrossProfit', Summary: { ColData: [{ value: 'Gross Profit' }, { value: '4450.50' }] } },
      {
        type: 'Section',
        group: 'Expenses',
        Header: { ColData: [{ value: 'Expenses' }, { value: '' }] },
        Rows: {
          Row: [
            { type: 'Data', ColData: [{ value: 'Rent', id: '23' }, { value: '1800.00' }] },
            {
              // nested sub-account section — QBO nests Rows.Row arbitrarily deep
              type: 'Section',
              Header: { ColData: [{ value: 'Payroll' }, { value: '' }] },
              Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Payroll wages', id: '20' }, { value: '2100.00' }] }] },
              Summary: { ColData: [{ value: 'Total Payroll' }, { value: '2100.00' }] },
            },
          ],
        },
        Summary: { ColData: [{ value: 'Total Expenses' }, { value: '3900.00' }] },
      },
      { type: 'Section', group: 'NetIncome', Summary: { ColData: [{ value: 'Net Income' }, { value: '550.50' }] } },
    ],
  },
};

describe('parseStatementReport', () => {
  it('maps a realistic P&L body to the normalized statement tree', () => {
    const stmt = parseStatementReport(plReport);
    expect(stmt.columns).toEqual([{ label: 'Total' }]);
    expect(
      stmt.rows.map((r) => ({ label: r.label, kind: r.kind, indent: r.indent, id: r.accountQboId, v: r.values })),
    ).toEqual([
      { label: 'Income', kind: 'head', indent: false, id: undefined, v: [] },
      { label: 'Sales — food', kind: 'line', indent: true, id: '7', v: [4200] },
      { label: 'Sales — beverage', kind: 'line', indent: true, id: '8', v: [1150.5] },
      { label: 'Total Income', kind: 'total', indent: false, id: undefined, v: [5350.5] },
      { label: 'Cost of Goods Sold', kind: 'head', indent: false, id: undefined, v: [] },
      { label: 'Food purchases', kind: 'line', indent: true, id: '10', v: [900] },
      { label: 'Total Cost of Goods Sold', kind: 'total', indent: false, id: undefined, v: [900] },
      { label: 'Gross Profit', kind: 'grand', indent: false, id: undefined, v: [4450.5] },
      { label: 'Expenses', kind: 'head', indent: false, id: undefined, v: [] },
      { label: 'Rent', kind: 'line', indent: true, id: '23', v: [1800] },
      { label: 'Payroll', kind: 'head', indent: true, id: undefined, v: [] },
      { label: 'Payroll wages', kind: 'line', indent: true, id: '20', v: [2100] },
      { label: 'Total Payroll', kind: 'total', indent: false, id: undefined, v: [2100] },
      { label: 'Total Expenses', kind: 'total', indent: false, id: undefined, v: [3900] },
      { label: 'Net Income', kind: 'grand', indent: false, id: undefined, v: [550.5] },
    ]);
  });

  it('marks top-level balance-sheet section summaries as grand rows', () => {
    const bs: RawReport = {
      Columns: {
        Column: [
          { ColTitle: '', ColType: 'Account' },
          { ColTitle: 'Total', ColType: 'Money' },
        ],
      },
      Rows: {
        Row: [
          {
            type: 'Section',
            group: 'TotalAssets',
            Header: { ColData: [{ value: 'ASSETS' }, { value: '' }] },
            Rows: { Row: [{ type: 'Data', ColData: [{ value: 'Checking', id: '1' }, { value: '12400.00' }] }] },
            Summary: { ColData: [{ value: 'Total ASSETS' }, { value: '12400.00' }] },
          },
        ],
      },
    };
    const stmt = parseStatementReport(bs);
    expect(stmt.rows[2]).toEqual({ label: 'Total ASSETS', kind: 'grand', indent: false, values: [12400] });
  });

  it('tolerates empty / missing pieces (defensive parsing)', () => {
    expect(parseStatementReport({})).toEqual({ columns: [], rows: [] });
    const weird: RawReport = {
      Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Total' }] },
      Rows: { Row: [{ type: 'Data', ColData: [{ value: 'No id row' }, { value: 'n/a' }] }] },
    };
    expect(parseStatementReport(weird).rows).toEqual([
      { label: 'No id row', kind: 'line', indent: true, values: [0] },
    ]);
  });
});

describe('parseTransactionListReport', () => {
  const txnList: RawReport = {
    Columns: {
      Column: [
        { ColTitle: 'Date', ColType: 'tx_date' },
        { ColTitle: 'Transaction Type', ColType: 'txn_type' },
        { ColTitle: 'Name', ColType: 'name' },
        { ColTitle: 'Memo/Description', ColType: 'memo' },
        { ColTitle: 'Amount', ColType: 'subt_nat_amount' },
      ],
    },
    Rows: {
      Row: [
        {
          type: 'Data',
          ColData: [
            { value: '2026-07-05', id: '6' },
            { value: 'Expense' },
            { value: 'WEBFLOW.COM' },
            { value: '' },
            { value: '-29.00' },
          ],
        },
        {
          type: 'Data',
          ColData: [
            { value: '2026-07-11', id: '11' },
            { value: 'Expense' },
            { value: 'ULINE SHIP SUPPLIES' },
            { value: 'Boxes' },
            { value: '-212.06' },
          ],
        },
        {
          type: 'Section',
          group: 'GrandTotal',
          Summary: {
            ColData: [{ value: 'Grand Total' }, { value: '' }, { value: '' }, { value: '' }, { value: '-241.06' }],
          },
        },
      ],
    },
  };

  it('maps data rows via the report column metadata and skips summary rows', () => {
    expect(parseTransactionListReport(txnList)).toEqual([
      { date: '2026-07-05', payee: 'WEBFLOW.COM', amount: -29, txnType: 'Expense', qboId: '6' },
      { date: '2026-07-11', payee: 'ULINE SHIP SUPPLIES', memo: 'Boxes', amount: -212.06, txnType: 'Expense', qboId: '11' },
    ]);
  });

  it('flattens grouped sections and returns [] for an empty report', () => {
    const grouped: RawReport = { Columns: txnList.Columns, Rows: { Row: [{ type: 'Section', Rows: txnList.Rows }] } };
    expect(parseTransactionListReport(grouped)).toHaveLength(2);
    expect(parseTransactionListReport({})).toEqual([]);
  });
});
