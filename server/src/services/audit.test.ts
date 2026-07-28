import { describe, expect, it, vi } from 'vitest';
import type { AuditEntryDto } from '@recat/shared';
import {
  AUDIT_CSV_HEADER,
  buildAuditCsv,
  csvEscape,
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
});
