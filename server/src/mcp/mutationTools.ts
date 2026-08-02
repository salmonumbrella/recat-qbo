import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod-v4';
import {
  prepareMcpCategorization,
  type PrepareMcpCategorizationInput,
} from '../services/mcp/categorization.js';
import {
  commitMcpCategorization,
  commitMcpUndo,
  getMcpOperation,
  retryMcpOperation,
  type CommitMcpCategorizationInput,
  type CommitMcpUndoInput,
  type GetMcpOperationInput,
  type RetryMcpOperationInput,
} from '../services/mcp/reconciliation.js';
import {
  prepareMcpUndo,
  type PrepareMcpUndoInput,
} from '../services/mcp/undo.js';
import type { McpPrincipal } from './auth.js';
import {
  MCP_AUTHORED_SCHEMA_BOUNDS,
  toBoundedJsonSchema,
} from './schemaBounds.js';

export const MUTATION_TOOL_NAMES = [
  'prepare_categorization',
  'commit_categorization',
  'get_operation',
  'retry_operation',
  'prepare_undo',
  'commit_undo',
] as const;

export interface McpMutationOperations {
  prepareCategorization(
    principal: McpPrincipal,
    input: PrepareMcpCategorizationInput,
  ): ReturnType<typeof prepareMcpCategorization>;
  commitCategorization(
    principal: McpPrincipal,
    input: CommitMcpCategorizationInput,
  ): ReturnType<typeof commitMcpCategorization>;
  getOperation(
    principal: McpPrincipal,
    input: GetMcpOperationInput,
  ): ReturnType<typeof getMcpOperation>;
  retryOperation(
    principal: McpPrincipal,
    input: RetryMcpOperationInput,
  ): ReturnType<typeof retryMcpOperation>;
  prepareUndo(
    principal: McpPrincipal,
    input: PrepareMcpUndoInput,
  ): ReturnType<typeof prepareMcpUndo>;
  commitUndo(
    principal: McpPrincipal,
    input: CommitMcpUndoInput,
  ): ReturnType<typeof commitMcpUndo>;
}

export const mcpMutationOperations: McpMutationOperations = Object.freeze({
  prepareCategorization: prepareMcpCategorization,
  commitCategorization: commitMcpCategorization,
  getOperation: getMcpOperation,
  retryOperation: retryMcpOperation,
  prepareUndo: prepareMcpUndo,
  commitUndo: commitMcpUndo,
});

interface McpMutationToolDefinition {
  name: typeof MUTATION_TOOL_NAMES[number];
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  invoke(
    operations: McpMutationOperations,
    principal: McpPrincipal,
    input: unknown,
  ): Promise<unknown>;
}

const MAX_EXPECTED_REVISION = 2_147_483_646;
const MAX_REVISION = 2_147_483_647;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_QBO_REFERENCE_LENGTH = 120;
const MAX_MEMO_LENGTH = 500;
const MAX_TAGS = 50;
const MAX_LINES = 20;
const MAX_WARNINGS = 20;
const MAX_WARNING_LENGTH = 200;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

const uuid = z.string().uuid();
const revision = z.number().int().min(0).max(MAX_REVISION);
const safeInteger = z.number().int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const idempotencyKey = z.string()
  .trim()
  .min(1)
  .max(MAX_IDEMPOTENCY_KEY_LENGTH)
  .regex(SAFE_TEXT)
  .refine((value) => value === value.normalize('NFC'));
const qboReference = z.string()
  .trim()
  .min(1)
  .max(MAX_QBO_REFERENCE_LENGTH);
const uniqueTagIds = z.array(uuid).max(MAX_TAGS)
  .refine((values) => new Set(values).size === values.length);
const proposalLine = z.strictObject({
  grossCents: safeInteger,
  categoryQboId: qboReference,
  taxCodeQboId: qboReference.nullable().optional(),
  memo: z.string().max(MAX_MEMO_LENGTH).optional(),
  tagIds: uniqueTagIds,
});
const proposal = z.strictObject({
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
  lines: z.array(proposalLine).min(1).max(MAX_LINES),
  tagIds: uniqueTagIds,
}).superRefine((value, context) => {
  for (const [index, line] of value.lines.entries()) {
    if (
      value.taxCalculation === 'NotApplicable'
      && line.taxCodeQboId != null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'NotApplicable lines cannot select a tax code.',
        path: ['lines', index, 'taxCodeQboId'],
      });
    }
    if (
      value.taxCalculation !== 'NotApplicable'
      && line.taxCodeQboId == null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Taxed lines require a tax code.',
        path: ['lines', index, 'taxCodeQboId'],
      });
    }
  }
});

const prepareCategorizationInput = z.strictObject({
  companyId: uuid,
  transactionId: uuid,
  expectedRevision: z.number().int().min(0).max(MAX_EXPECTED_REVISION),
  idempotencyKey,
  proposal,
});
const operationWithOptionalIdempotencyInput = z.strictObject({
  operationId: uuid,
  idempotencyKey: idempotencyKey.optional(),
});
const operationInput = z.strictObject({ operationId: uuid });
const prepareUndoInput = z.strictObject({
  operationId: uuid,
  idempotencyKey,
});

const warnings = z.array(
  z.string().max(MAX_WARNING_LENGTH),
).max(MAX_WARNINGS);
const previewLine = z.strictObject({
  idx: z.number().int().min(0).max(MAX_LINES - 1),
  subtotalCents: safeInteger,
  taxCents: safeInteger,
  totalCents: safeInteger,
});
const preparedCategorizationOutput = z.strictObject({
  operationId: uuid,
  expiresAt: z.iso.datetime(),
  sourceRevision: revision,
  preparedRevision: z.number().int().min(1).max(MAX_REVISION),
  preview: z.strictObject({
    transactionId: uuid,
    revision: z.number().int().min(1).max(MAX_REVISION),
    taxCalculation: z.enum([
      'TaxInclusive',
      'TaxExcluded',
      'NotApplicable',
    ]),
    totals: z.strictObject({
      subtotalCents: safeInteger,
      taxCents: safeInteger,
      totalCents: safeInteger,
    }),
    lines: z.array(previewLine).min(1).max(MAX_LINES),
    transactionTagCount: z.number().int().min(0).max(MAX_TAGS),
    lineTagCount: z.number().int().min(0).max(MAX_LINES * MAX_TAGS),
  }),
  warnings,
});

const operationResult = z.strictObject({
  outcome: z.enum([
    'VERIFIED',
    'UNCERTAIN',
    'IN_PROGRESS',
    'UNCHANGED',
    'DRY_RUN',
    'RETRYABLE',
  ]),
  status: z.enum([
    'PENDING',
    'POSTING',
    'POSTED',
    'DRY_RUN',
    'ERROR',
    'SUPERSEDED',
    'REVERTED',
  ]),
});
const operationOutput = z.strictObject({
  operationId: uuid,
  kind: z.enum(['categorization', 'undo']),
  companyId: uuid,
  transactionId: uuid,
  sourceRevision: revision,
  preparedRevision: revision,
  expiresAt: z.iso.datetime(),
  state: z.enum([
    'prepared',
    'committed',
    'retryable',
    'reconciliation_required',
    'expired',
    'cancelled',
  ]),
  phase: z.enum([
    'awaiting_commit',
    'write_prepared',
    'write_committing',
    'write_uncertain',
    'write_retryable',
    'write_unchanged',
    'verified',
    'dry_run',
    'corrupt',
  ]),
  result: operationResult.nullable(),
  error: z.strictObject({
    code: z.string().min(1).max(64),
    message: z.string().max(200),
  }).nullable(),
  actions: z.strictObject({
    canCommit: z.boolean(),
    canRetry: z.boolean(),
    requiresReconciliation: z.boolean(),
  }),
});
const preparedUndoOutput = z.strictObject({
  operationId: uuid,
  sourceOperationId: uuid,
  expiresAt: z.iso.datetime(),
  preview: z.strictObject({
    action: z.literal('restore_purchase_categorization'),
    resultingStatus: z.literal('REVERTED'),
    direction: z.enum(['purchase', 'refund']),
    totalCents: safeInteger,
    totalTaxCents: safeInteger.nullable(),
    lineCount: z.number().int().min(0).max(10_000),
    restorationDigest: z.string().regex(SHA256),
  }),
  warnings,
});

const prepareCategorizationAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
});
const commitAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
});
const getOperationAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const prepareUndoAnnotations: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

export const mutationToolDefinitions: readonly McpMutationToolDefinition[] = [
  {
    name: 'prepare_categorization',
    description: 'Validate and prepare a categorization operation.',
    inputSchema: prepareCategorizationInput,
    outputSchema: preparedCategorizationOutput,
    annotations: prepareCategorizationAnnotations,
    invoke: (operations, principal, input) =>
      operations.prepareCategorization(
        principal,
        input as PrepareMcpCategorizationInput,
      ),
  },
  {
    name: 'commit_categorization',
    description: 'Commit a prepared categorization operation.',
    inputSchema: operationWithOptionalIdempotencyInput,
    outputSchema: operationOutput,
    annotations: commitAnnotations,
    invoke: (operations, principal, input) =>
      operations.commitCategorization(
        principal,
        input as CommitMcpCategorizationInput,
      ),
  },
  {
    name: 'get_operation',
    description: 'Get the current state of an owned MCP operation.',
    inputSchema: operationInput,
    outputSchema: operationOutput,
    annotations: getOperationAnnotations,
    invoke: (operations, principal, input) =>
      operations.getOperation(principal, input as GetMcpOperationInput),
  },
  {
    name: 'retry_operation',
    description: 'Safely retry or reconcile an owned MCP operation.',
    inputSchema: operationInput,
    outputSchema: operationOutput,
    annotations: commitAnnotations,
    invoke: (operations, principal, input) =>
      operations.retryOperation(principal, input as RetryMcpOperationInput),
  },
  {
    name: 'prepare_undo',
    description: 'Prepare an undo for a verified categorization operation.',
    inputSchema: prepareUndoInput,
    outputSchema: preparedUndoOutput,
    annotations: prepareUndoAnnotations,
    invoke: (operations, principal, input) =>
      operations.prepareUndo(principal, input as PrepareMcpUndoInput),
  },
  {
    name: 'commit_undo',
    description: 'Commit a prepared undo operation.',
    inputSchema: operationWithOptionalIdempotencyInput,
    outputSchema: operationOutput,
    annotations: commitAnnotations,
    invoke: (operations, principal, input) =>
      operations.commitUndo(principal, input as CommitMcpUndoInput),
  },
] as const;

for (const { inputSchema, outputSchema } of mutationToolDefinitions) {
  toBoundedJsonSchema(inputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
  toBoundedJsonSchema(outputSchema, MCP_AUTHORED_SCHEMA_BOUNDS);
}
