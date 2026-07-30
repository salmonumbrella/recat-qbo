import { describe, expect, it } from 'vitest';
import { runAttachmentCleanup } from './cleanup.js';

describe('attachment cleanup limits', () => {
  it.each([
    { grantLimit: 0 },
    { grantLimit: 101 },
    { stagingLimit: 0 },
    { stagingLimit: 26 },
    { blobLimit: 0 },
    { blobLimit: 101 },
  ])('rejects an unsafe or unbounded cleanup request %#', async (input) => {
    await expect(runAttachmentCleanup(input)).rejects.toMatchObject({
      code: 'ATTACHMENT_INVALID_INPUT',
    });
  });
});
