import { describe, expect, it } from 'vitest';
import type { VerifiedCategorizationProposal } from './evaluation.js';
import {
  candidatePatternFor,
  summarizeCandidateEvidence,
  type CandidateEvidencePattern,
} from './ruleCandidates.js';

const CATEGORY_REFERENCE = 'account-neutral';
const TAG_REFERENCE = '11111111-1111-4111-8111-111111111111';

function proposal(
  overrides: Partial<VerifiedCategorizationProposal> = {},
): VerifiedCategorizationProposal {
  return {
    taxCalculation: 'NotApplicable',
    lines: [{
      idx: 0,
      subtotalCents: 4200,
      taxCents: 0,
      totalCents: 4200,
      categoryQboId: CATEGORY_REFERENCE,
      taxCodeQboId: null,
      memo: null,
      tagIds: [],
    }],
    tagIds: [TAG_REFERENCE],
    ...overrides,
  };
}

function evidence(
  transactionId: string,
  pattern: NonNullable<ReturnType<typeof candidatePatternFor>>,
): CandidateEvidencePattern {
  return {
    transactionId,
    actionFingerprint: pattern.actionFingerprint,
    pattern,
  };
}

describe('rule candidate pattern model', () => {
  it('derives an executable, deterministic payee rule without retaining amounts', () => {
    const first = candidatePatternFor('Northwind Market', proposal());
    const second = candidatePatternFor('NORTHWIND MARKET', proposal({
      lines: [{
        ...proposal().lines[0]!,
        subtotalCents: 9700,
        totalCents: 9700,
      }],
      tagIds: [TAG_REFERENCE, TAG_REFERENCE],
    }));

    expect(first).toEqual({
      schemaVersion: 'rule-candidate-v1',
      matchField: 'payee',
      matchText: 'northwind market',
      conditionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      actionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      categoryQboId: CATEGORY_REFERENCE,
      taxCalculation: 'NotApplicable',
      taxCodeQboId: null,
      tagIds: [TAG_REFERENCE],
    });
    expect(second).toEqual(first);
  });

  it('excludes outcomes a normal single-category rule cannot reproduce', () => {
    expect(candidatePatternFor('Northwind Market', proposal({
      lines: [
        proposal().lines[0]!,
        { ...proposal().lines[0]!, idx: 1, categoryQboId: 'account-other' },
      ],
    }))).toBeNull();
    expect(candidatePatternFor('Northwind Market', proposal({
      lines: [{ ...proposal().lines[0]!, memo: 'transaction-specific note' }],
    }))).toBeNull();
    expect(candidatePatternFor('Northwind Market', proposal({
      lines: [{ ...proposal().lines[0]!, tagIds: [TAG_REFERENCE] }],
    }))).toBeNull();
    expect(candidatePatternFor('Northwind Market', proposal({
      taxCalculation: 'TaxExcluded',
      lines: [{
        ...proposal().lines[0]!,
        subtotalCents: 4000,
        taxCents: 200,
        totalCents: 4200,
        taxCodeQboId: 'tax-neutral',
      }],
    }))).toBeNull();
    expect(candidatePatternFor('Northwind Market', proposal({
      lines: [{ ...proposal().lines[0]!, taxCodeQboId: 'NON' }],
    }))).toBeNull();
    expect(candidatePatternFor('  ', proposal())).toBeNull();
    expect(candidatePatternFor('ab', proposal())).toBeNull();
    expect(candidatePatternFor(`line\nbreak`, proposal())).toBeNull();
  });

  it('distinguishes category and tag actions but not input ordering', () => {
    const base = candidatePatternFor('Northwind Market', proposal())!;
    const otherCategory = candidatePatternFor('Northwind Market', proposal({
      lines: [{ ...proposal().lines[0]!, categoryQboId: 'account-other' }],
    }))!;
    const otherTag = candidatePatternFor('Northwind Market', proposal({
      tagIds: ['22222222-2222-4222-8222-222222222222'],
    }))!;

    expect(new Set([
      base.actionFingerprint,
      otherCategory.actionFingerprint,
      otherTag.actionFingerprint,
    ])).toHaveLength(3);
  });
});

describe('rule candidate evidence summary', () => {
  it('requires three distinct transactions with one agreeing action', () => {
    const pattern = candidatePatternFor('Northwind Market', proposal())!;

    expect(summarizeCandidateEvidence([
      evidence('txn-1', pattern),
      evidence('txn-1', pattern),
      evidence('txn-2', pattern),
    ])).toEqual({
      state: 'gathering',
      evidenceCount: 2,
      conflictingEvidenceCount: 0,
      pattern,
    });

    expect(summarizeCandidateEvidence([
      evidence('txn-1', pattern),
      evidence('txn-2', pattern),
      evidence('txn-3', pattern),
    ])).toEqual({
      state: 'ready',
      evidenceCount: 3,
      conflictingEvidenceCount: 0,
      pattern,
    });
  });

  it('invalidates the candidate when current evidence has conflicting actions', () => {
    const pattern = candidatePatternFor('Northwind Market', proposal())!;
    const conflicting = candidatePatternFor('Northwind Market', proposal({
      lines: [{ ...proposal().lines[0]!, categoryQboId: 'account-other' }],
    }))!;

    expect(summarizeCandidateEvidence([
      evidence('txn-1', pattern),
      evidence('txn-2', pattern),
      evidence('txn-3', pattern),
      evidence('txn-4', conflicting),
    ])).toEqual({
      state: 'conflict',
      evidenceCount: 3,
      conflictingEvidenceCount: 1,
      pattern,
    });
  });
});
