import { describe, expect, it } from 'vitest';
import {
  detectAllowedAttachment,
  normalizeAttachmentFilename,
} from './validation.js';

const encoder = new TextEncoder();

describe('attachment validation', () => {
  it('normalizes to a bounded basename and removes control characters', () => {
    expect(normalizeAttachmentFilename('../bad\u0000name.pdf')).toBe('badname.pdf');
    expect(normalizeAttachmentFilename('folder\\nested\\ receipt .pdf ')).toBe('receipt .pdf');
    expect(() => normalizeAttachmentFilename('\u0000/..')).toThrowError(
      expect.objectContaining({ code: 'ATTACHMENT_INVALID_INPUT' }),
    );
  });

  it('detects allowed PDF content by signature and marks it previewable', async () => {
    const result = await detectAllowedAttachment(
      encoder.encode('%PDF-1.7\nfixture\n%%EOF\n'),
      'receipt.pdf',
      'application/pdf',
    );

    expect(result).toEqual({
      extension: 'pdf',
      contentType: 'application/pdf',
      canPreview: true,
    });
  });

  it('rejects unsupported archives even when their declaration matches', async () => {
    const zipHeader = Uint8Array.from([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    await expect(detectAllowedAttachment(
      zipHeader,
      'archive.zip',
      'application/zip',
    )).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
  });

  it('detects bounded UTF-8 text formats and rejects misleading declarations', async () => {
    await expect(detectAllowedAttachment(
      encoder.encode('date,total\n2026-07-30,12.34\n'),
      'ledger.csv',
      'text/csv',
    )).resolves.toEqual({
      extension: 'csv',
      contentType: 'text/csv',
      canPreview: false,
    });

    await expect(detectAllowedAttachment(
      encoder.encode('<?xml version="1.0"?><receipt/>'),
      'receipt.xml',
      'application/pdf',
    )).rejects.toMatchObject({ code: 'ATTACHMENT_MIME_MISMATCH' });
  });

  it('requires the extension to agree with detected binary content', async () => {
    await expect(detectAllowedAttachment(
      encoder.encode('%PDF-1.7\nfixture\n%%EOF\n'),
      'receipt.png',
      'image/png',
    )).rejects.toMatchObject({ code: 'ATTACHMENT_MIME_MISMATCH' });
  });
});
