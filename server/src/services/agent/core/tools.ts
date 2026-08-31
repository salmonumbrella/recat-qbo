import { z } from 'zod';
import type { AgentTransactionSnapshot } from './snapshot.js';

const MAX_TOOL_RESULTS = 20;
const MAX_REQUESTED_RESULTS = 100;
const MAX_QUERY_LENGTH = 160;

export type AgentToolName =
  | 'search_categories'
  | 'list_tax_codes'
  | 'list_rules'
  | 'find_similar_transactions'
  | 'search_classification_knowledge';

interface AgentToolStringSchema {
  readonly type: 'string';
  readonly minLength: number;
  readonly maxLength: number;
}

interface AgentToolIntegerSchema {
  readonly type: 'integer';
  readonly minimum: number;
  readonly maximum: number;
}

interface AgentToolEnumSchema {
  readonly type: 'string';
  readonly enum: readonly ['auto', 'exact', 'lexical', 'hybrid', 'semantic'];
}

type AgentToolPropertySchema = AgentToolStringSchema | AgentToolIntegerSchema | AgentToolEnumSchema;

export interface AgentToolParameters {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, AgentToolPropertySchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface AgentToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: AgentToolName;
    readonly description: string;
    readonly strict: true;
    readonly parameters: AgentToolParameters;
  };
}

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface AgentToolResult<Item = unknown> {
  readonly items: readonly Item[];
  readonly search?: Readonly<{
    query: string;
    scope: 'current_company';
    mode: 'exact' | 'lexical' | 'hybrid' | 'semantic';
    requestedMode: 'auto' | 'exact' | 'lexical' | 'hybrid' | 'semantic';
    degraded: boolean;
    degradedReason: string | null;
    status: 'matched' | 'no_match';
    noMatch: boolean;
    total: number;
  }>;
}

export interface AgentClassificationSearchRequest {
  readonly query: string;
  readonly mode: 'auto' | 'exact' | 'lexical' | 'hybrid' | 'semantic';
  readonly limit: number;
  readonly transaction: Readonly<{
    transactionId: string;
    date: string;
    signedAmountCents: number;
    currency: string;
    sourceAccountName: string;
    payee: string;
    memo: string | null;
  }>;
}

export interface AgentToolDependencies {
  readonly classificationSearch?: (request: AgentClassificationSearchRequest) => Promise<unknown>;
}

export interface AgentToolRegistry {
  readonly definitions: readonly AgentToolDefinition[];
  call(name: string, rawInput: unknown): Promise<AgentToolResult>;
}

export class AgentToolError extends Error {
  constructor(readonly code:
    | 'AGENT_TOOL_UNKNOWN'
    | 'AGENT_TOOL_INVALID_INPUT'
    | 'AGENT_TOOL_INVALID_OUTPUT'
    | 'AGENT_TOOL_UNAVAILABLE') {
    super(
      code === 'AGENT_TOOL_UNKNOWN'
        ? 'Unknown agent tool.'
        : code === 'AGENT_TOOL_INVALID_INPUT'
          ? 'Invalid agent tool input.'
          : code === 'AGENT_TOOL_UNAVAILABLE'
            ? 'Agent tool is unavailable.'
            : 'Invalid agent tool output.',
    );
    this.name = 'AgentToolError';
  }
}

const boundedQuerySchema = z.string()
  .min(1)
  .max(MAX_QUERY_LENGTH * 2)
  .refine((value) => Array.from(value).length <= MAX_QUERY_LENGTH);

const searchInputSchema = z.object({
  query: boundedQuerySchema,
  limit: z.number().int().min(1).max(MAX_REQUESTED_RESULTS),
}).strict();

const emptyInputSchema = z.object({}).strict();

const similarInputSchema = z.object({
  query: boundedQuerySchema,
  limit: z.number().int().min(1).max(MAX_REQUESTED_RESULTS),
}).strict();
const classificationSearchInputSchema = similarInputSchema.extend({
  mode: z.enum(['auto', 'exact', 'lexical', 'hybrid', 'semantic']),
}).strict();

const queryProperties = {
  query: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_QUERY_LENGTH,
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_REQUESTED_RESULTS,
  },
} as const;
const classificationSearchProperties = {
  ...queryProperties,
  mode: {
    type: 'string',
    enum: ['auto', 'exact', 'lexical', 'hybrid', 'semantic'],
  },
} as const;

export const TOOL_DEFINITIONS: readonly AgentToolDefinition[] = deepFreeze([
  {
    type: 'function',
    function: {
      name: 'search_categories',
      description: 'Search the supplied transaction snapshot candidate categories.',
      strict: true,
      parameters: {
        type: 'object',
        properties: queryProperties,
        required: ['query', 'limit'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tax_codes',
      description: 'List eligible tax references from the supplied transaction snapshot.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_rules',
      description: 'List applicable categorization rules from the supplied transaction snapshot.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_similar_transactions',
      description: 'Backward-compatible current-company classification evidence search using auto mode. Returns at most 20 evidence cards; lexical fallback and no-match are explicit. Use only QBO IDs supplied in executable cards.',
      strict: true,
      parameters: {
        type: 'object',
        properties: queryProperties,
        required: ['query', 'limit'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_classification_knowledge',
      description: 'Search up to 20 current-company classification evidence cards using an explicit mode. Auto may return labelled lexical degradation; explicit semantic or hybrid may be unavailable; no evidence returns no_match. Use only QBO IDs supplied in executable current-company cards.',
      strict: true,
      parameters: {
        type: 'object',
        properties: classificationSearchProperties,
        required: ['query', 'limit', 'mode'],
        additionalProperties: false,
      },
    },
  },
]);

export function createSnapshotTools(
  snapshot: AgentTransactionSnapshot,
  dependencies: AgentToolDependencies = {},
): AgentToolRegistry {
  return deepFreeze({
    definitions: TOOL_DEFINITIONS,
    async call(name: string, rawInput: unknown): Promise<AgentToolResult> {
      switch (name) {
        case 'search_categories': {
          const input = parseInput(searchInputSchema, rawInput);
          const query = input.query.toLocaleLowerCase('en-US');
          const items = snapshot.candidateCategories
            .filter((category) => (
              category.name.toLocaleLowerCase('en-US').includes(query)
              || category.qboId.toLocaleLowerCase('en-US').includes(query)
            ))
            .slice(0, resultLimit(input.limit));
          return detachedResult(items);
        }
        case 'list_tax_codes':
          parseInput(emptyInputSchema, rawInput);
          return detachedResult(snapshot.tax.eligibleReferences.slice(0, MAX_TOOL_RESULTS));
        case 'list_rules':
          parseInput(emptyInputSchema, rawInput);
          return detachedResult(snapshot.rules.slice(0, MAX_TOOL_RESULTS));
        case 'find_similar_transactions': {
          const input = parseInput(similarInputSchema, rawInput);
          if (dependencies.classificationSearch !== undefined) {
            return canonicalClassificationResult(snapshot, dependencies, {
              ...input,
              mode: 'auto',
            });
          }
          const query = input.query.toLocaleLowerCase('en-US');
          const items = snapshot.similarVerifiedTransactions
            .filter((transaction) => (
              transaction.payee.toLocaleLowerCase('en-US').includes(query)
              || transaction.memo?.toLocaleLowerCase('en-US').includes(query) === true
            ))
            .slice(0, resultLimit(input.limit));
          return detachedResult(items);
        }
        case 'search_classification_knowledge': {
          const input = parseInput(classificationSearchInputSchema, rawInput);
          if (dependencies.classificationSearch === undefined) {
            throw new AgentToolError('AGENT_TOOL_UNAVAILABLE');
          }
          return canonicalClassificationResult(snapshot, dependencies, input);
        }
        default:
          throw new AgentToolError('AGENT_TOOL_UNKNOWN');
      }
    },
  });
}

const classificationActionSchema = z.object({
  categoryQboId: z.string().min(1).max(120),
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
  taxCodeQboId: z.string().min(1).max(120).nullable(),
  tagIds: z.array(z.string().min(1).max(128)).max(50),
  memo: z.string().max(500).nullable().optional(),
}).strict();
const classificationActionSummarySchema = z.object({
  categoryName: z.string().min(1).max(500),
  taxCalculation: z.enum(['TaxInclusive', 'TaxExcluded', 'NotApplicable']),
  taxCodeName: z.string().min(1).max(500).nullable(),
  tagNames: z.array(z.string().min(1).max(500)).max(50),
}).strict();
const classificationConflictSchema = z.object({
  id: z.string().min(1).max(128),
  companyId: z.string().min(1).max(128),
  sourceId: z.string().min(1).max(128),
  kind: z.enum(['case', 'candidate', 'rule', 'jurisdiction', 'tax']),
  reason: z.string().min(1).max(500),
  action: classificationActionSchema.nullable(),
  actionSummary: classificationActionSummarySchema.nullable(),
  evidenceCount: z.number().int().min(0).max(10_000),
}).strict();
const classificationEvidenceCardSchema = z.object({
  id: z.string().min(1).max(128),
  sourceId: z.string().min(1).max(128),
  kind: z.enum(['vendor_identity', 'vendor_alias', 'classification_case', 'rule', 'rule_candidate']),
  companyId: z.string().min(1).max(128),
  companyName: z.string().min(1).max(200),
  companyRelation: z.literal('current'),
  executable: z.boolean(),
  advisory: z.boolean(),
  matchedIn: z.array(z.enum(['alias', 'rule', 'candidate', 'case', 'lexical', 'semantic'])).min(1).max(6),
  score: z.number().finite().min(0),
  vendorIdentityId: z.string().min(1).max(128).nullable(),
  vendorName: z.string().min(1).max(500).nullable(),
  action: classificationActionSchema.nullable(),
  actionSummary: classificationActionSummarySchema.nullable(),
  originIntent: z.enum(['apply_once', 'make_recurring', 'auto_candidate']).nullable(),
  evidenceCount: z.number().int().min(0).max(10_000),
  conflictingEvidenceCount: z.number().int().min(0).max(10_000),
  conflicts: z.array(classificationConflictSchema).max(20),
  provenance: z.object({
    source: z.enum(['user', 'mcp', 'autopilot', 'qbo_verified', 'rule', 'candidate']),
    sourceId: z.string().min(1).max(128),
    actorId: z.string().min(1).max(128).nullable(),
    recordedAt: z.string().min(1).max(64),
  }).strict(),
  rationale: z.string().min(1).max(2_000).nullable(),
  examples: z.array(z.string().min(1).max(500)).max(20),
  counterexamples: z.array(z.string().min(1).max(500)).max(20),
  jurisdiction: z.string().min(1).max(128).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/u).nullable(),
  verifiedAt: z.string().min(1).max(64).nullable(),
  ruleRevision: z.number().int().min(0).nullable(),
}).strict();
const canonicalClassificationResultSchema = z.object({
  query: z.string().min(1).max(256),
  companyId: z.string().min(1).max(128),
  scope: z.literal('current_company'),
  mode: z.enum(['exact', 'lexical', 'hybrid', 'semantic']),
  requestedMode: z.enum(['auto', 'exact', 'lexical', 'hybrid', 'semantic']),
  degraded: z.boolean(),
  degradedReason: z.enum([
    'semantic_unavailable', 'vector_capability_unavailable', 'embedding_not_configured',
    'lexical_only', 'semantic_error',
  ]).nullable(),
  status: z.enum(['matched', 'no_match']),
  noMatch: z.boolean(),
  hits: z.array(classificationEvidenceCardSchema).max(MAX_TOOL_RESULTS),
  total: z.number().int().min(0).max(10_000),
}).strict();
const agentClassificationToolResultSchema = z.object({
  items: z.array(classificationEvidenceCardSchema).max(MAX_TOOL_RESULTS),
  search: canonicalClassificationResultSchema.omit({ companyId: true, hits: true }),
}).strict();

export function parseAgentClassificationToolResult(raw: unknown): AgentToolResult {
  const parsed = agentClassificationToolResultSchema.safeParse(raw);
  if (!parsed.success) throw new AgentToolError('AGENT_TOOL_INVALID_OUTPUT');
  return deepFreeze(clonePlainValue(parsed.data));
}

async function canonicalClassificationResult(
  snapshot: AgentTransactionSnapshot,
  dependencies: AgentToolDependencies,
  input: { query: string; limit: number; mode: 'auto' | 'exact' | 'lexical' | 'hybrid' | 'semantic' },
): Promise<AgentToolResult> {
  let raw: unknown;
  try {
    raw = await dependencies.classificationSearch?.({
      query: input.query,
      mode: input.mode,
      limit: resultLimit(input.limit),
      transaction: {
        transactionId: snapshot.transaction.id,
        date: snapshot.date,
        signedAmountCents: snapshot.signedAmountCents,
        currency: snapshot.currency,
        sourceAccountName: snapshot.sourceAccount.displayName,
        payee: snapshot.payee,
        memo: snapshot.memo ?? null,
      },
    });
  } catch {
    throw new AgentToolError('AGENT_TOOL_UNAVAILABLE');
  }
  const parsed = canonicalClassificationResultSchema.safeParse(raw);
  if (!parsed.success) throw new AgentToolError('AGENT_TOOL_INVALID_OUTPUT');
  const { hits, companyId: _companyId, ...search } = parsed.data;
  return parseAgentClassificationToolResult({ items: hits, search });
}

function resultLimit(requested: number): number {
  return Math.min(requested, MAX_TOOL_RESULTS);
}

function parseInput<Schema extends z.ZodTypeAny>(schema: Schema, rawInput: unknown): z.infer<Schema> {
  try {
    const safeInput = extractPlainDataRecord(rawInput);
    const parsed = schema.safeParse(safeInput);
    if (!parsed.success) throw new Error('invalid');
    return parsed.data;
  } catch {
    throw new AgentToolError('AGENT_TOOL_INVALID_INPUT');
  }
}

function extractPlainDataRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid');

  const safeRecord = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error('invalid');
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('invalid');
    }
    Object.defineProperty(safeRecord, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return safeRecord;
}

function detachedResult<Item>(items: readonly Item[]): AgentToolResult<Item> {
  return deepFreeze({
    items: items.map((item) => clonePlainValue(item)),
  });
}

function clonePlainValue<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return value.map((item) => clonePlainValue(item)) as Value;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clonePlainValue(item)]),
    ) as Value;
  }
  return value;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
