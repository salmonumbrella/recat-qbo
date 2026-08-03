import { describe, expect, it } from 'vitest';
import {
  createAttachmentBatchBudget,
  rechunkAttachmentContent,
} from './blobStore.js';
import { BLOB_CHUNK_BYTES } from './validation.js';

async function* source(...chunks: Uint8Array[]) {
  for (const chunk of chunks) yield chunk;
}

describe('attachment blob-store primitives', () => {
  it('rechunks arbitrary input without exceeding the PostgreSQL chunk bound', async () => {
    const first = new Uint8Array(BLOB_CHUNK_BYTES + 7).fill(1);
    const second = new Uint8Array(BLOB_CHUNK_BYTES).fill(2);
    const chunks: Uint8Array[] = [];

    for await (const chunk of rechunkAttachmentContent(source(first, second))) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([
      BLOB_CHUNK_BYTES,
      BLOB_CHUNK_BYTES,
      7,
    ]);
    expect(chunks.every((chunk) => chunk.byteLength <= BLOB_CHUNK_BYTES)).toBe(true);
  });

  it('enforces one aggregate byte budget across files', () => {
    const budget = createAttachmentBatchBudget(10);
    budget.consume(4);
    budget.consume(6);
    expect(budget.usedBytes).toBe(10);
    expect(() => budget.consume(1)).toThrowError(
      expect.objectContaining({ code: 'ATTACHMENT_TOO_LARGE' }),
    );
    expect(() => budget.consume(-1)).toThrowError(
      expect.objectContaining({ code: 'ATTACHMENT_INVALID_INPUT' }),
    );
  });
});
