import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import {
  MUTATION_TOOL_NAMES,
  type McpMutationOperations,
} from './mutationTools.js';
import { createRecatMcpServer } from './readTools.js';

const principal = Object.freeze({
  tokenId: 'token-a',
  tokenPrefix: 'rct_SAFE',
  userId: 'user-a',
  isInstanceAdmin: false,
  memberships: Object.freeze([{
    companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'categorizer',
  }]),
});
const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const transactionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const undoOperationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const preparedCategorization = {
  operationId,
  expiresAt: '2026-07-29T20:15:00.000Z',
  sourceRevision: 2,
  preparedRevision: 3,
  preview: {
    transactionId,
    revision: 3,
    taxCalculation: 'TaxInclusive' as const,
    totals: {
      subtotalCents: -1_000,
      taxCents: -50,
      totalCents: -1_050,
    },
    lines: [{
      idx: 0,
      subtotalCents: -1_000,
      taxCents: -50,
      totalCents: -1_050,
    }],
    transactionTagCount: 1,
    lineTagCount: 1,
  },
  warnings: [],
};

const operation = {
  operationId,
  kind: 'categorization' as const,
  companyId,
  transactionId,
  sourceRevision: 2,
  preparedRevision: 3,
  expiresAt: '2026-07-29T20:15:00.000Z',
  state: 'prepared' as const,
  phase: 'awaiting_commit' as const,
  result: null,
  error: null,
  actions: {
    canCommit: true,
    canRetry: false,
    requiresReconciliation: false,
  },
};

const preparedUndo = {
  operationId: undoOperationId,
  sourceOperationId: operationId,
  expiresAt: '2026-07-29T20:15:00.000Z',
  preview: {
    action: 'restore_purchase_categorization' as const,
    resultingStatus: 'REVERTED' as const,
    direction: 'purchase' as const,
    totalCents: -1_050,
    totalTaxCents: -50,
    lineCount: 1,
    restorationDigest: 'a'.repeat(64),
  },
  warnings: [],
};

function mutations(
  overrides: Partial<McpMutationOperations> = {},
): McpMutationOperations {
  return {
    prepareCategorization: vi.fn().mockResolvedValue(preparedCategorization),
    commitCategorization: vi.fn().mockResolvedValue(operation),
    getOperation: vi.fn().mockResolvedValue(operation),
    retryOperation: vi.fn().mockResolvedValue(operation),
    prepareUndo: vi.fn().mockResolvedValue(preparedUndo),
    commitUndo: vi.fn().mockResolvedValue({
      ...operation,
      operationId: undoOperationId,
      kind: 'undo',
    }),
    ...overrides,
  };
}

async function legacy(
  handler: ReturnType<typeof createMcpHandler>,
  method: string,
  params: object,
): Promise<Record<string, any>> {
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));
  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
    : text;
  return JSON.parse(payload ?? '') as Record<string, any>;
}

function handler(
  operations: McpMutationOperations,
  log = vi.fn(),
): ReturnType<typeof createMcpHandler> {
  return createMcpHandler(
    () => createRecatMcpServer({
      principal,
      era: 'legacy',
      mutations: operations,
      requestId: 'safe-request-id',
      log,
    }),
    { legacy: 'stateless' },
  );
}

describe('Recat MCP mutation tools', () => {
  it('publishes recursively strict bounded input and output schemas', async () => {
    const body = await legacy(handler(mutations()), 'tools/list', {});
    const tools = body.result.tools as Array<Record<string, any>>;
    const mutationTools = tools.filter((tool) =>
      MUTATION_TOOL_NAMES.includes(tool.name),
    );

    expect(mutationTools.map((tool) => tool.name)).toEqual(MUTATION_TOOL_NAMES);
    expect(mutationTools.every((tool) =>
      tool.inputSchema.additionalProperties === false
      && tool.outputSchema.additionalProperties === false,
    )).toBe(true);

    const prepare = mutationTools[0]!;
    expect(prepare.inputSchema.required).toEqual([
      'companyId',
      'transactionId',
      'expectedRevision',
      'idempotencyKey',
      'proposal',
    ]);
    expect(prepare.inputSchema.properties.expectedRevision).toMatchObject({
      minimum: 0,
      maximum: 2_147_483_646,
    });
    expect(prepare.inputSchema.properties.idempotencyKey.maxLength).toBe(128);
    expect(prepare.inputSchema.properties.proposal.additionalProperties).toBe(false);
    expect(prepare.inputSchema.properties.proposal.properties.lines).toMatchObject({
      minItems: 1,
      maxItems: 20,
    });
    expect(
      prepare.inputSchema.properties.proposal.properties.lines.items
        .additionalProperties,
    ).toBe(false);
    expect(
      prepare.inputSchema.properties.proposal.properties.lines.items
        .properties.categoryQboId.maxLength,
    ).toBe(120);
    expect(
      prepare.inputSchema.properties.proposal.properties.lines.items
        .properties.memo.maxLength,
    ).toBe(500);
    expect(
      prepare.inputSchema.properties.proposal.properties.lines.items
        .properties.tagIds.maxItems,
    ).toBe(50);
    expect(prepare.outputSchema.properties.preview.additionalProperties).toBe(false);
    expect(
      prepare.outputSchema.properties.preview.properties.lines.maxItems,
    ).toBe(20);

    const operationSchema = mutationTools[1]!.outputSchema;
    expect(operationSchema.properties.actions.additionalProperties).toBe(false);
    expect(operationSchema.properties.result.anyOf).toHaveLength(2);
    expect(operationSchema.properties.error.anyOf).toHaveLength(2);

    const undoSchema = mutationTools[4]!.outputSchema;
    expect(undoSchema.properties.preview.additionalProperties).toBe(false);
    expect(
      undoSchema.properties.preview.properties.restorationDigest.pattern,
    ).toBe('^[0-9a-f]{64}$');
  });

  it('routes all six operations with the fresh principal and sanitized DTOs', async () => {
    const operations = mutations();
    const server = handler(operations);
    const proposal = {
      taxCalculation: 'TaxInclusive',
      lines: [{
        grossCents: -1_050,
        categoryQboId: 'expense-account',
        taxCodeQboId: 'tax-code',
        memo: 'bounded memo',
        tagIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
      }],
      tagIds: ['ffffffff-ffff-4fff-8fff-ffffffffffff'],
    };
    const calls = [
      ['prepare_categorization', {
        companyId,
        transactionId,
        expectedRevision: 2,
        idempotencyKey: 'prepare-one',
        proposal,
      }],
      ['commit_categorization', {
        operationId,
        idempotencyKey: 'prepare-one',
      }],
      ['get_operation', { operationId }],
      ['retry_operation', { operationId }],
      ['prepare_undo', {
        operationId,
        idempotencyKey: 'undo-one',
      }],
      ['commit_undo', {
        operationId: undoOperationId,
        idempotencyKey: 'undo-one',
      }],
    ] as const;

    for (const [name, arguments_] of calls) {
      const response = await legacy(server, 'tools/call', {
        name,
        arguments: arguments_,
      });
      expect(response.result.isError, name).not.toBe(true);
    }

    expect(operations.prepareCategorization).toHaveBeenCalledWith(
      principal,
      calls[0][1],
    );
    expect(operations.commitCategorization).toHaveBeenCalledWith(
      principal,
      calls[1][1],
    );
    expect(operations.getOperation).toHaveBeenCalledWith(principal, calls[2][1]);
    expect(operations.retryOperation).toHaveBeenCalledWith(principal, calls[3][1]);
    expect(operations.prepareUndo).toHaveBeenCalledWith(principal, calls[4][1]);
    expect(operations.commitUndo).toHaveBeenCalledWith(principal, calls[5][1]);
  });

  it('rejects extra keys and contradictory tax inputs before service dispatch', async () => {
    const operations = mutations();
    const server = handler(operations);
    const invalidInputs = [
      {
        companyId,
        transactionId,
        expectedRevision: 2,
        idempotencyKey: 'not-applicable',
        proposal: {
          taxCalculation: 'NotApplicable',
          lines: [{
            grossCents: -1_000,
            categoryQboId: 'expense',
            taxCodeQboId: 'must-not-survive',
            tagIds: [],
          }],
          tagIds: [],
        },
      },
      {
        companyId,
        transactionId,
        expectedRevision: 2,
        idempotencyKey: 'tax-required',
        proposal: {
          taxCalculation: 'TaxExcluded',
          lines: [{
            grossCents: -1_000,
            categoryQboId: 'expense',
            taxCodeQboId: null,
            tagIds: [],
          }],
          tagIds: [],
        },
      },
      {
        companyId,
        transactionId,
        expectedRevision: 2,
        idempotencyKey: 'extra-key',
        proposal: {
          taxCalculation: 'NotApplicable',
          lines: [{
            grossCents: -1_000,
            categoryQboId: 'expense',
            tagIds: [],
            privateExtra: true,
          }],
          tagIds: [],
        },
      },
    ];

    for (const arguments_ of invalidInputs) {
      const response = await legacy(server, 'tools/call', {
        name: 'prepare_categorization',
        arguments: arguments_,
      });
      expect(response.result.isError).toBe(true);
    }
    expect(operations.prepareCategorization).not.toHaveBeenCalled();
  });

  it('fails closed on invalid service output without logging payload details', async () => {
    const sentinel = 'PRIVATE_MUTATION_OUTPUT_SENTINEL';
    const operations = mutations({
      getOperation: vi.fn().mockResolvedValue({
        ...operation,
        privateUnexpected: sentinel.repeat(10_000),
      }),
    });
    const log = vi.fn();

    const response = await legacy(handler(operations, log), 'tools/call', {
      name: 'get_operation',
      arguments: { operationId },
    });

    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'INVALID_INPUT',
          requestId: 'safe-request-id',
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain(sentinel);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
  });
});
