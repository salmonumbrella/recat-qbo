import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  SpanStatusCode,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/http.js';
import { ClassificationSearchError } from '../services/classification/search.js';
import {
  READ_TOOL_NAMES,
  createRecatMcpServer,
  type CompanyReadOperations,
} from './readTools.js';

const principal = Object.freeze({
  tokenId: 'token-a',
  tokenPrefix: 'rct_SAFE',
  userId: 'user-a',
  isInstanceAdmin: false,
  memberships: Object.freeze([{ companyId: 'company-a', role: 'viewer' }]),
});

const sampleTransaction = {
  id: 'transaction-a',
  companyId: 'company-a',
  qboId: 'qbo-a',
  qboType: 'Purchase' as const,
  date: '2026-01-01T00:00:00.000Z',
  payee: 'Vendor',
  memo: null,
  amount: -10,
  bankAccount: 'Checking',
  status: 'POSTED' as const,
  revision: 1,
  category: null,
  categoryQboId: null,
  taxCalculation: null,
  taxCode: null,
  taxCodeQboId: null,
  splits: null,
  tagIds: [],
  suggestion: null,
  error: null,
  postedAt: null,
  postedBy: null,
  activeCategorizationAttempt: null,
  transferCandidateId: null,
  verification: {
    status: 'verified' as const,
    outcome: 'VERIFIED' as const,
    summary: 'Verified.',
  },
};

function evidenceCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'case:case-a', sourceId: 'case-a', kind: 'classification_case' as const,
    companyId: 'company-a', companyName: 'Company A', companyRelation: 'current' as const,
    executable: true, advisory: false, matchedIn: ['lexical'] as const, score: 1,
    vendorIdentityId: null, vendorName: 'Coffee',
    action: { categoryQboId: 'account-a', taxCalculation: 'NotApplicable' as const, taxCodeQboId: null, tagIds: [] },
    actionSummary: { categoryName: 'Meals', taxCalculation: 'NotApplicable' as const, taxCodeName: null, tagNames: [] },
    originIntent: 'apply_once' as const, evidenceCount: 1, conflictingEvidenceCount: 0,
    conflicts: [], provenance: { source: 'qbo_verified' as const, sourceId: 'case-a', actorId: null, recordedAt: '2026-01-01T00:00:00.000Z' },
    rationale: 'Verified.', examples: [], counterexamples: [], jurisdiction: 'unknown',
    currency: 'CAD', verifiedAt: '2026-01-01T00:00:00.000Z', ruleRevision: null,
    ...overrides,
  };
}

function reads(): CompanyReadOperations {
  return {
    listCompanies: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listTransactions: vi.fn().mockResolvedValue({ items: [], nextCursor: null, pendingCount: 0 }),
    getTransaction: vi.fn().mockResolvedValue(sampleTransaction),
    listCategories: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listTaxCodes: vi.fn().mockResolvedValue({
      status: 'ready',
      reason: null,
      usingSalesTax: true,
      refreshedAt: null,
      items: [],
      nextCursor: null,
    }),
    listTags: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listRules: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getRule: vi.fn().mockResolvedValue({
      active: false,
      executable: false,
      reviewRequiredAt: null,
      reviewReason: null,
      revision: {
        id: 'revision-a', ruleId: 'rule-a', companyId: 'company-a', revision: 2,
        state: 'retired', condition: { matchField: 'payee', matchText: 'Coffee' },
        action: { categoryQboId: 'account-a', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
        categoryName: 'Meals', taxCodeName: null, priority: 0, autoPost: false,
        originIntent: 'make_recurring', sourceCaseId: 'case-a', sourceCandidateId: null,
        changedBy: null, createdAt: '2026-01-01T00:00:00.000Z', retiredAt: '2026-01-02T00:00:00.000Z',
      },
    }),
    testRule: vi.fn().mockResolvedValue({
      samples: [], nextCursor: null, pendingCount: 0, postedCount: 0,
      conflicts: [], conflictsTruncated: false,
    }),
    listRuleCandidates: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getRuleCandidate: vi.fn().mockResolvedValue({
      id: 'candidate-a', companyId: 'company-a', state: 'conflict', matchField: 'payee',
      matchText: 'Coffee', categoryName: 'Meals', taxCodeName: null,
      action: { categoryQboId: 'account-a', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
      executable: false, advisory: true, evidenceCount: 3, conflictingEvidenceCount: 1,
      schemaVersion: 'rule-candidate-v1', configVersion: 'config-a', activatedRuleId: null,
      updatedAt: '2026-01-01T00:00:00.000Z', evidence: [],
    }),
    getClassificationCase: vi.fn().mockResolvedValue({
      id: 'case-a', companyId: 'company-a', transactionId: 'transaction-a', vendorIdentityId: null,
      qboMutationAttemptId: 'attempt-a',
      action: { categoryQboId: 'account-a', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
      actionFingerprint: 'a'.repeat(64), originIntent: 'apply_once', rationale: 'Verified classification.',
      requiredEvidence: [], examples: [], counterexamples: [], citations: [],
      reviewer: { userId: null, configVersion: 'config-a', decision: 'approved' },
      jurisdiction: 'unknown', currency: 'CAD',
      context: { transactionDirection: 'out', qboType: 'Purchase', sourceAccountName: null, businessPurpose: null },
      provenance: { source: 'qbo_verified', sourceId: 'attempt-a', actorId: null, recordedAt: '2026-01-01T00:00:00.000Z' },
      verifiedAt: '2026-01-01T00:00:00.000Z', invalidatedAt: null, invalidationReason: null,
    }),
    searchClassificationKnowledge: vi.fn().mockResolvedValue({
      query: 'Coffee', companyId: 'company-a', scope: 'current_company',
      mode: 'lexical', requestedMode: 'lexical', degraded: false, degradedReason: null,
      status: 'no_match', noMatch: true, total: 0, items: [], nextCursor: null,
    }),
    listTransferCandidates: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
}

async function legacy(handler: ReturnType<typeof createMcpHandler>, method: string, params: object) {
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

describe('Recat MCP read tools', () => {
  it('does not rerun static schema deadline checks for concurrent fresh servers', async () => {
    let simulatedNow = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => {
      simulatedNow += 100;
      return simulatedNow;
    });

    try {
      const payloads = await Promise.all(
        Array.from({ length: 16 }, async (_, index) => {
          await Promise.resolve();
          const handler = createMcpHandler(
            () => createRecatMcpServer({
              principal: {
                ...principal,
                userId: `concurrent-${index}`,
              },
              era: 'legacy',
              reads: reads(),
              log: vi.fn(),
            }),
            { legacy: 'stateless' },
          );
          return legacy(handler, 'tools/call', {
            name: 'get_identity',
            arguments: {},
          });
        }),
      );

      expect(payloads.map((payload) =>
        payload.result.structuredContent.identity.userId,
      )).toEqual(
        Array.from({ length: 16 }, (_, index) => `concurrent-${index}`),
      );
    } finally {
      now.mockRestore();
    }
  });

  it('registers exactly fifteen core reads and twenty conservatively annotated action tools', async () => {
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: reads() }),
      { legacy: 'stateless' },
    );
    const body = await legacy(handler, 'tools/list', {});
    const tools = body.result.tools as Array<Record<string, any>>;

    expect(tools.map((tool) => tool.name)).toEqual([
      ...READ_TOOL_NAMES,
      'prepare_categorization',
      'commit_categorization',
      'get_operation',
      'retry_operation',
      'prepare_undo',
      'commit_undo',
      'prepare_transfer',
      'commit_transfer',
      'create_attachment_upload',
      'attach_transaction_files',
      'list_transaction_attachments',
      'get_attachment_download',
      'delete_transaction_attachment',
      'create_receipt_upload',
      'ingest_receipt',
      'list_receipts',
      'get_receipt',
      'list_receipt_matches',
      'confirm_receipt_match',
      'attach_receipt',
    ]);
    expect(tools).toHaveLength(35);
    for (const tool of tools.slice(0, READ_TOOL_NAMES.length)) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(tools.slice(READ_TOOL_NAMES.length).map((tool) => ({
      name: tool.name,
      annotations: tool.annotations,
    }))).toEqual([
      {
        name: 'prepare_categorization',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'commit_categorization',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'get_operation',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'retry_operation',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'prepare_undo',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: 'commit_undo',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'prepare_transfer',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: 'commit_transfer',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'create_attachment_upload',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'attach_transaction_files',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'list_transaction_attachments',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'get_attachment_download',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: 'delete_transaction_attachment',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'create_receipt_upload',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'ingest_receipt',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      ...['list_receipts', 'get_receipt', 'list_receipt_matches'].map((name) => ({
        name,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      })),
      {
        name: 'confirm_receipt_match',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'attach_receipt',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ]);
    const listTransactions = tools.find((tool) => tool.name === 'list_transactions')!;
    expect(listTransactions.inputSchema.properties.limit.maximum).toBe(100);
    expect(listTransactions.inputSchema.properties.cursor.maxLength).toBe(2048);
    expect(listTransactions.outputSchema.additionalProperties).toBe(false);
    expect(tools.every((tool) => tool.outputSchema.additionalProperties === false)).toBe(true);
  });

  it('routes the six classification reads with bounded pagination and explicit search semantics', async () => {
    const operations = reads();
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );
    const calls = [
      ['get_rule', { companyId: 'company-a', ruleId: 'rule-a' }],
      ['test_rule', { companyId: 'company-a', matchText: 'Coffee', limit: 5 }],
      ['list_rule_candidates', { companyId: 'company-a', limit: 5 }],
      ['get_rule_candidate', { companyId: 'company-a', candidateId: 'candidate-a' }],
      ['get_classification_case', { companyId: 'company-a', caseId: 'case-a' }],
      ['search_classification_knowledge', {
        companyId: 'company-a', query: 'Coffee', scope: 'current_company', mode: 'lexical', limit: 5,
      }],
    ] as const;
    for (const [name, arguments_] of calls) {
      const response = await legacy(handler, 'tools/call', { name, arguments: arguments_ });
      expect(response.result.isError, name).not.toBe(true);
    }
    expect(operations.getRule).toHaveBeenCalledWith('user-a', 'company-a', 'rule-a');
    expect(operations.testRule).toHaveBeenCalledWith('user-a', 'company-a', {
      matchText: 'Coffee', limit: 5,
    });
    expect(operations.searchClassificationKnowledge).toHaveBeenCalledWith(
      'user-a', 'company-a',
      { query: 'Coffee', scope: 'current_company', mode: 'lexical', limit: 5 },
    );
  });

  it('rejects oversized classification inputs before service execution', async () => {
    const operations = reads();
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );
    const response = await legacy(handler, 'tools/call', {
      name: 'search_classification_knowledge',
      arguments: {
        companyId: 'company-a', query: 'x'.repeat(257), mode: 'lexical',
      },
    });
    expect(response.result.isError).toBe(true);
    expect(operations.searchClassificationKnowledge).not.toHaveBeenCalled();
  });

  it('rejects foreign evidence carrying executable action identifiers', async () => {
    const outputSentinel = 'FOREIGN_ACCOUNT_SENTINEL';
    const operations = reads();
    vi.mocked(operations.searchClassificationKnowledge).mockResolvedValueOnce({
      query: 'Coffee', companyId: 'company-a', scope: 'accessible_companies',
      mode: 'lexical', requestedMode: 'lexical', degraded: false, degradedReason: null,
      status: 'matched', noMatch: false, total: 1, nextCursor: null,
      items: [evidenceCard({
        companyId: 'company-b', companyName: 'Company B', companyRelation: 'foreign',
        executable: false, advisory: true,
        action: { categoryQboId: outputSentinel, taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
      })] as never,
    });
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'search_classification_knowledge',
      arguments: { companyId: 'company-a', query: 'Coffee', scope: 'accessible_companies', mode: 'lexical' },
    });

    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_INPUT' } },
    });
    expect(JSON.stringify(response)).not.toContain(outputSentinel);
  });

  it('fails explicit semantic unavailability closed with a small safe error', async () => {
    const operations = reads();
    vi.mocked(operations.searchClassificationKnowledge).mockRejectedValueOnce(
      new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'embedding_not_configured'),
    );
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'search_classification_knowledge',
      arguments: { companyId: 'company-a', query: 'Coffee', mode: 'semantic' },
    });

    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'COMPANY_UNAVAILABLE' } },
    });
    expect(JSON.stringify(response)).not.toContain('embedding_not_configured');
  });

  it('keeps concurrent search principals and company scopes isolated', async () => {
    const seen: Array<{ userId: string; companyId: string }> = [];
    const payloads = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      const userId = `user-${index}`;
      const companyId = `company-${index}`;
      const operations = reads();
      vi.mocked(operations.searchClassificationKnowledge).mockImplementationOnce(async (
        receivedUserId,
        receivedCompanyId,
      ) => {
        seen.push({ userId: receivedUserId, companyId: receivedCompanyId });
        return {
          query: 'Coffee', companyId: receivedCompanyId, scope: 'current_company',
          mode: 'lexical', requestedMode: 'lexical', degraded: false, degradedReason: null,
          status: 'no_match', noMatch: true, total: 0, items: [], nextCursor: null,
        };
      });
      const handler = createMcpHandler(
        () => createRecatMcpServer({
          principal: { ...principal, userId, memberships: [{ companyId, role: 'viewer' }] },
          era: 'legacy',
          reads: operations,
        }),
        { legacy: 'stateless' },
      );
      return legacy(handler, 'tools/call', {
        name: 'search_classification_knowledge',
        arguments: { companyId, query: 'Coffee', mode: 'lexical' },
      });
    }));

    expect(payloads.every((payload) => payload.result.isError !== true)).toBe(true);
    expect(seen.sort((left, right) => left.userId.localeCompare(right.userId))).toEqual(
      Array.from({ length: 16 }, (_, index) => ({ userId: `user-${index}`, companyId: `company-${index}` }))
        .sort((left, right) => left.userId.localeCompare(right.userId)),
    );
  });

  it('replaces schema-valid but oversized evidence output with a bounded safe failure', async () => {
    const outputSentinel = 'LARGE_VALID_EVIDENCE_SENTINEL';
    const operations = reads();
    vi.mocked(operations.searchClassificationKnowledge).mockResolvedValueOnce({
      query: 'Coffee', companyId: 'company-a', scope: 'current_company',
      mode: 'lexical', requestedMode: 'lexical', degraded: false, degradedReason: null,
      status: 'matched', noMatch: false, total: 100, nextCursor: null,
      items: Array.from({ length: 100 }, (_, index) => evidenceCard({
        id: `case:${index}`,
        sourceId: `case-${index}`,
        examples: Array.from({ length: 20 }, () => outputSentinel.repeat(50)),
      })) as never,
    });
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'search_classification_knowledge',
      arguments: { companyId: 'company-a', query: 'Coffee', mode: 'lexical', limit: 100 },
    });

    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_INPUT' } },
    });
    expect(JSON.stringify(response)).not.toContain(outputSentinel);
  });

  it('routes reads with the fresh principal and rejects unknown fields', async () => {
    const operations = reads();
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );

    const ok = await legacy(handler, 'tools/call', {
      name: 'list_companies',
      arguments: { limit: 2 },
    });
    expect(operations.listCompanies).toHaveBeenCalledWith('user-a', { limit: 2 });
    expect(ok.result.isError).not.toBe(true);

    const invalid = await legacy(handler, 'tools/call', {
      name: 'list_companies',
      arguments: { limit: 2, extra: true },
    });
    expect(invalid.result.isError).toBe(true);
    expect(operations.listCompanies).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ startDate: '2025-02-29' }, 'real date'],
    [{ endDate: '2026-02-30' }, 'real date'],
    [{ startDate: '2025-01-01', endDate: '2026-01-03' }, '366 days'],
  ])('rejects invalid transaction date bounds before calling services: %s', async (dates) => {
    const operations = reads();
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'list_transactions',
      arguments: { companyId: 'company-a', ...dates },
    });

    expect(response.result.isError).toBe(true);
    expect(operations.listTransactions).not.toHaveBeenCalled();
  });

  it('returns a deterministic maximum of 100 memberships with total and truncation metadata', async () => {
    const memberships = Array.from({ length: 105 }, (_, index) => ({
      companyId: `company-${String(104 - index).padStart(3, '0')}`,
      role: 'viewer',
    }));
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal: Object.freeze({ ...principal, memberships: Object.freeze(memberships) }),
        era: 'legacy',
        reads: reads(),
      }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'get_identity',
      arguments: {},
    });
    const identity = response.result.structuredContent.identity;

    expect(identity.memberships).toHaveLength(100);
    expect(identity.memberships[0].companyId).toBe('company-000');
    expect(identity.memberships[99].companyId).toBe('company-099');
    expect(identity).toMatchObject({
      totalMemberships: 105,
      membershipsTruncated: true,
    });
  });

  it('routes every company read tool, forwards pagination, and safely reports authorization failures', async () => {
    const operations = reads();
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations, log: vi.fn() }),
      { legacy: 'stateless' },
    );
    const calls = [
      ['list_companies', { limit: 1, cursor: 'cursor-a' }],
      ['list_transactions', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
      ['get_transaction', { companyId: 'company-a', transactionId: 'transaction-a' }],
      ['list_categories', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
      ['list_tax_codes', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
      ['list_tags', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
      ['list_rules', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
      ['list_transfer_candidates', { companyId: 'company-a', limit: 1, cursor: 'cursor-a' }],
    ] as const;

    for (const [name, arguments_] of calls) {
      const response = await legacy(handler, 'tools/call', { name, arguments: arguments_ });
      expect(response.result.isError, name).not.toBe(true);
    }
    expect(operations.listCompanies).toHaveBeenCalledWith(
      'user-a',
      { limit: 1, cursor: 'cursor-a' },
    );
    expect(operations.listTransactions).toHaveBeenCalledWith(
      'user-a',
      'company-a',
      { limit: 1, cursor: 'cursor-a' },
    );

    vi.mocked(operations.listRules).mockRejectedValueOnce(
      new HttpError(403, 'PRIVATE_ROLE_SENTINEL', 'FORBIDDEN'),
    );
    const denied = await legacy(handler, 'tools/call', {
      name: 'list_rules',
      arguments: { companyId: 'company-a' },
    });
    expect(denied.result.structuredContent.error).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(denied.result.structuredContent.error.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(denied.result.structuredContent.error.requestId).not.toBe('1');
    expect(JSON.stringify(denied)).not.toContain('PRIVATE_ROLE_SENTINEL');

    const oversized = await legacy(handler, 'tools/call', {
      name: 'list_tags',
      arguments: { companyId: 'company-a', limit: 101 },
    });
    expect(oversized.result.isError).toBe(true);
  });

  it('returns non-empty rule review state and activation provenance', async () => {
    const operations = reads();
    vi.mocked(operations.listRules).mockResolvedValueOnce({
      items: [{
        id: 'rule-a',
        companyId: 'company-a',
        priority: 0,
        matchField: 'payee',
        matchText: 'Coffee',
        category: 'Meals',
        categoryQboId: 'account-a',
        taxCalculation: null,
        taxCode: null,
        taxCodeQboId: null,
        tagIds: [],
        autoPost: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        reviewRequiredAt: '2026-01-02T00:00:00.000Z',
        reviewReason: 'Verified outcomes now conflict with this learned rule.',
        origin: {
          candidateId: 'candidate-a',
          evidenceCount: 3,
          schemaVersion: 'schema-v1',
          configVersion: 'config-v2',
        },
        valid: true,
        invalidReasons: [],
      }],
      nextCursor: null,
    });
    const handler = createMcpHandler(
      () => createRecatMcpServer({ principal, era: 'legacy', reads: operations }),
      { legacy: 'stateless' },
    );

    const response = await legacy(handler, 'tools/call', {
      name: 'list_rules',
      arguments: { companyId: 'company-a' },
    });

    expect(response.result.isError).not.toBe(true);
    expect(response.result.structuredContent.items).toEqual([
      expect.objectContaining({
        reviewRequiredAt: '2026-01-02T00:00:00.000Z',
        reviewReason: 'Verified outcomes now conflict with this learned rule.',
        origin: {
          candidateId: 'candidate-a',
          evidenceCount: 3,
          schemaVersion: 'schema-v1',
          configVersion: 'config-v2',
        },
      }),
    ]);
  });

  it('replaces a large invalid service output with one small safe failure', async () => {
    const outputSentinel = 'PRIVATE_LARGE_OUTPUT_SENTINEL';
    const operations = reads();
    vi.mocked(operations.listCompanies).mockResolvedValueOnce({
      items: [{
        unexpected: outputSentinel.repeat(100_000),
      }] as never,
      nextCursor: null,
    });
    const log = vi.fn();
    const span = {
      setStatus: vi.fn().mockReturnThis(),
      end: vi.fn(),
    } as unknown as Span;
    const tracer = {
      startSpan: vi.fn(() => span),
    } as unknown as Tracer;
    const handler = createMcpHandler(
      () => createRecatMcpServer({
        principal,
        era: 'legacy',
        reads: operations,
        requestId: 'safe-request-id',
        log,
        tracer,
      }),
      { legacy: 'stateless' },
    );
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'large-invalid-output',
        method: 'tools/call',
        params: {
          name: 'list_companies',
          arguments: {},
        },
      }),
    }));
    const text = await response.text();
    const data = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
      : text;
    const payload = JSON.parse(data ?? '') as Record<string, any>;

    expect(Buffer.byteLength(text)).toBeLessThan(16 * 1_024);
    expect(text).not.toContain(outputSentinel);
    expect(payload.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'INVALID_INPUT',
          requestId: 'safe-request-id',
        },
      },
    });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'list_companies',
      count: 0,
      outcome: 'error',
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(outputSentinel);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });
});
