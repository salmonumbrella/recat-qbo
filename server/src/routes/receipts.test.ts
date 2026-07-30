import { describe, expect, it } from 'vitest';
import { parseReceiptListQuery } from './receipts.js';

describe('receipt route query validation', () => {
  it('applies bounded defaults', () => {
    expect(parseReceiptListQuery({})).toMatchObject({
      statuses: [],
      documentTypes: [],
      sourceKinds: [],
      search: '',
      page: 1,
      pageSize: 50,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
  });

  it('rejects unbounded searches, filters, and page sizes', () => {
    expect(() => parseReceiptListQuery({ search: 'a'.repeat(201) })).toThrow();
    expect(() => parseReceiptListQuery({ pageSize: '101' })).toThrow();
    expect(() => parseReceiptListQuery({
      statuses: 'READY,FAILED,QUEUED,RECEIVED,MATCHED,ATTACHED',
    })).toThrow();
  });

  it('rejects unknown fields and non-allowlisted sort keys', () => {
    expect(() => parseReceiptListQuery({ hidden: 'true' })).toThrow();
    expect(() => parseReceiptListQuery({ sortBy: 'deletedAt' })).toThrow();
  });
});
