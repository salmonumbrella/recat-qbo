import { z } from 'zod';
import type { AgentTransactionSnapshot } from './snapshot.js';

const MAX_TOOL_RESULTS = 20;
const MAX_REQUESTED_RESULTS = 100;
const MAX_QUERY_LENGTH = 160;

export type AgentToolName =
  | 'search_categories'
  | 'list_tax_codes'
  | 'list_rules'
  | 'find_similar_transactions';

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

type AgentToolPropertySchema = AgentToolStringSchema | AgentToolIntegerSchema;

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
}

export interface AgentToolRegistry {
  readonly definitions: readonly AgentToolDefinition[];
  call(name: string, rawInput: unknown): Promise<AgentToolResult>;
}

export class AgentToolError extends Error {
  constructor(readonly code: 'AGENT_TOOL_UNKNOWN' | 'AGENT_TOOL_INVALID_INPUT') {
    super(code === 'AGENT_TOOL_UNKNOWN' ? 'Unknown agent tool.' : 'Invalid agent tool input.');
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
      description: 'Search bounded verified history from the supplied transaction snapshot.',
      strict: true,
      parameters: {
        type: 'object',
        properties: queryProperties,
        required: ['query', 'limit'],
        additionalProperties: false,
      },
    },
  },
]);

export function createSnapshotTools(snapshot: AgentTransactionSnapshot): AgentToolRegistry {
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
          const query = input.query.toLocaleLowerCase('en-US');
          const items = snapshot.similarVerifiedTransactions
            .filter((transaction) => (
              transaction.payee.toLocaleLowerCase('en-US').includes(query)
              || transaction.memo?.toLocaleLowerCase('en-US').includes(query) === true
            ))
            .slice(0, resultLimit(input.limit));
          return detachedResult(items);
        }
        default:
          throw new AgentToolError('AGENT_TOOL_UNKNOWN');
      }
    },
  });
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
