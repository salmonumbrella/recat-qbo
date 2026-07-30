import { describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_TOOL_NAMES,
  attachmentToolDefinitions,
  type McpAttachmentOperations,
} from './attachmentTools.js';
import type { McpPrincipal } from './auth.js';

const principal: McpPrincipal = {
  tokenId: '10000000-0000-4000-8000-000000000001',
  tokenPrefix: 'rct_attach01',
  userId: '20000000-0000-4000-8000-000000000002',
  isInstanceAdmin: false,
  memberships: [{
    companyId: '30000000-0000-4000-8000-000000000003',
    role: 'categorizer',
  }],
};

describe('MCP attachment tools', () => {
  it('publishes the exact bounded tool set', () => {
    expect(attachmentToolDefinitions.map((tool) => tool.name)).toEqual(
      ATTACHMENT_TOOL_NAMES,
    );
    expect(ATTACHMENT_TOOL_NAMES).toEqual([
      'create_attachment_upload',
      'attach_transaction_files',
      'list_transaction_attachments',
      'get_attachment_download',
      'delete_transaction_attachment',
    ]);
    expect(attachmentToolDefinitions.find(
      (tool) => tool.name === 'list_transaction_attachments',
    )?.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
  });

  it('rejects binary JSON, unknown keys, HTTP URLs, and more than 20 sources', () => {
    const attach = attachmentToolDefinitions.find(
      (tool) => tool.name === 'attach_transaction_files',
    )!;
    const base = {
      companyId: principal.memberships[0]!.companyId,
      transactionId: '40000000-0000-4000-8000-000000000004',
      idempotencyKey: 'attachment-request-1',
    };

    expect(attach.inputSchema.safeParse({
      ...base,
      sources: [{
        kind: 'upload',
        uploadId: '50000000-0000-4000-8000-000000000005',
        base64: 'JVBERi0=',
      }],
    }).success).toBe(false);
    expect(attach.inputSchema.safeParse({
      ...base,
      sources: [{ kind: 'https', url: 'http://example.com/receipt.pdf' }],
    }).success).toBe(false);
    expect(attach.inputSchema.safeParse({
      ...base,
      sources: Array.from({ length: 21 }, (_, index) => ({
        kind: 'upload',
        uploadId: `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })),
    }).success).toBe(false);
    expect(JSON.stringify(attach.inputSchema)).not.toContain('bytes');
  });

  it('marks delete destructive and invokes through the principal-bound adapter', async () => {
    const remove = attachmentToolDefinitions.find(
      (tool) => tool.name === 'delete_transaction_attachment',
    )!;
    expect(remove.annotations.destructiveHint).toBe(true);
    const deleteAttachment = vi.fn(async () => ({
      operationId: '60000000-0000-4000-8000-000000000006',
      kind: 'attachment' as const,
      state: 'committed' as const,
      phase: 'verified' as const,
      result: {
        fileCount: 1,
        attachedCount: 0,
        failedCount: 0,
        uncertainCount: 0,
      },
      error: null,
      actions: {
        canCommit: false,
        canRetry: false,
        requiresReconciliation: false,
      },
    }));
    const operations = {
      deleteAttachment,
    } as unknown as McpAttachmentOperations;

    await remove.invoke(operations, principal, {
      companyId: principal.memberships[0]!.companyId,
      transactionId: '40000000-0000-4000-8000-000000000004',
      attachmentId: '50000000-0000-4000-8000-000000000005',
      scope: 'everywhere',
      idempotencyKey: 'delete-1',
    });

    expect(deleteAttachment).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ scope: 'everywhere' }),
    );
  });
});
