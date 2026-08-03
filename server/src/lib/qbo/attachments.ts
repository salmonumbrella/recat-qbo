import { createHash } from 'node:crypto';
import { QBO_MAX_UPLOAD_REQUEST_BYTES } from '../../services/attachments/validation.js';
import type {
  QboAttachable,
  QboAttachmentRef,
  QboAttachmentUploadFile,
  QboAttachmentUploadOutcome,
  QboMultipartBody,
} from './types.js';

const encoder = new TextEncoder();
const MAX_ATTACHMENT_FILES = 20;

export class QboAttachmentAdapterError extends Error {
  readonly code:
    | 'QBO_ATTACHMENT_INVALID_INPUT'
    | 'QBO_ATTACHMENT_REQUEST_TOO_LARGE'
    | 'QBO_ATTACHMENT_RESPONSE_INVALID';

  constructor(
    code: QboAttachmentAdapterError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'QboAttachmentAdapterError';
    this.code = code;
  }
}

function invalidInput(message: string): never {
  throw new QboAttachmentAdapterError('QBO_ATTACHMENT_INVALID_INPUT', message);
}

function boundedText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maxBytes) return null;
  return normalized;
}

function safeFilename(input: string): {
  metadata: string;
  headerFallback: string;
  encoded: string;
} {
  const basename = input.split(/[\\/]/u).at(-1) ?? '';
  const metadata = basename
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .trim();
  if (
    metadata === ''
    || metadata === '.'
    || metadata === '..'
    || Buffer.byteLength(metadata, 'utf8') > 255
  ) {
    invalidInput('QuickBooks attachment filename is invalid.');
  }
  const headerFallback = [...metadata].map((character) => {
    const codePoint = character.codePointAt(0)!;
    if (character === '"') return '%22';
    if (character === '\\') return '%5C';
    return codePoint >= 0x20 && codePoint <= 0x7e ? character : '_';
  }).join('');
  return {
    metadata,
    headerFallback,
    encoded: encodeURIComponent(metadata).replace(/'/gu, '%27'),
  };
}

function boundaryFor(requestId: string): string {
  const normalized = boundedText(requestId, 128);
  if (!normalized) invalidInput('QuickBooks attachment request ID is invalid.');
  return `recat-${createHash('sha256').update(normalized).digest('hex').slice(0, 48)}`;
}

function partNumber(index: number): string {
  return String(index + 1).padStart(2, '0');
}

function metadataFor(
  ref: QboAttachmentRef,
  file: QboAttachmentUploadFile,
  filename: string,
): string {
  return JSON.stringify({
    AttachableRef: [{
      EntityRef: {
        type: ref.qboType,
        value: ref.qboId,
      },
    }],
    FileName: filename,
    ContentType: file.contentType,
    Note: `Recat reference: ${file.marker}`,
  });
}

function textBytes(value: string): Uint8Array {
  return encoder.encode(value);
}

interface PreparedMultipartFile {
  readonly file: QboAttachmentUploadFile;
  readonly metadataPrefix: Uint8Array;
  readonly contentPrefix: Uint8Array;
}

export function createQboAttachmentMultipart(
  ref: QboAttachmentRef,
  files: QboAttachmentUploadFile[],
  requestId: string,
): QboMultipartBody {
  if (
    !['Purchase', 'Deposit', 'JournalEntry'].includes(ref.qboType)
    || !boundedText(ref.qboId, 128)
    || files.length < 1
    || files.length > MAX_ATTACHMENT_FILES
  ) {
    invalidInput('QuickBooks attachment batch is invalid.');
  }
  const ordinals = new Set<number>();
  const boundary = boundaryFor(requestId);
  const prepared = files.map((file, index): PreparedMultipartFile => {
    if (
      !Number.isSafeInteger(file.ordinal)
      || file.ordinal < 0
      || ordinals.has(file.ordinal)
      || !Number.isSafeInteger(file.sizeBytes)
      || file.sizeBytes < 0
      || !boundedText(file.contentType, 120)
      || !boundedText(file.marker, 128)
    ) {
      invalidInput('QuickBooks attachment file metadata is invalid.');
    }
    ordinals.add(file.ordinal);
    const filename = safeFilename(file.filename);
    const number = partNumber(index);
    const metadata = metadataFor(ref, file, filename.metadata);
    const metadataPrefix = textBytes(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file_metadata_${number}"\r\n`
      + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
      + `${metadata}\r\n`,
    );
    const contentPrefix = textBytes(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file_content_${number}"; `
      + `filename="${filename.headerFallback}"; filename*=UTF-8''${filename.encoded}\r\n`
      + `Content-Type: ${file.contentType}\r\n\r\n`,
    );
    return { file, metadataPrefix, contentPrefix };
  });
  const fileSuffix = textBytes('\r\n');
  const closing = textBytes(`--${boundary}--\r\n`);
  const contentLength = prepared.reduce(
    (total, item) =>
      total
      + item.metadataPrefix.byteLength
      + item.contentPrefix.byteLength
      + item.file.sizeBytes
      + fileSuffix.byteLength,
    closing.byteLength,
  );
  if (
    !Number.isSafeInteger(contentLength)
    || contentLength > QBO_MAX_UPLOAD_REQUEST_BYTES
  ) {
    throw new QboAttachmentAdapterError(
      'QBO_ATTACHMENT_REQUEST_TOO_LARGE',
      'Encoded QuickBooks attachment request exceeds 100 MB.',
    );
  }

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength,
    async *openStream() {
      for (const item of prepared) {
        const reader = await item.file.openContent();
        if (
          reader.sizeBytes !== item.file.sizeBytes
          || reader.contentType !== item.file.contentType
        ) {
          throw new QboAttachmentAdapterError(
            'QBO_ATTACHMENT_INVALID_INPUT',
            'Stored attachment metadata changed before upload.',
          );
        }
        yield item.metadataPrefix;
        yield item.contentPrefix;
        let streamedBytes = 0;
        for await (const chunk of reader.chunks()) {
          if (!(chunk instanceof Uint8Array)) {
            invalidInput('Stored attachment yielded an invalid chunk.');
          }
          streamedBytes += chunk.byteLength;
          if (streamedBytes > item.file.sizeBytes) {
            invalidInput('Stored attachment exceeded its declared size.');
          }
          yield chunk;
        }
        if (streamedBytes !== item.file.sizeBytes) {
          invalidInput('Stored attachment did not match its declared size.');
        }
        yield fileSuffix;
      }
      yield closing;
    },
  };
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactSize(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^(0|[1-9]\d*)$/u.test(value)
    ? Number(value)
    : value;
  return typeof parsed === 'number'
    && Number.isSafeInteger(parsed)
    && parsed >= 0
    ? parsed
    : null;
}

type ParsedAttachable =
  | { kind: 'supported'; attachment: QboAttachable }
  | { kind: 'unsupported' }
  | { kind: 'invalid' };

function parseAttachable(value: unknown): ParsedAttachable {
  const row = runtimeRecord(value);
  if (!row) return { kind: 'invalid' };
  const id = boundedText(row.Id, 128);
  const syncToken = boundedText(row.SyncToken, 64);
  const filename = boundedText(row.FileName, 255);
  const contentType = boundedText(row.ContentType, 120);
  const sizeBytes = exactSize(row.Size);
  if (!id || !syncToken || !filename || !contentType || sizeBytes === null) {
    return { kind: 'invalid' };
  }
  if (row.AttachableRef === undefined) return { kind: 'unsupported' };
  if (!Array.isArray(row.AttachableRef)) return { kind: 'invalid' };
  const refs: QboAttachmentRef[] = [];
  for (const candidate of row.AttachableRef) {
    const entityRef = runtimeRecord(runtimeRecord(candidate)?.EntityRef);
    const qboType = boundedText(entityRef?.type, 64);
    const qboId = boundedText(entityRef?.value, 128);
    if (!qboType || !qboId) return { kind: 'invalid' };
    if (
      qboType !== 'Purchase'
      && qboType !== 'Deposit'
      && qboType !== 'JournalEntry'
    ) continue;
    refs.push({ qboType, qboId });
  }
  if (refs.length === 0) return { kind: 'unsupported' };
  return {
    kind: 'supported',
    attachment: {
      id,
      syncToken,
      filename,
      contentType,
      sizeBytes,
      note: typeof row.Note === 'string' ? row.Note.slice(0, 1000) : null,
      refs,
    },
  };
}

function parseFault(value: unknown): { code: string; message: string } | null {
  const fault = runtimeRecord(value);
  const errors = fault?.Error;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = runtimeRecord(errors[0]);
  const code = boundedText(first?.code, 64);
  const message = boundedText(first?.Detail, 500) ?? boundedText(first?.Message, 500);
  return code && message ? { code, message } : null;
}

function invalidResponse(): never {
  throw new QboAttachmentAdapterError(
    'QBO_ATTACHMENT_RESPONSE_INVALID',
    'QuickBooks returned an invalid attachment upload response.',
  );
}

export function parseQboAttachmentUploadResponse(
  value: unknown,
  expectedOrdinals: readonly number[],
): QboAttachmentUploadOutcome[] {
  if (
    !Array.isArray(value)
    || value.length !== expectedOrdinals.length
    || expectedOrdinals.some((ordinal) =>
      !Number.isSafeInteger(ordinal) || ordinal < 0)
    || new Set(expectedOrdinals).size !== expectedOrdinals.length
  ) {
    invalidResponse();
  }
  return value.map((candidate, index) => {
    const entry = runtimeRecord(candidate);
    if (!entry) return invalidResponse();
    const hasAttachable = Object.hasOwn(entry, 'Attachable');
    const hasFault = Object.hasOwn(entry, 'Fault');
    if (hasAttachable === hasFault) return invalidResponse();
    const ordinal = expectedOrdinals[index]!;
    if (hasAttachable) {
      const parsed = parseAttachable(entry.Attachable);
      if (parsed.kind !== 'supported') return invalidResponse();
      return {
        ordinal,
        outcome: 'ATTACHED',
        attachable: parsed.attachment,
      };
    }
    const fault = parseFault(entry.Fault);
    if (!fault) return invalidResponse();
    return {
      ordinal,
      outcome: 'FAILED',
      code: fault.code,
      message: fault.message,
    };
  });
}

export function parseQboAttachable(value: unknown): QboAttachable {
  const parsed = parseAttachable(value);
  if (parsed.kind !== 'supported') return invalidResponse();
  return parsed.attachment;
}

export function parseSupportedQboAttachable(
  value: unknown,
): QboAttachable | null {
  const parsed = parseAttachable(value);
  if (parsed.kind === 'invalid') return invalidResponse();
  return parsed.kind === 'supported' ? parsed.attachment : null;
}
