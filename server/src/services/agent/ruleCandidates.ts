import { createHash } from 'node:crypto';
import type {
  VerifiedCategorizationOutcome,
  VerifiedCategorizationProposal,
} from './evaluation.js';

export const RULE_CANDIDATE_SCHEMA_VERSION = 'rule-candidate-v1';
export const RULE_CANDIDATE_EVIDENCE_THRESHOLD = 3;

export interface RuleCandidatePattern {
  schemaVersion: typeof RULE_CANDIDATE_SCHEMA_VERSION;
  matchField: 'payee';
  matchText: string;
  conditionFingerprint: string;
  actionFingerprint: string;
  categoryQboId: string;
  taxCalculation: VerifiedCategorizationProposal['taxCalculation'];
  taxCodeQboId: string | null;
  tagIds: string[];
}

export interface CandidateEvidencePattern {
  transactionId: string;
  actionFingerprint: string;
  pattern: RuleCandidatePattern;
}

export interface CandidateEvidenceSummary {
  state: 'gathering' | 'ready' | 'conflict';
  evidenceCount: number;
  conflictingEvidenceCount: number;
  pattern: RuleCandidatePattern | null;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseStoredCandidatePattern(value: unknown): RuleCandidatePattern | null {
  const row = runtimeRecord(value);
  if (
    row === null
    || row.schemaVersion !== RULE_CANDIDATE_SCHEMA_VERSION
    || row.matchField !== 'payee'
    || typeof row.matchText !== 'string'
    || candidateContextFor(row.matchText, 'unused', 'user')?.matchText !== row.matchText
    || typeof row.conditionFingerprint !== 'string'
    || typeof row.actionFingerprint !== 'string'
    || typeof row.categoryQboId !== 'string'
    || row.categoryQboId.trim() === ''
    || (
      row.taxCalculation !== 'TaxInclusive'
      && row.taxCalculation !== 'TaxExcluded'
      && row.taxCalculation !== 'NotApplicable'
    )
    || (
      row.taxCalculation === 'NotApplicable'
        ? row.taxCodeQboId !== null
        : typeof row.taxCodeQboId !== 'string' || row.taxCodeQboId.trim() === ''
    )
    || !Array.isArray(row.tagIds)
    || row.tagIds.some((tagId) => typeof tagId !== 'string')
  ) {
    return null;
  }
  const tagIds = [...new Set(row.tagIds as string[])].sort();
  if (tagIds.length !== row.tagIds.length) return null;
  const condition = {
    schemaVersion: RULE_CANDIDATE_SCHEMA_VERSION as typeof RULE_CANDIDATE_SCHEMA_VERSION,
    matchField: 'payee' as const,
    matchText: row.matchText,
  };
  const action: Pick<
    RuleCandidatePattern,
    'categoryQboId' | 'taxCalculation' | 'taxCodeQboId' | 'tagIds'
  > = {
    categoryQboId: row.categoryQboId,
    taxCalculation: row.taxCalculation,
    taxCodeQboId: row.taxCodeQboId as string | null,
    tagIds,
  };
  if (
    row.conditionFingerprint !== fingerprint(condition)
    || row.actionFingerprint !== fingerprint(action)
  ) {
    return null;
  }
  return {
    ...condition,
    conditionFingerprint: row.conditionFingerprint,
    actionFingerprint: row.actionFingerprint,
    ...action,
  };
}

export function candidateContextFor(
  payee: string,
  configVersion: string,
  source: NonNullable<VerifiedCategorizationOutcome['candidateContext']>['source'],
): NonNullable<VerifiedCategorizationOutcome['candidateContext']> | null {
  const matchText = payee.trim().normalize('NFC').toLowerCase();
  if (
    matchText.length < 3
    || matchText.length > 200
    || /[\u0000-\u001f\u007f]/u.test(matchText)
  ) {
    return null;
  }
  const condition = {
    schemaVersion: RULE_CANDIDATE_SCHEMA_VERSION as typeof RULE_CANDIDATE_SCHEMA_VERSION,
    matchField: 'payee' as const,
    matchText,
  };
  return {
    ...condition,
    conditionFingerprint: fingerprint(condition),
    configVersion,
    source,
  };
}

/**
 * Reduces one exact verified categorization to the subset a normal v1 Rule can
 * reproduce. Amounts are deliberately excluded so transactions of different
 * sizes can agree. Split lines, line tags, and memos are ineligible because a
 * v1 payee rule cannot faithfully express them. Taxed outcomes are also
 * excluded until the normal Rule executor applies tax fields during posting.
 */
export function candidatePatternFor(
  payee: string,
  proposal: VerifiedCategorizationProposal,
): RuleCandidatePattern | null {
  const context = candidateContextFor(payee, 'unused', 'user');
  const line = proposal.lines[0];
  if (
    context === null
    || proposal.taxCalculation !== 'NotApplicable'
    || proposal.lines.length !== 1
    || line === undefined
    || line.memo !== null
    || line.tagIds.length !== 0
    || line.categoryQboId.trim() === ''
    || line.taxCodeQboId !== null
  ) {
    return null;
  }
  const tagIds = [...new Set(proposal.tagIds)].sort();
  const condition = {
    schemaVersion: context.schemaVersion,
    matchField: context.matchField,
    matchText: context.matchText,
  };
  const action: Pick<
    RuleCandidatePattern,
    'categoryQboId' | 'taxCalculation' | 'taxCodeQboId' | 'tagIds'
  > = {
    categoryQboId: line.categoryQboId,
    taxCalculation: proposal.taxCalculation,
    taxCodeQboId: line.taxCodeQboId,
    tagIds,
  };
  return {
    ...condition,
    conditionFingerprint: context.conditionFingerprint,
    actionFingerprint: fingerprint(action),
    ...action,
  };
}

/**
 * Summarizes current evidence only. Callers own invalidation/replacement of
 * stale transaction evidence before passing it here.
 */
export function summarizeCandidateEvidence(
  evidence: readonly CandidateEvidencePattern[],
): CandidateEvidenceSummary {
  const byTransaction = new Map<string, CandidateEvidencePattern>();
  for (const row of evidence) {
    const current = byTransaction.get(row.transactionId);
    if (
      current === undefined
      || row.actionFingerprint.localeCompare(current.actionFingerprint) < 0
    ) {
      byTransaction.set(row.transactionId, row);
    }
  }
  const groups = new Map<string, CandidateEvidencePattern[]>();
  for (const row of byTransaction.values()) {
    const rows = groups.get(row.actionFingerprint) ?? [];
    rows.push(row);
    groups.set(row.actionFingerprint, rows);
  }
  const ranked = [...groups.entries()].sort(
    ([leftFingerprint, left], [rightFingerprint, right]) =>
      right.length - left.length || leftFingerprint.localeCompare(rightFingerprint),
  );
  const winner = ranked[0]?.[1] ?? [];
  const conflictingEvidenceCount = ranked.slice(1).reduce((sum, [, rows]) => sum + rows.length, 0);
  return {
    state:
      ranked.length > 1
        ? 'conflict'
        : winner.length >= RULE_CANDIDATE_EVIDENCE_THRESHOLD
          ? 'ready'
          : 'gathering',
    evidenceCount: winner.length,
    conflictingEvidenceCount,
    pattern: winner[0]?.pattern ?? null,
  };
}
