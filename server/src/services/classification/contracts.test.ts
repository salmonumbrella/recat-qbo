import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_CONTRACT_LIMITS,
  ClassificationContractError,
  classificationActionSchema,
  classificationErrorSchema,
  classificationCaseSchema,
  classificationSearchHitSchema,
  classificationSearchResultSchema,
  ruleMutationPreviewSchema,
  ruleMutationResultSchema,
  ruleRevisionSchema,
  serializeClassificationError,
  vendorIdentitySchema,
} from './contracts.js';

const at = '2026-08-30T00:00:00.000Z';
const tagId = '00000000-0000-4000-8000-000000000001';
const digest = 'a'.repeat(64);

const action = {
  categoryQboId: 'cat-100',
  taxCalculation: 'TaxExcluded' as const,
  taxCodeQboId: 'tax-200',
  tagIds: [tagId],
};

const actionSummary = {
  categoryName: 'Synthetic expense',
  taxCalculation: 'TaxExcluded' as const,
  taxCodeName: 'Synthetic tax',
  tagNames: ['Synthetic tag'],
};

const hit = {
  id: 'case-1',
  sourceId: 'case-1',
  kind: 'classification_case' as const,
  companyId: 'company-a',
  companyName: 'Synthetic Books',
  companyRelation: 'current' as const,
  executable: true,
  advisory: false,
  matchedIn: ['alias', 'case'] as const,
  score: 1,
  vendorIdentityId: 'vendor-1',
  vendorName: 'Synthetic Vendor',
  action,
  actionSummary,
  originIntent: 'apply_once' as const,
  evidenceCount: 1,
  conflictingEvidenceCount: 0,
  conflicts: [],
  provenance: {
    source: 'qbo_verified' as const,
    sourceId: 'attempt-1',
    actorId: 'user-1',
    recordedAt: at,
  },
  rationale: 'A synthetic verified decision.',
  examples: ['Synthetic invoice'],
  counterexamples: [],
  jurisdiction: 'CA-BC',
  currency: 'CAD',
  verifiedAt: at,
  ruleRevision: null,
};

describe('classification public contracts', () => {
  it('normalizes bounded text and rejects control characters, oversized arrays, and unknown keys', () => {
    const identity = vendorIdentitySchema.safeParse({
      id: 'vendor-1',
      companyId: 'company-a',
      qboVendorId: '42',
      displayName: '  Caf\u00e9  ',
      normalizedName: 'café',
      aliases: [],
      createdAt: at,
      updatedAt: at,
    });
    expect(identity.success).toBe(true);
    if (identity.success) expect(identity.data.displayName).toBe('Café');

    expect(classificationActionSchema.safeParse({
      ...action,
      tagIds: Array.from(
        { length: CLASSIFICATION_CONTRACT_LIMITS.tags + 1 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ),
    }).success).toBe(false);
    expect(classificationActionSchema.safeParse({
      ...action,
      memo: `safe\nnot-safe`,
    }).success).toBe(false);
    expect(classificationActionSchema.safeParse({ ...action, privatePayload: 'do not echo' }).success).toBe(false);
  });

  it('keeps tax treatment and QBO IDs exact, with one supported line', () => {
    expect(classificationActionSchema.safeParse({
      categoryQboId: 'cat-100',
      taxCalculation: 'NotApplicable',
      taxCodeQboId: null,
      tagIds: [],
    }).success).toBe(true);
    expect(classificationActionSchema.safeParse({
      ...action,
      taxCodeQboId: null,
    }).success).toBe(false);
    expect(classificationActionSchema.safeParse({
      ...action,
      taxCalculation: 'NotApplicable',
    }).success).toBe(false);
  });

  it('represents no evidence explicitly instead of treating it as an error', () => {
    const result = classificationSearchResultSchema.safeParse({
      query: 'never-seen-vendor',
      companyId: 'company-a',
      scope: 'current_company',
      mode: 'exact',
      requestedMode: 'exact',
      degraded: false,
      degradedReason: null,
      status: 'no_match',
      noMatch: true,
      hits: [],
      total: 0,
    });
    expect(result.success).toBe(true);
  });

  it('requires foreign-company hits to be advisory and non-executable', () => {
    expect(classificationSearchHitSchema.safeParse({
      ...hit,
      companyId: 'company-b',
      companyRelation: 'foreign',
      executable: true,
      advisory: false,
    }).success).toBe(false);

    const advisory = classificationSearchHitSchema.safeParse({
      ...hit,
      companyId: 'company-b',
      companyRelation: 'foreign',
      executable: false,
      advisory: true,
      action: null,
      conflicts: [],
    });
    expect(advisory.success).toBe(true);

    expect(classificationSearchHitSchema.safeParse({
      ...hit,
      companyId: 'company-b',
      companyRelation: 'foreign',
      executable: false,
      advisory: true,
      action: null,
      actionSummary: null,
      rationale: 'Historical rule classification: category retained; tax treatment unavailable.',
      conflicts: [],
    }).success).toBe(true);

    expect(classificationSearchResultSchema.safeParse({
      query: 'synthetic',
      companyId: 'company-a',
      scope: 'current_company',
      mode: 'exact',
      requestedMode: 'exact',
      degraded: false,
      degradedReason: null,
      status: 'matched',
      noMatch: false,
      hits: [advisory.success ? advisory.data : hit],
      total: 1,
    }).success).toBe(false);
  });

  it('retains bounded conflicts and makes their evidence count visible', () => {
    const conflict = {
      id: 'case-2',
      companyId: 'company-a',
      sourceId: 'case-2',
      kind: 'tax' as const,
      reason: 'The verified tax treatment differs.',
      action: { ...action, taxCodeQboId: 'tax-201' },
      actionSummary: { ...actionSummary, taxCodeName: 'Different synthetic tax' },
      evidenceCount: 1,
    };
    const parsed = classificationSearchHitSchema.safeParse({
      ...hit,
      conflictingEvidenceCount: 1,
      conflicts: [conflict],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.conflicts[0]?.reason).toContain('differs');
    expect(classificationSearchHitSchema.safeParse({
      ...hit,
      conflictingEvidenceCount: 0,
      conflicts: [conflict],
    }).success).toBe(false);
    expect(classificationSearchHitSchema.safeParse({
      ...hit,
      conflictingEvidenceCount: 1,
      conflicts: [{ ...conflict, companyId: 'company-b' }],
    }).success).toBe(false);
  });

  it('preserves unknown jurisdiction as an explicit value', () => {
    const parsed = classificationCaseSchema.safeParse({
      id: 'case-1',
      companyId: 'company-a',
      transactionId: 'txn-1',
      vendorIdentityId: null,
      qboMutationAttemptId: 'attempt-1',
      action,
      actionFingerprint: 'fingerprint-1',
      originIntent: 'apply_once',
      rationale: 'No jurisdiction was established by the available evidence.',
      requiredEvidence: ['Invoice or place-of-supply evidence'],
      examples: [],
      counterexamples: [],
      citations: [],
      reviewer: { userId: 'user-1', configVersion: 'classification-v1', decision: 'approved' },
      jurisdiction: 'unknown',
      currency: 'CAD',
      context: {
        transactionDirection: 'out',
        qboType: 'Purchase',
        sourceAccountName: 'Synthetic bank',
        businessPurpose: null,
      },
      provenance: {
        source: 'qbo_verified',
        sourceId: 'attempt-1',
        actorId: 'user-1',
        recordedAt: at,
      },
      verifiedAt: at,
      invalidatedAt: null,
      invalidationReason: null,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.jurisdiction).toBe('unknown');

    expect(classificationSearchHitSchema.safeParse({
      ...hit,
      jurisdiction: 'unknown',
      executable: true,
      advisory: false,
    }).success).toBe(false);
    expect(classificationSearchHitSchema.safeParse({
      ...hit,
      jurisdiction: 'unknown',
      executable: false,
      advisory: true,
    }).success).toBe(true);
    expect(classificationSearchHitSchema.safeParse({
      ...hit,
      jurisdiction: null,
      executable: true,
      advisory: false,
    }).success).toBe(false);
  });

  it('labels automatic lexical degradation and rejects dishonest degraded output', () => {
    expect(classificationSearchResultSchema.safeParse({
      query: 'synthetic',
      companyId: 'company-a',
      scope: 'current_company',
      mode: 'lexical',
      requestedMode: 'auto',
      degraded: true,
      degradedReason: 'semantic_unavailable',
      status: 'matched',
      noMatch: false,
      hits: [hit],
      total: 1,
    }).success).toBe(true);
    expect(classificationSearchResultSchema.safeParse({
      query: 'synthetic',
      companyId: 'company-a',
      scope: 'current_company',
      mode: 'lexical',
      requestedMode: 'semantic',
      degraded: true,
      degradedReason: 'semantic_unavailable',
      status: 'no_match',
      noMatch: true,
      hits: [],
      total: 0,
    }).success).toBe(false);
    expect(classificationSearchResultSchema.safeParse({
      query: 'synthetic',
      companyId: 'company-a',
      scope: 'current_company',
      mode: 'lexical',
      requestedMode: 'auto',
      degraded: false,
      degradedReason: null,
      status: 'matched',
      noMatch: false,
      hits: [hit],
      total: 1,
    }).success).toBe(false);
  });

  it('does not leak provider or database details in safe failures', () => {
    const secret = 'PRIVATE_PROVIDER_TOKEN database://private sentinel';
    const error = serializeClassificationError(new Error(secret));
    expect(error).toEqual({ code: 'INTERNAL', message: 'Classification could not be completed.' });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(serializeClassificationError(new ClassificationContractError('SEMANTIC_UNAVAILABLE'))).toEqual({
      code: 'SEMANTIC_UNAVAILABLE',
      message: 'Semantic classification search is unavailable.',
    });
    expect(classificationErrorSchema.safeParse({ code: 'INTERNAL', message: secret }).success).toBe(false);
  });

  it('keeps recurring and candidate rule origins suggestion-only', () => {
    const preview = {
      operationId: 'operation-1',
      companyId: 'company-a',
      ruleId: null,
      candidateId: 'candidate-1',
      mutation: 'activate_candidate' as const,
      originIntent: 'auto_candidate' as const,
      currentRevision: 0,
      proposedRevision: 1,
      condition: { matchField: 'payee' as const, matchText: 'Synthetic Vendor' },
      action,
      categoryName: 'Synthetic expense',
      taxCodeName: 'Synthetic tax',
      priority: 10,
      autoPost: true,
      affectedPendingCount: 1,
      affectedPostedCount: 0,
      sampleTransactions: [],
      conflicts: [],
      warnings: [],
      expiresAt: at,
      preparationDigest: digest,
    };
    expect(ruleMutationPreviewSchema.safeParse(preview).success).toBe(false);
    expect(ruleMutationPreviewSchema.safeParse({ ...preview, autoPost: false }).success).toBe(true);
    expect(ruleMutationPreviewSchema.safeParse({
      ...preview,
      mutation: 'enable',
      currentRevision: 1,
      proposedRevision: 2,
      autoPost: true,
    }).success).toBe(true);
    expect(ruleMutationPreviewSchema.safeParse({
      ...preview,
      autoPost: false,
      proposedRevision: 2,
    }).success).toBe(false);
    expect(ruleMutationPreviewSchema.safeParse({
      ...preview,
      autoPost: false,
      taxCodeName: null,
    }).success).toBe(false);

    const preparedPreview = { ...preview, autoPost: false };
    const preparedResult = {
      ok: true,
      operationId: 'operation-1',
      companyId: 'company-a',
      mutation: 'activate_candidate' as const,
      originIntent: 'auto_candidate' as const,
      status: 'PREPARED' as const,
      ruleId: null,
      revision: 1,
      rule: null,
      candidate: null,
      preview: preparedPreview,
      error: null,
    };
    expect(ruleMutationResultSchema.safeParse(preparedResult).success).toBe(true);
    expect(ruleMutationResultSchema.safeParse({
      ...preparedResult,
      candidate: {
        candidateId: 'candidate-1',
        state: 'activated',
        ruleId: 'rule-1',
      },
    }).success).toBe(false);
    expect(ruleMutationResultSchema.safeParse({
      ...preparedResult,
      preview: { ...preparedPreview, companyId: 'company-b' },
    }).success).toBe(false);

    expect(ruleMutationResultSchema.safeParse({
      ok: true,
      operationId: 'operation-dismiss',
      companyId: 'company-a',
      mutation: 'dismiss_candidate',
      originIntent: 'auto_candidate',
      status: 'COMMITTED',
      ruleId: null,
      revision: null,
      rule: null,
      candidate: {
        candidateId: 'candidate-1',
        state: 'dismissed',
        ruleId: null,
      },
      preview: null,
      error: null,
    }).success).toBe(true);
  });

  it('preserves legacy auto-post rules while governing new rule creation', () => {
    expect(ruleRevisionSchema.safeParse({
      id: 'revision-legacy',
      ruleId: 'rule-legacy',
      companyId: 'company-a',
      revision: 0,
      state: 'enabled',
      condition: { matchField: 'payee', matchText: 'Legacy Synthetic Vendor' },
      action,
      categoryName: 'Synthetic expense',
      taxCodeName: 'Synthetic tax',
      priority: 10,
      autoPost: true,
      originIntent: null,
      sourceCaseId: null,
      sourceCandidateId: null,
      changedBy: null,
      createdAt: at,
      retiredAt: null,
    }).success).toBe(true);
  });

  it('represents structurally legacy safety reductions as non-executable history', () => {
    const legacyRevision = {
      id: 'revision-legacy-incomplete',
      ruleId: 'rule-legacy-incomplete',
      companyId: 'company-a',
      revision: 3,
      state: 'disabled' as const,
      condition: { matchField: 'payee' as const, matchText: 'Legacy incomplete vendor' },
      action: null,
      categoryName: 'Legacy category label',
      taxCodeName: 'Legacy tax label',
      priority: 0,
      autoPost: false,
      originIntent: 'make_recurring' as const,
      sourceCaseId: null,
      sourceCandidateId: null,
      changedBy: 'user-1',
      createdAt: at,
      retiredAt: null,
    };
    expect(ruleRevisionSchema.safeParse(legacyRevision).success).toBe(true);

    const legacyPreview = {
      operationId: 'operation-legacy-disable',
      companyId: 'company-a',
      ruleId: 'rule-legacy-incomplete',
      candidateId: null,
      mutation: 'disable' as const,
      originIntent: 'make_recurring' as const,
      currentRevision: 2,
      proposedRevision: 3,
      condition: legacyRevision.condition,
      action: null,
      categoryName: legacyRevision.categoryName,
      taxCodeName: legacyRevision.taxCodeName,
      priority: 0,
      autoPost: false,
      affectedPendingCount: 0,
      affectedPostedCount: 0,
      sampleTransactions: [],
      conflicts: [],
      warnings: ['Stored legacy action is non-executable.'],
      expiresAt: at,
      preparationDigest: digest,
    };
    expect(ruleMutationPreviewSchema.safeParse(legacyPreview).success).toBe(true);
    expect(ruleMutationPreviewSchema.safeParse({
      ...legacyPreview,
      mutation: 'update',
    }).success).toBe(false);
  });
});
