import { fileTypeFromBuffer } from 'file-type';
import { AttachmentError } from './types.js';

export const QBO_MAX_UPLOAD_REQUEST_BYTES = 100_000_000;
export const MAX_ATTACHMENT_FILES = 20;
export const BLOB_CHUNK_BYTES = 1_048_576;
export const ATTACHMENT_DETECTION_BYTES = BLOB_CHUNK_BYTES;

export interface DetectedAttachmentType {
  extension: string;
  contentType: string;
  canPreview: boolean;
}

interface AllowedType {
  readonly canonicalExtension: string;
  readonly contentType: string;
  readonly binaryExtensions?: readonly string[];
  readonly declaredTypes: readonly string[];
  readonly textKind?: 'plain' | 'xml' | 'rtf' | 'postscript';
}

const ALLOWED_TYPES: Readonly<Record<string, AllowedType>> = {
  ai: {
    canonicalExtension: 'ai',
    contentType: 'application/postscript',
    binaryExtensions: ['pdf'],
    declaredTypes: ['application/postscript', 'application/pdf'],
    textKind: 'postscript',
  },
  eps: {
    canonicalExtension: 'eps',
    contentType: 'application/postscript',
    declaredTypes: ['application/postscript'],
    textKind: 'postscript',
  },
  ps: {
    canonicalExtension: 'ps',
    contentType: 'application/postscript',
    declaredTypes: ['application/postscript'],
    textKind: 'postscript',
  },
  csv: {
    canonicalExtension: 'csv',
    contentType: 'text/csv',
    declaredTypes: ['text/csv', 'application/csv', 'text/plain'],
    textKind: 'plain',
  },
  doc: {
    canonicalExtension: 'doc',
    contentType: 'application/msword',
    binaryExtensions: ['cfb'],
    declaredTypes: ['application/msword', 'application/x-ole-storage'],
  },
  docx: {
    canonicalExtension: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    binaryExtensions: ['docx'],
    declaredTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  },
  gif: {
    canonicalExtension: 'gif',
    contentType: 'image/gif',
    binaryExtensions: ['gif'],
    declaredTypes: ['image/gif'],
  },
  jpeg: {
    canonicalExtension: 'jpg',
    contentType: 'image/jpeg',
    binaryExtensions: ['jpg'],
    declaredTypes: ['image/jpeg', 'image/jpg'],
  },
  jpg: {
    canonicalExtension: 'jpg',
    contentType: 'image/jpeg',
    binaryExtensions: ['jpg'],
    declaredTypes: ['image/jpeg', 'image/jpg'],
  },
  ods: {
    canonicalExtension: 'ods',
    contentType: 'application/vnd.oasis.opendocument.spreadsheet',
    binaryExtensions: ['ods'],
    declaredTypes: ['application/vnd.oasis.opendocument.spreadsheet'],
  },
  pdf: {
    canonicalExtension: 'pdf',
    contentType: 'application/pdf',
    binaryExtensions: ['pdf'],
    declaredTypes: ['application/pdf'],
  },
  png: {
    canonicalExtension: 'png',
    contentType: 'image/png',
    binaryExtensions: ['png'],
    declaredTypes: ['image/png'],
  },
  rtf: {
    canonicalExtension: 'rtf',
    contentType: 'application/rtf',
    declaredTypes: ['application/rtf', 'text/rtf'],
    textKind: 'rtf',
  },
  tif: {
    canonicalExtension: 'tif',
    contentType: 'image/tiff',
    binaryExtensions: ['tif'],
    declaredTypes: ['image/tiff'],
  },
  tiff: {
    canonicalExtension: 'tif',
    contentType: 'image/tiff',
    binaryExtensions: ['tif'],
    declaredTypes: ['image/tiff'],
  },
  txt: {
    canonicalExtension: 'txt',
    contentType: 'text/plain',
    declaredTypes: ['text/plain'],
    textKind: 'plain',
  },
  xls: {
    canonicalExtension: 'xls',
    contentType: 'application/vnd.ms-excel',
    binaryExtensions: ['cfb'],
    declaredTypes: ['application/vnd.ms-excel', 'application/x-ole-storage'],
  },
  xlsx: {
    canonicalExtension: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    binaryExtensions: ['xlsx'],
    declaredTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  },
  xml: {
    canonicalExtension: 'xml',
    contentType: 'application/xml',
    declaredTypes: ['application/xml', 'text/xml'],
    textKind: 'xml',
  },
};

function invalidInput(message: string): never {
  throw new AttachmentError('ATTACHMENT_INVALID_INPUT', message);
}

export function normalizeAttachmentFilename(input: string): string {
  if (typeof input !== 'string') invalidInput('Attachment filename is invalid.');
  const basename = input.split(/[\\/]/u).at(-1) ?? '';
  const normalized = basename
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .trim();
  if (
    normalized === ''
    || normalized === '.'
    || normalized === '..'
    || Buffer.byteLength(normalized, 'utf8') > 255
  ) {
    invalidInput('Attachment filename must be a non-empty UTF-8 basename of at most 255 bytes.');
  }
  return normalized;
}

function extensionOf(filename: string): string {
  const separator = filename.lastIndexOf('.');
  if (separator <= 0 || separator === filename.length - 1) {
    throw new AttachmentError(
      'ATTACHMENT_TYPE_UNSUPPORTED',
      'Attachment filename must use a QuickBooks-supported extension.',
    );
  }
  return filename.slice(separator + 1).toLowerCase();
}

function decodeBoundedText(bytes: Uint8Array): string {
  if (bytes.byteLength > ATTACHMENT_DETECTION_BYTES) {
    invalidInput('Attachment detection input exceeded its bounded prefix.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AttachmentError(
      'ATTACHMENT_MIME_MISMATCH',
      'Attachment content is not valid UTF-8 text.',
    );
  }
  if (text.includes('\u0000')) {
    throw new AttachmentError(
      'ATTACHMENT_MIME_MISMATCH',
      'Attachment text contains binary null bytes.',
    );
  }
  return text.replace(/^\uFEFF/u, '');
}

function assertTextKind(bytes: Uint8Array, kind: AllowedType['textKind']): void {
  const text = decodeBoundedText(bytes);
  const trimmed = text.trimStart();
  if (kind === 'xml' && !trimmed.startsWith('<')) {
    throw new AttachmentError('ATTACHMENT_MIME_MISMATCH', 'XML signature is missing.');
  }
  if (kind === 'rtf' && !trimmed.startsWith('{\\rtf')) {
    throw new AttachmentError('ATTACHMENT_MIME_MISMATCH', 'RTF signature is missing.');
  }
  if (kind === 'postscript' && !trimmed.startsWith('%!PS-Adobe')) {
    throw new AttachmentError('ATTACHMENT_MIME_MISMATCH', 'PostScript signature is missing.');
  }
}

function normalizedDeclaredType(declaredContentType: string | null): string | null {
  if (declaredContentType === null || declaredContentType.trim() === '') return null;
  return declaredContentType.split(';', 1)[0]!.trim().toLowerCase();
}

function assertDeclaredType(type: AllowedType, declaredContentType: string | null): void {
  const declared = normalizedDeclaredType(declaredContentType);
  if (
    declared === null
    || declared === 'application/octet-stream'
    || type.declaredTypes.includes(declared)
  ) {
    return;
  }
  throw new AttachmentError(
    'ATTACHMENT_MIME_MISMATCH',
    'Declared attachment content type does not match its detected type.',
  );
}

function previewable(contentType: string): boolean {
  return contentType === 'application/pdf' || contentType.startsWith('image/');
}

export async function detectAllowedAttachment(
  bytes: Uint8Array,
  inputFilename: string,
  declaredContentType: string | null,
): Promise<DetectedAttachmentType> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    invalidInput('Attachment content must not be empty.');
  }
  const filename = normalizeAttachmentFilename(inputFilename);
  const extension = extensionOf(filename);
  const allowed = ALLOWED_TYPES[extension];
  if (!allowed) {
    throw new AttachmentError(
      'ATTACHMENT_TYPE_UNSUPPORTED',
      'Attachment type is not supported by QuickBooks.',
    );
  }

  const detected = await fileTypeFromBuffer(bytes);
  let contentType = allowed.contentType;
  if (detected) {
    if (!allowed.binaryExtensions?.includes(detected.ext)) {
      throw new AttachmentError(
        detected.ext === 'zip'
          ? 'ATTACHMENT_TYPE_UNSUPPORTED'
          : 'ATTACHMENT_MIME_MISMATCH',
        'Attachment signature does not match its filename extension.',
      );
    }
    if (extension === 'ai' && detected.ext === 'pdf') {
      contentType = 'application/pdf';
    }
  } else if (allowed.textKind) {
    assertTextKind(bytes, allowed.textKind);
  } else {
    throw new AttachmentError(
      'ATTACHMENT_MIME_MISMATCH',
      'Attachment signature could not be verified.',
    );
  }

  assertDeclaredType(
    contentType === allowed.contentType
      ? allowed
      : { ...allowed, declaredTypes: ['application/pdf', 'application/postscript'] },
    declaredContentType,
  );
  return {
    extension: allowed.canonicalExtension,
    contentType,
    canPreview: previewable(contentType),
  };
}
