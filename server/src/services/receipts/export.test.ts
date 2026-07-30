import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  buildReceiptCsv,
  csvCell,
  exportReceipts,
} from './export.js';

describe('receipt export', () => {
  it('prevents spreadsheet formula injection and uses RFC 4180 quoting', () => {
    expect(csvCell('=HYPERLINK("https://example.invalid")'))
      .toBe(`"'=HYPERLINK(""https://example.invalid"")"`);
    expect(csvCell('+synthetic')).toBe("'+synthetic");
    expect(csvCell('plain')).toBe('plain');
  });

  it('builds deterministic UTF-8 CSV rows', () => {
    const csv = buildReceiptCsv([
      {
        id: 'receipt-b',
        filename: 'synthetic-two.png',
        approved: false,
        currentExtraction: null,
      },
      {
        id: 'receipt-a',
        filename: 'synthetic-one.pdf',
        approved: true,
        currentExtraction: {
          vendorName: 'Invented Vendor',
          receiptDate: '2026-07-30',
          subtotal: '10',
          taxAmount: '1',
          totalAmount: '11',
          currency: 'USD',
          documentType: 'receipt',
          category: 'Synthetic category',
        },
      },
    ]);

    expect(csv).toContain(
      'receipt_id,vendor_name,receipt_date,subtotal,tax_amount,total_amount,currency',
    );
    expect(csv.indexOf('receipt-a')).toBeLessThan(csv.indexOf('receipt-b'));
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('exports originals in stable ID-prefixed order', async () => {
    const rows = [
      {
        id: 'receipt-b',
        companyId: 'company-1',
        originalFilename: 'synthetic two.png',
        sizeBytes: 4n,
        generation: 1,
        blobId: 'blob-b',
        transactionAttachment: null,
        attempts: [],
        approvedAt: null,
        userNotes: null,
        currentMetadata: {},
      },
      {
        id: 'receipt-a',
        companyId: 'company-1',
        originalFilename: 'synthetic one.pdf',
        sizeBytes: 4n,
        generation: 1,
        blobId: 'blob-a',
        transactionAttachment: null,
        attempts: [],
        approvedAt: null,
        userNotes: null,
        currentMetadata: {},
      },
    ];
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const result = await exportReceipts({
      companyId: 'company-1',
      actorUserId: 'user-1',
      documentIds: ['receipt-b', 'receipt-a'],
      now: new Date('2026-07-30T12:00:00Z'),
    }, {
      db: {
        receiptDocument: {
          findMany: vi.fn().mockResolvedValue(rows),
          updateMany,
        },
        receiptEvent: { createMany },
        $transaction: vi.fn(async (callback) => callback({
          receiptDocument: { updateMany },
          receiptEvent: { createMany },
        })),
      } as never,
      openBlob: async (_companyId, blobId) => ({
        blobId,
        contentType: 'application/octet-stream',
        sizeBytes: 4,
        chunks: () => Readable.from([Buffer.from('data')]),
      }),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    await result.completed;
    const zip = Buffer.concat(chunks);
    const csvAt = zip.indexOf('receipts.csv');
    const firstAt = zip.indexOf('files/receipt-a-synthetic-one.pdf');
    const secondAt = zip.indexOf('files/receipt-b-synthetic-two.png');

    expect(result.filename).toBe('recat-receipts-2026-07-30.zip');
    expect(csvAt).toBeGreaterThanOrEqual(0);
    expect(firstAt).toBeGreaterThan(csvAt);
    expect(secondAt).toBeGreaterThan(firstAt);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyId: 'company-1',
        id: { in: ['receipt-a', 'receipt-b'] },
      },
    }));
    expect(createMany).toHaveBeenCalled();
  });
});
