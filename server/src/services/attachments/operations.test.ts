import { describe, expect, it } from 'vitest';
import {
  canonicalAttachmentOperationHash,
  deriveAttachmentOperationStatus,
  normalizeAttachmentAuditDetails,
} from './operations.js';

describe('attachment operation invariants', () => {
  const binding = {
    actorKey: 'session:user-1',
    companyId: 'company-1',
    transactionId: 'transaction-1',
    idempotencyKey: 'request-1',
    sources: [{
      attachmentId: 'attachment-1',
      filename: 'receipt.pdf',
      sha256: 'a'.repeat(64),
      sourceKind: 'LOCAL_UPLOAD' as const,
      retainLocally: true,
    }],
  };

  it('hashes only canonical bounded metadata and preserves source order', () => {
    const same = canonicalAttachmentOperationHash({
      ...binding,
      sources: binding.sources.map((source) => ({ ...source })),
    });
    const reordered = canonicalAttachmentOperationHash({
      ...binding,
      sources: [
        {
          ...binding.sources[0]!,
          attachmentId: 'attachment-2',
          filename: 'other.pdf',
          sha256: 'b'.repeat(64),
        },
        binding.sources[0]!,
      ],
    });

    expect(same).toBe(canonicalAttachmentOperationHash(binding));
    expect(reordered).not.toBe(same);
    expect(same).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('derives aggregate state from per-file state without trusting callers', () => {
    expect(deriveAttachmentOperationStatus(['STAGED'])).toBe('PREPARED');
    expect(deriveAttachmentOperationStatus(['UPLOADING', 'ATTACHED'])).toBe('COMMITTING');
    expect(deriveAttachmentOperationStatus(['ATTACHED', 'FAILED'])).toBe('PARTIAL');
    expect(deriveAttachmentOperationStatus(['FAILED'])).toBe('FAILED');
    expect(deriveAttachmentOperationStatus(['UNCERTAIN', 'ATTACHED'])).toBe('UNCERTAIN');
    expect(deriveAttachmentOperationStatus(['DELETING'])).toBe('DELETING');
    expect(deriveAttachmentOperationStatus(['DELETED', 'DELETED'])).toBe('DELETED');
    expect(deriveAttachmentOperationStatus(['ATTACHED', 'ATTACHED'])).toBe('VERIFIED');
  });

  it('normalizes audit details without filenames, hashes, markers, URLs, or provider IDs', () => {
    const normalized = normalizeAttachmentAuditDetails({
      attachmentCount: 2,
      totalBytes: 1_500_000,
      sourceKinds: ['HTTPS_IMPORT', 'LOCAL_UPLOAD'],
      state: 'VERIFIED',
    });

    expect(normalized).toEqual({
      attachmentCount: 2,
      sizeBucket: '1MB_TO_10MB',
      sourceKinds: ['HTTPS_IMPORT', 'LOCAL_UPLOAD'],
      state: 'VERIFIED',
    });
    expect(JSON.stringify(normalized)).not.toMatch(
      /filename|sha256|marker|https?:|qbo/iu,
    );
  });
});
