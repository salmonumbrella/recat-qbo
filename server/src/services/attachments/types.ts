export type AttachmentErrorCode =
  | 'ATTACHMENT_INVALID_INPUT'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_TYPE_UNSUPPORTED'
  | 'ATTACHMENT_MIME_MISMATCH'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_FORBIDDEN'
  | 'ATTACHMENT_BUSY'
  | 'ATTACHMENT_PROVIDER_UNCERTAIN'
  | 'IDEMPOTENCY_CONFLICT';

export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export interface AttachmentBlobReader {
  readonly blobId: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  chunks(): AsyncIterable<Uint8Array>;
}

export interface StagedAttachmentDto {
  id: string;
  companyId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  sourceKind: 'LOCAL_UPLOAD' | 'HTTPS_IMPORT';
  retainLocally: boolean;
  expiresAt: string;
}

export interface AttachmentBatchBudget {
  readonly maxBytes: number;
  readonly usedBytes: number;
  consume(bytes: number): void;
}

export interface StageAttachmentInput {
  companyId: string;
  actorKey: string;
  sourceKind: 'LOCAL_UPLOAD' | 'HTTPS_IMPORT';
  retainLocally: boolean;
  filename: string;
  declaredContentType: string | null;
  content: AsyncIterable<Uint8Array>;
  expiresAt: Date;
}
