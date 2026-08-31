import { Prisma, type PrismaClient } from '@prisma/client';
import type { ClassificationAction } from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import type { QboPreparedWrite } from '../../lib/qbo/types.js';
import {
  persistedClassificationDecision,
  persistedEvidenceProposal,
  persistedRuleCandidateContext,
  type NormalizedCategorizationDecisionContext,
} from '../categorizationEvidence.js';
import { runCompanyMutationTransaction } from '../companyMutationScope.js';
import { appendRuleRevision } from '../ruleRevisionHistory.js';
import type { VerifiedCategorizationOutcome } from '../agent/evaluation.js';
import { foldVerifiedRuleCandidateOutcomeInTransaction } from '../agent/ruleCandidatePersistence.js';
import {
  hashClassificationPreparedWrite,
  validateDurableAttemptPersistence,
} from '../writeback.js';
import {
  recordVerifiedClassificationCase,
  type ClassificationCaseDb,
} from './cases.js';
import { ensureVendorIdentity, type VendorIdentityDb } from './vendorIdentity.js';

type OutcomeTransaction = Prisma.TransactionClient;

export interface ClassificationOutcomeRecorderDeps {
  /** A root client is required so PostgreSQL conflict recovery never reuses a failed TransactionClient. */
  db: PrismaClient;
  now?: () => Date;
}

const defaultDeps: ClassificationOutcomeRecorderDeps = { db: prisma };
const REPAIR_BATCH_SIZE = 25;
const RULE_REVIEW_ACTOR = 'system:classification-outcome';

interface ExpectedOutcomeIdentity {
  companyId: string;
  requestId: string;
  transactionId?: string;
  inputRevision?: number;
  operation?: 'posted' | 'reverted';
  proposal?: VerifiedCategorizationOutcome['proposal'];
  candidateContext?: VerifiedCategorizationOutcome['candidateContext'];
  decisionContext?: NormalizedCategorizationDecisionContext;
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function caseAction(
  proposal: NonNullable<VerifiedCategorizationOutcome['proposal']>,
): ClassificationAction | null {
  const line = proposal.lines[0];
  if (proposal.lines.length !== 1 || line === undefined) return null;
  return {
    categoryQboId: line.categoryQboId,
    taxCalculation: proposal.taxCalculation,
    taxCodeQboId: line.taxCodeQboId,
    tagIds: [...new Set([...proposal.tagIds, ...line.tagIds])].sort(),
    memo: line.memo,
  };
}

async function markAffectedRulesReviewRequired(
  tx: OutcomeTransaction,
  companyId: string,
  caseIds: readonly string[],
  candidateIds: readonly string[],
  operation: 'posted' | 'reverted',
  now: Date,
): Promise<void> {
  if (caseIds.length === 0 && candidateIds.length === 0) return;
  const rules = await tx.rule.findMany({
    where: {
      companyId,
      enabled: true,
      retiredAt: null,
      OR: [
        ...(caseIds.length === 0 ? [] : [{ sourceCaseId: { in: [...caseIds] } }]),
        ...(candidateIds.length === 0 ? [] : [{ sourceCandidateId: { in: [...candidateIds] } }]),
      ],
    },
    include: { ruleTags: true },
  });
  for (const rule of rules) {
    const updated = await tx.rule.update({
      where: { id: rule.id },
      data: {
        autoPost: false,
        revision: { increment: 1 },
        updatedById: RULE_REVIEW_ACTOR,
        reviewRequiredAt: now,
        reviewReason: operation === 'reverted'
          ? 'The verified classification supporting this rule was undone.'
          : 'A later verified classification corrected evidence supporting this rule.',
      },
      include: { ruleTags: true },
    });
    await appendRuleRevision(tx, updated, RULE_REVIEW_ACTOR);
  }
}

async function completedReceiptExists(
  db: PrismaClient,
  identity: Pick<ExpectedOutcomeIdentity, 'companyId' | 'requestId'>,
): Promise<boolean> {
  const attempt = await db.qboMutationAttempt.findFirst({
    where: {
      requestId: identity.requestId,
      transaction: { companyId: identity.companyId },
    },
    select: { ruleCandidateFoldedAt: true },
  });
  if (attempt === null || attempt.ruleCandidateFoldedAt === null) return false;
  return await db.autopilotRuleCandidateFold.findUnique({
    where: { requestId: identity.requestId },
    select: { requestId: true },
  }) !== null;
}

async function recordInTransaction(
  tx: OutcomeTransaction,
  expected: ExpectedOutcomeIdentity,
  now: Date,
): Promise<boolean> {
  const attempt = await tx.qboMutationAttempt.findUnique({
    where: { requestId: expected.requestId },
    include: {
      transaction: true,
    },
  });
  if (
    attempt === null
    || attempt.transaction.companyId !== expected.companyId
    || attempt.status !== 'VERIFIED'
    || (attempt.operation !== 'recategorize' && attempt.operation !== 'restore')
  ) return false;

  const operation = attempt.operation === 'restore' ? 'reverted' : 'posted';
  if (
    (expected.transactionId !== undefined && expected.transactionId !== attempt.transactionId)
    || (expected.inputRevision !== undefined && expected.inputRevision !== attempt.expectedRevision)
    || (expected.operation !== undefined && expected.operation !== operation)
  ) return false;

  const durableStatus = operation === 'posted' ? 'POSTED' : 'REVERTED';
  const response = runtimeRecord(attempt.responseSnapshot);
  if (
    attempt.transaction.revision !== attempt.expectedRevision
    || attempt.transaction.status !== durableStatus
    || response === null
    || response.syncToken !== attempt.transaction.qboSyncToken
  ) return false;

  let proof: ReturnType<typeof validateDurableAttemptPersistence>;
  try {
    proof = validateDurableAttemptPersistence(attempt);
  } catch {
    return false;
  }
  if (
    proof.qboId !== attempt.transaction.qboId
    || proof.qboType !== attempt.transaction.qboType
    || proof.operation !== attempt.operation
  ) return false;

  const payload = runtimeRecord(attempt.requestPayload);
  if (payload === null || runtimeRecord(payload.ruleCandidateFold)?.version !== 1) return false;
  const proposal = operation === 'posted'
    ? persistedEvidenceProposal(attempt.requestPayload)
    : null;
  const candidateContext = operation === 'posted'
    ? persistedRuleCandidateContext(attempt.requestPayload)
    : null;
  if (operation === 'posted' && proposal === null) return false;

  const hasDecisionEnvelope = payload.classificationDecision !== undefined;
  const decision = persistedClassificationDecision(
    attempt.requestPayload,
    hashClassificationPreparedWrite(attempt.requestPayload as unknown as QboPreparedWrite),
  );
  if (hasDecisionEnvelope && decision === null) return false;
  if (
    (expected.proposal !== undefined && !exactJson(expected.proposal, proposal))
    || (expected.candidateContext !== undefined && !exactJson(expected.candidateContext, candidateContext))
    || (expected.decisionContext !== undefined && !exactJson(expected.decisionContext, decision?.context))
  ) return false;

  const existingFold = await tx.autopilotRuleCandidateFold.findUnique({
    where: { requestId: attempt.requestId },
    select: { requestId: true },
  });
  if (existingFold !== null) return false;

  const priorCases = await tx.classificationCase.findMany({
    where: {
      companyId: expected.companyId,
      transactionId: attempt.transactionId,
      qboMutationAttemptId: { not: attempt.id },
      invalidation: null,
    },
    select: { id: true },
  });
  const priorCandidateRows = await tx.autopilotRuleCandidateEvidence.findMany({
    where: {
      companyId: expected.companyId,
      transactionId: attempt.transactionId,
      active: true,
    },
    select: { candidateId: true },
  });
  const invalidationReason = operation === 'reverted'
    ? 'Undone by a later verified QBO outcome.'
    : 'Corrected by a later verified QBO outcome.';
  if (priorCases.length > 0) {
    await tx.classificationCaseInvalidation.createMany({
      data: priorCases.map((classificationCase) => ({
        companyId: expected.companyId,
        classificationCaseId: classificationCase.id,
        invalidatedAt: now,
        reason: invalidationReason,
      })),
      skipDuplicates: true,
    });
  }

  if (operation === 'posted' && proposal !== null && decision !== null) {
    const action = caseAction(proposal);
    if (action !== null) {
      const hint = decision.context.vendorIdentityHint;
      const vendorIdentity = hint === null
        ? null
        : await ensureVendorIdentity({
            companyId: expected.companyId,
            displayName: hint.displayName,
            qboVendorId: hint.qboVendorId,
          }, tx as unknown as VendorIdentityDb);
      await recordVerifiedClassificationCase({
        companyId: expected.companyId,
        transactionId: attempt.transactionId,
        qboMutationAttemptId: attempt.id,
        vendorIdentityId: vendorIdentity?.id ?? null,
        action,
        originIntent: decision.context.originIntent,
        rationale: decision.context.rationale,
        requiredEvidence: decision.context.requiredEvidence,
        examples: decision.context.examples,
        counterexamples: decision.context.counterexamples,
        citations: decision.context.citations,
        reviewer: decision.context.reviewer,
        jurisdiction: decision.context.jurisdiction,
        currency: decision.context.currency,
        context: decision.context.context,
        provenance: {
          source: 'qbo_verified',
          sourceId: attempt.id,
          actorId: decision.context.reviewer.userId,
          recordedAt: attempt.updatedAt.toISOString(),
        },
      }, tx as unknown as ClassificationCaseDb);
    }
  }

  const durableOutcome: VerifiedCategorizationOutcome = {
    companyId: expected.companyId,
    transactionId: attempt.transactionId,
    inputRevision: attempt.expectedRevision,
    requestId: attempt.requestId,
    operation,
    proposal,
    candidateContext,
    ...(decision === null ? {} : { decisionContext: decision.context }),
  };
  const folded = await foldVerifiedRuleCandidateOutcomeInTransaction(
    tx,
    durableOutcome,
    now,
    { markAffectedRules: false },
  );
  if (!folded.processed) return false;
  await markAffectedRulesReviewRequired(
    tx,
    expected.companyId,
    priorCases.map((classificationCase) => classificationCase.id),
    [...new Set([
      ...priorCandidateRows.map((row) => row.candidateId),
      ...folded.affectedCandidateIds,
    ])],
    operation,
    now,
  );
  return true;
}

async function recordExpectedOutcome(
  expected: ExpectedOutcomeIdentity,
  deps: ClassificationOutcomeRecorderDeps,
): Promise<boolean> {
  const now = deps.now?.() ?? new Date();
  try {
    return await runCompanyMutationTransaction(
      deps.db,
      expected.companyId,
      (tx) => recordInTransaction(tx, expected, now),
    );
  } catch (error) {
    // A unique violation aborts PostgreSQL's caller-owned transaction. Recover
    // only with the root client after rollback; never query through `tx`.
    if (isUniqueViolation(error) && await completedReceiptExists(deps.db, expected)) {
      return false;
    }
    throw error;
  }
}

/** Records one exact callback emitted after independent QBO readback. */
export function recordVerifiedClassificationOutcome(
  outcome: VerifiedCategorizationOutcome,
  deps: ClassificationOutcomeRecorderDeps = defaultDeps,
): Promise<boolean> {
  return recordExpectedOutcome(outcome, deps);
}

/**
 * Bounded local-only repair for VERIFIED attempts whose durable fold marker is
 * still absent. It is safe to race across workers because every fold is
 * company-fenced and request-key idempotent.
 */
export async function reconcileVerifiedClassificationOutcomes(
  companyId: string,
  deps: ClassificationOutcomeRecorderDeps = defaultDeps,
): Promise<number> {
  const rows = await deps.db.qboMutationAttempt.findMany({
    where: {
      status: 'VERIFIED',
      operation: { in: ['recategorize', 'restore'] },
      ruleCandidateFoldedAt: null,
      transaction: { companyId },
      requestPayload: {
        path: ['ruleCandidateFold', 'version'],
        equals: 1,
      },
    },
    select: { requestId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: REPAIR_BATCH_SIZE,
  });
  let recorded = 0;
  for (const row of rows) {
    if (await recordExpectedOutcome({ companyId, requestId: row.requestId }, deps)) {
      recorded += 1;
    }
  }
  return recorded;
}
