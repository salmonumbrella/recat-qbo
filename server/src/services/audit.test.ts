import { describe, expect, it, vi } from 'vitest';
import type { AuditEntryDto } from '@recat/shared';
import {
  AUDIT_CSV_HEADER,
  buildAuditCsv,
  csvEscape,
  decorateAuditEntriesWithUndo,
  writeAudit,
} from './audit.js';

function entry(overrides: Partial<AuditEntryDto> = {}): AuditEntryDto {
  return {
    id: 'a1',
    companyId: 'c1',
    at: '2026-07-15T12:00:00.000Z',
    actor: 'Josh',
    payee: 'Staples',
    amount: -42.5,
    action: 'posted',
    before: 'Uncategorized Expense',
    after: 'Office Supplies',
    ...overrides,
  };
}

describe('csvEscape', () => {
  it('passes plain values through untouched', () => {
    expect(csvEscape('Office Supplies')).toBe('Office Supplies');
  });

  it('quotes values containing commas', () => {
    expect(csvEscape('Meals, Entertainment')).toBe('"Meals, Entertainment"');
  });

  it('doubles embedded quotes and wraps in quotes', () => {
    expect(csvEscape('Bob "The Builder" LLC')).toBe('"Bob ""The Builder"" LLC"');
  });

  it('quotes values containing newlines', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('line1\r\nline2')).toBe('"line1\r\nline2"');
  });
});

describe('buildAuditCsv', () => {
  it('emits the exact required header', () => {
    const csv = buildAuditCsv([]);
    expect(csv.split('\n')[0]).toBe('When,Who,Transaction,Amount,Action,Before,After');
    expect(AUDIT_CSV_HEADER).toBe('When,Who,Transaction,Amount,Action,Before,After');
  });

  it('formats a row with a fixed two-decimal amount', () => {
    const csv = buildAuditCsv([entry()]);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('2026-07-15T12:00:00.000Z,Josh,Staples,-42.50,posted,Uncategorized Expense,Office Supplies');
  });

  it('escapes payees with commas and quotes so columns stay aligned', () => {
    const csv = buildAuditCsv([entry({ payee: 'Acme, "Inc."', after: 'Meals, 50% deductible' })]);
    const row = csv.trimEnd().split('\n')[1] as string;
    expect(row).toBe(
      '2026-07-15T12:00:00.000Z,Josh,"Acme, ""Inc.""",-42.50,posted,Uncategorized Expense,"Meals, 50% deductible"',
    );
  });

  it('keeps one line per entry even when a field contains a newline', () => {
    const csv = buildAuditCsv([entry({ after: 'Split:\nOffice / Meals' })]);
    // Quoted newline stays inside the quoted field; naive line count is header + 2
    // but a CSV parser sees exactly one record. Assert the quoting is present.
    expect(csv).toContain('"Split:\nOffice / Meals"');
  });
});

describe('decorateAuditEntriesWithUndo', () => {
  it('offers durable undo only on the latest current verified categorization write', () => {
    const current = entry({
      id: 'audit-current',
      at: '2026-07-28T11:59:59.000Z',
      payload: {
        requestId: 'request-current',
        outcome: 'VERIFIED',
        references: { operation: 'recategorize' },
      },
    });
    const older = entry({ id: 'audit-older', at: '2026-07-20T12:00:00.000Z' });

    const decorated = decorateAuditEntriesWithUndo(
      [current, older],
      [{ id: 'transaction-generic', status: 'POSTED', postedAt: new Date('2026-07-28T12:00:00.000Z') }],
      [{ id: 'audit-current', txnId: 'transaction-generic', payload: current.payload }],
      new Date('2026-07-29T12:00:00.000Z'),
    );

    expect(decorated[0]).toMatchObject({
      transactionId: 'transaction-generic',
      undo: { kind: 'categorization' },
    });
    expect(decorated[1]?.undo).toBeUndefined();
  });

  it('offers legacy undo for a current legacy post and none after the window', () => {
    const legacy = entry({ id: 'audit-legacy', transactionId: 'transaction-legacy' });
    const available = decorateAuditEntriesWithUndo(
      [legacy],
      [{ id: 'transaction-legacy', status: 'POSTED', postedAt: new Date('2026-07-15T12:00:00.000Z') }],
      [{ id: 'audit-legacy', txnId: 'transaction-legacy', payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    );
    const expired = decorateAuditEntriesWithUndo(
      [legacy],
      [{ id: 'transaction-legacy', status: 'POSTED', postedAt: new Date('2026-06-01T12:00:00.000Z') }],
      [{ id: 'audit-legacy', txnId: 'transaction-legacy', payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    );

    expect(available[0]?.undo).toEqual({ kind: 'legacy' });
    expect(expired[0]?.undo).toBeUndefined();
  });

  it('offers legacy requeue for the latest dry-run outcome', () => {
    const dryRun = entry({
      id: 'audit-dry-run',
      action: 'dry-run',
      transactionId: 'transaction-dry-run',
    });
    const [decorated] = decorateAuditEntriesWithUndo(
      [dryRun],
      [{
        id: 'transaction-dry-run',
        status: 'DRY_RUN',
        postedAt: new Date('2026-07-15T12:00:00.000Z'),
      }],
      [{ id: 'audit-dry-run', txnId: 'transaction-dry-run', payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    );

    expect(decorated?.undo).toEqual({ kind: 'legacy' });
  });

  it('does not offer undo when QuickBooks is no longer in the posted state', () => {
    const posted = entry({ id: 'audit-post', transactionId: 'transaction-generic' });
    const [decorated] = decorateAuditEntriesWithUndo(
      [posted],
      [{ id: 'transaction-generic', status: 'REVERTED', postedAt: new Date('2026-07-15T12:00:00.000Z') }],
      [{ id: 'audit-post', txnId: 'transaction-generic', payload: null }],
      new Date('2026-07-16T12:00:00.000Z'),
    );

    expect(decorated?.undo).toBeUndefined();
  });
});

describe('writeAudit mutation metadata', () => {
  it('stores only bounded normalized references, request ID, and outcome', async () => {
    const create = vi.fn(async () => undefined);
    await writeAudit(
      { auditEntry: { create } } as never,
      {
        companyId: 'company-generic',
        actorId: 'actor-generic',
        actorLabel: 'Generic User',
        txnId: 'transaction-generic',
        payee: 'Generic Supplier',
        amount: -10.5,
        action: 'posted',
        before: 'Holding',
        after: 'Prepared purchase',
        payload: {
          accessToken: 'must-not-survive',
          body: { secret: 'must-not-survive' },
        },
        mutation: {
          requestId: ' request-generic ',
          outcome: 'VERIFIED',
          references: {
            operation: 'recategorize',
            qboType: 'Purchase',
            qboId: ' purchase-generic ',
            accountQboIds: ['expense-b', 'expense-a', 'expense-a'],
            taxCodeQboIds: ['tax-generic'],
          },
        },
      },
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: {
          requestId: 'request-generic',
          outcome: 'VERIFIED',
          references: {
            operation: 'recategorize',
            qboType: 'Purchase',
            qboId: 'purchase-generic',
            accountQboIds: ['expense-a', 'expense-b'],
            taxCodeQboIds: ['tax-generic'],
          },
        },
      }),
    });
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toMatch(
      /accessToken|must-not-survive|secret|SyncToken|beforeSnapshot|requestPayload/,
    );
  });

  it('truncates references to 128 characters and caps each reference list at 50', async () => {
    const create = vi.fn(async () => undefined);
    const longReference = `reference-${'x'.repeat(200)}`;
    await writeAudit(
      { auditEntry: { create } } as never,
      {
        companyId: 'company-generic',
        actorLabel: 'Generic User',
        payee: 'Generic Supplier',
        amount: -10.5,
        action: 'posted',
        before: 'Holding',
        after: 'Prepared purchase',
        mutation: {
          requestId: `request-${'r'.repeat(200)}`,
          outcome: 'VERIFIED',
          references: {
            operation: 'recategorize',
            qboType: 'Purchase',
            qboId: longReference,
            accountQboIds: Array.from(
              { length: 60 },
              (_value, index) => `${String(index).padStart(2, '0')}-${longReference}`,
            ),
            taxCodeQboIds: Array.from(
              { length: 55 },
              (_value, index) => `${String(index).padStart(2, '0')}-tax-${'t'.repeat(180)}`,
            ),
          },
        },
      },
    );

    const payload = create.mock.calls[0]?.[0].data.payload as {
      requestId: string;
      references: {
        qboId: string;
        accountQboIds: string[];
        taxCodeQboIds: string[];
      };
    };
    expect(payload.requestId).toHaveLength(128);
    expect(payload.references.qboId).toHaveLength(128);
    expect(payload.references.accountQboIds).toHaveLength(50);
    expect(payload.references.taxCodeQboIds).toHaveLength(50);
    expect(payload.references.accountQboIds.every((reference) => reference.length <= 128)).toBe(true);
    expect(payload.references.taxCodeQboIds.every((reference) => reference.length <= 128)).toBe(true);
  });

  it('stores only bounded MCP operation attribution and excludes raw proof or prepared data', async () => {
    const create = vi.fn(async () => undefined);
    await writeAudit(
      { auditEntry: { create } } as never,
      {
        companyId: 'company-generic',
        actorId: 'actor-generic',
        actorLabel: 'Generic User (MCP rct_example1)',
        txnId: 'transaction-generic',
        payee: 'Generic Supplier',
        amount: -10.5,
        action: 'reverted',
        before: 'Prepared purchase',
        after: 'QuickBooks Purchase',
        mutation: {
          requestId: 'undo-operation',
          outcome: 'VERIFIED',
          references: {
            operation: 'restore',
            qboType: 'Purchase',
            qboId: 'purchase-generic',
            accountQboIds: [],
            taxCodeQboIds: [],
          },
          mcp: {
            sourceOperationId: `source-${'s'.repeat(200)}`,
            operationId: `undo-${'o'.repeat(200)}`,
            tokenPrefix: `rct_${'p'.repeat(30)}`,
            sourcePreparedHash: 'must-not-survive',
            currentPostHash: 'must-not-survive',
            restoreHash: 'must-not-survive',
            body: { secret: 'must-not-survive' },
          } as never,
        },
      },
    );

    const payload = create.mock.calls[0]?.[0].data.payload as {
      mcp: {
        sourceOperationId: string;
        operationId: string;
        tokenPrefix: string;
      };
    };
    expect(payload.mcp).toEqual({
      sourceOperationId: `source-${'s'.repeat(121)}`,
      operationId: `undo-${'o'.repeat(123)}`,
      tokenPrefix: 'rct_pppppppp',
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /sourcePreparedHash|currentPostHash|restoreHash|must-not-survive|secret|body/,
    );
  });

  it('stores bounded transfer attribution without prepared bodies or provider details', async () => {
    const create = vi.fn(async () => undefined);
    await writeAudit(
      { auditEntry: { create } } as never,
      {
        companyId: 'company-generic',
        actorId: 'actor-generic',
        actorLabel: 'Generic User (MCP rct_example1)',
        txnId: 'transaction-generic',
        payee: 'Generic Transfer',
        amount: -250,
        action: 'transfer',
        before: 'QuickBooks transfer source',
        after: 'Transfer to counterpart account',
        payload: {
          accessToken: 'must-not-survive',
          requestPayload: { SyncToken: 'must-not-survive' },
          providerError: 'must-not-survive',
        },
        mutation: {
          requestId: `transfer-request-${'r'.repeat(200)}`,
          outcome: 'VERIFIED',
          references: {
            operation: 'transfer',
            qboType: 'Transfer',
            qboId: `transfer-${'q'.repeat(200)}`,
            accountQboIds: ['bank-b', 'bank-a', 'bank-b'],
            taxCodeQboIds: [],
          },
          mcp: {
            sourceOperationId: `source-${'s'.repeat(200)}`,
            operationId: `operation-${'o'.repeat(200)}`,
            tokenPrefix: `rct_${'p'.repeat(30)}`,
          },
        },
      },
    );

    const data = create.mock.calls[0]?.[0].data;
    expect(data).toEqual(expect.objectContaining({
      action: 'transfer',
      payload: {
        requestId: `transfer-request-${'r'.repeat(111)}`,
        outcome: 'VERIFIED',
        references: {
          operation: 'transfer',
          qboType: 'Transfer',
          qboId: `transfer-${'q'.repeat(119)}`,
          accountQboIds: ['bank-a', 'bank-b'],
          taxCodeQboIds: [],
        },
        mcp: {
          sourceOperationId: `source-${'s'.repeat(121)}`,
          operationId: `operation-${'o'.repeat(118)}`,
          tokenPrefix: 'rct_pppppppp',
        },
      },
    }));
    expect(JSON.stringify(data)).not.toMatch(
      /accessToken|requestPayload|SyncToken|providerError|must-not-survive/,
    );
  });
});
