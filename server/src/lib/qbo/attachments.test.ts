import { describe, expect, it } from 'vitest';
import type { AttachmentBlobReader } from '../../services/attachments/types.js';
import { QBO_MAX_UPLOAD_REQUEST_BYTES } from '../../services/attachments/validation.js';
import {
  createQboAttachmentMultipart,
  parseQboAttachmentUploadResponse,
  QboAttachmentAdapterError,
} from './attachments.js';
import type {
  QboAttachmentRef,
  QboAttachmentUploadFile,
} from './types.js';

const encoder = new TextEncoder();
const REF: QboAttachmentRef = { qboType: 'Deposit', qboId: 'deposit-1' };

function uploadFile(
  overrides: Partial<QboAttachmentUploadFile> = {},
): QboAttachmentUploadFile {
  const bytes = encoder.encode('%PDF-1.7\nfixture\n');
  return {
    ordinal: 0,
    filename: 'receipt "one".pdf',
    contentType: 'application/pdf',
    sizeBytes: bytes.byteLength,
    marker: '9aa1122b-5375-45e7-99c2-a2ca739f8d11',
    async openContent(): Promise<AttachmentBlobReader> {
      return {
        blobId: 'blob-1',
        sizeBytes: bytes.byteLength,
        contentType: 'application/pdf',
        async *chunks() {
          yield bytes.subarray(0, 5);
          yield bytes.subarray(5);
        },
      };
    },
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('QuickBooks attachment multipart encoding', () => {
  it('uses deterministic paired part names, safe filenames, refs, and markers', async () => {
    const first = createQboAttachmentMultipart(REF, [uploadFile()], 'request-1');
    const second = createQboAttachmentMultipart(REF, [uploadFile()], 'request-1');
    const body = await collect(first.openStream());
    const text = body.toString('utf8');

    expect(second.contentType).toBe(first.contentType);
    expect(first.contentType).toMatch(
      /^multipart\/form-data; boundary=recat-[a-f0-9]{48}$/u,
    );
    expect(text).toContain('name="file_metadata_01"');
    expect(text).toContain('name="file_content_01"');
    expect(text).toContain('filename="receipt %22one%22.pdf"');
    expect(text).toContain('"type":"Deposit"');
    expect(text).toContain('"value":"deposit-1"');
    expect(text).toContain(
      '"Note":"Recat reference: 9aa1122b-5375-45e7-99c2-a2ca739f8d11"',
    );
    expect(first.contentLength).toBe(body.byteLength);
  });

  it('streams reader chunks directly and can reopen the multipart body', async () => {
    const multipart = createQboAttachmentMultipart(REF, [uploadFile()], 'request-reopen');
    const first = await collect(multipart.openStream());
    const second = await collect(multipart.openStream());

    expect(second).toEqual(first);
  });

  it('accepts the exact encoded provider ceiling and rejects one byte above it', () => {
    const empty = createQboAttachmentMultipart(
      REF,
      [uploadFile({ sizeBytes: 0 })],
      'request-limit',
    );
    const overhead = empty.contentLength;

    expect(createQboAttachmentMultipart(
      REF,
      [uploadFile({ sizeBytes: QBO_MAX_UPLOAD_REQUEST_BYTES - overhead })],
      'request-limit',
    ).contentLength).toBe(QBO_MAX_UPLOAD_REQUEST_BYTES);
    expect(() => createQboAttachmentMultipart(
      REF,
      [uploadFile({ sizeBytes: QBO_MAX_UPLOAD_REQUEST_BYTES - overhead + 1 })],
      'request-limit',
    )).toThrowError(expect.objectContaining({ code: 'QBO_ATTACHMENT_REQUEST_TOO_LARGE' }));
  });

  it('maps mixed Attachable and Fault entries to the expected ordinals', () => {
    expect(parseQboAttachmentUploadResponse([
      {
        Attachable: {
          Id: 'attachable-1',
          SyncToken: '0',
          FileName: 'receipt.pdf',
          ContentType: 'application/pdf',
          Size: 12,
          Note: 'Recat reference: marker-1',
          AttachableRef: [{
            EntityRef: { type: 'Purchase', value: 'purchase-1' },
          }],
        },
      },
      {
        Fault: {
          Error: [{ code: '6000', Message: 'Upload rejected' }],
        },
      },
    ], [4, 8])).toEqual([
      {
        ordinal: 4,
        outcome: 'ATTACHED',
        attachable: {
          id: 'attachable-1',
          syncToken: '0',
          filename: 'receipt.pdf',
          contentType: 'application/pdf',
          sizeBytes: 12,
          note: 'Recat reference: marker-1',
          refs: [{ qboType: 'Purchase', qboId: 'purchase-1' }],
        },
      },
      {
        ordinal: 8,
        outcome: 'FAILED',
        code: '6000',
        message: 'Upload rejected',
      },
    ]);
  });

  it.each([
    [[], [0]],
    [[{ Attachable: {} }], [0]],
    [[{ Fault: {} }], [0]],
    [[{ Attachable: {}, Fault: {} }], [0]],
    [[{ Fault: { Error: [{ code: 'x', Message: 'bad' }] } }], [0, 0]],
  ])('rejects missing, duplicate, or malformed response ordinals', (value, ordinals) => {
    expect(() => parseQboAttachmentUploadResponse(value, ordinals)).toThrow(
      QboAttachmentAdapterError,
    );
  });
});
