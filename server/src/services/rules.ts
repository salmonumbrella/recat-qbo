import { Prisma, type PrismaClient } from '@prisma/client';
import {
  isUsableTaxCodeDto,
  type ClassificationAction,
  type ClassificationConflict,
  type RuleMutationSample,
  type RuleRevision as CanonicalRuleRevision,
  type RuleDto,
  type RuleTestConflict,
  type RuleTestMatch,
  type RuleTestResult,
  type TaxCalculation,
  type TxnStatus,
} from '@recat/shared';
import { prisma } from '../lib/prisma.js';
import { parseActionTagIds } from './classification/actionTagIds.js';
import { parseRuleRevision } from './classification/contracts.js';
import { runCompanyMutationTransaction } from './companyMutationScope.js';
import { appendRuleRevision } from './ruleRevisionHistory.js';
import { ruleSuggestion, type RuleLike } from './suggestions.js';
import {
  getTaxReadinessInTransaction,
  type TaxReadinessQueryDb,
} from './tax/reference.js';

export type RuleRow = Prisma.RuleGetPayload<{
  include: { ruleTags: true; candidateOrigin: true };
}>;
export type RuleTransaction = Prisma.TransactionClient;
type RuleDb = PrismaClient | Prisma.TransactionClient;

export interface RuleActor {
  id: string | null;
  label: string;
}

export function toRuleDto(rule: RuleRow): RuleDto {
  return {
    id: rule.id,
    companyId: rule.companyId,
    priority: rule.priority,
    matchField: 'payee',
    matchText: rule.matchText,
    category: rule.category,
    categoryQboId: rule.categoryQboId,
    taxCalculation: rule.taxCalculation as RuleDto['taxCalculation'],
    taxCode: rule.taxCode,
    taxCodeQboId: rule.taxCodeQboId,
    tagIds: rule.ruleTags.map(({ tagId }) => tagId),
    autoPost: rule.autoPost,
    createdAt: rule.createdAt.toISOString(),
    reviewRequiredAt: rule.reviewRequiredAt?.toISOString() ?? null,
    reviewReason: rule.reviewReason,
    origin: rule.candidateOrigin
      ? {
          candidateId: rule.candidateOrigin.id,
          evidenceCount:
            rule.candidateOrigin.activationEvidenceCount
            ?? rule.candidateOrigin.evidenceCount,
          schemaVersion: rule.candidateOrigin.schemaVersion,
          configVersion: rule.candidateOrigin.configVersion,
        }
      : null,
  };
}

export async function resolveCategoryReference(
  db: RuleDb,
  companyId: string,
  categoryName: string,
  givenQboId?: string | null,
): Promise<string> {
  const account = await db.qboAccount.findFirst({
    where: givenQboId
      ? {
          companyId,
          qboId: givenQboId,
          active: true,
          classification: { in: ['Income', 'COGS', 'Expenses'] },
        }
      : {
          companyId,
          name: categoryName,
          active: true,
          classification: { in: ['Income', 'COGS', 'Expenses'] },
        },
    select: { qboId: true },
  });
  if (account === null) {
    throw new RuleServiceError('NOT_FOUND', 'Category reference was not found.');
  }
  return account.qboId;
}

export interface RuleActionInput {
  categoryQboId: string;
  taxCalculation: TaxCalculation;
  taxCodeQboId: string | null;
  tagIds: string[];
}

export interface CreateRuleInput extends RuleActionInput {
  id?: string;
  matchText: string;
  priority: number;
  autoPost: boolean;
  originIntent: 'make_recurring' | 'auto_candidate' | null;
  sourceCaseId?: string | null;
  sourceCandidateId?: string | null;
  initialRevision?: number;
}

export interface UpdateRuleInput {
  matchText?: string;
  categoryQboId?: string;
  taxCalculation?: TaxCalculation;
  taxCodeQboId?: string | null;
  tagIds?: string[];
  priority?: number;
  autoPost?: boolean;
}

export class RuleServiceError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'STALE_REVISION',
    message: string,
  ) {
    super(message);
    this.name = 'RuleServiceError';
  }
}

function invalid(message: string): never {
  throw new RuleServiceError('INVALID_INPUT', message);
}

function safeText(value: string, limit: number, field: string): string {
  const normalized = value.trim().normalize('NFC');
  if (
    normalized.length === 0
    || normalized.length > limit
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) invalid(`${field} is invalid.`);
  return normalized;
}

function safePriority(value: number): number {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    invalid('Rule priority is invalid.');
  }
  return value;
}

function normalizeActionTagIds(value: unknown): string[] {
  const tagIds = parseActionTagIds(value);
  if (tagIds === null) invalid('Rule tag identifiers are invalid.');
  return [...tagIds].sort();
}

export async function validateSourceCase(
  tx: RuleDb,
  companyId: string,
  sourceCaseId: string | null | undefined,
): Promise<void> {
  if (sourceCaseId == null) return;
  const source = await tx.classificationCase.findFirst({
    where: { id: sourceCaseId, companyId },
    select: { id: true },
  });
  if (source === null) {
    throw new RuleServiceError('NOT_FOUND', 'Rule source case was not found.');
  }
}

export async function resolveRuleAction(
  tx: RuleDb,
  companyId: string,
  input: RuleActionInput,
): Promise<{
  action: ClassificationAction;
  categoryName: string;
  taxCodeName: string | null;
}> {
  const categoryQboId = safeText(input.categoryQboId, 120, 'Category');
  const tagIds = normalizeActionTagIds(input.tagIds);
  const category = await tx.qboAccount.findFirst({
    where: {
      companyId,
      qboId: categoryQboId,
      active: true,
      classification: { in: ['Income', 'COGS', 'Expenses'] },
    },
    select: { name: true },
  });
  if (category === null) {
    throw new RuleServiceError('NOT_FOUND', 'Category reference was not found.');
  }
  const ownedTags = await tx.tag.count({
    where: { companyId, id: { in: tagIds } },
  });
  if (ownedTags !== tagIds.length) {
    throw new RuleServiceError('NOT_FOUND', 'Rule tag reference was not found.');
  }

  let taxCodeName: string | null = null;
  let taxCodeQboId: string | null = null;
  if (input.taxCalculation === 'NotApplicable') {
    if (input.taxCodeQboId !== null) invalid('NotApplicable rules cannot select a tax code.');
  } else if (
    input.taxCalculation === 'TaxInclusive'
    || input.taxCalculation === 'TaxExcluded'
  ) {
    taxCodeQboId = safeText(input.taxCodeQboId ?? '', 120, 'Tax code');
    const readiness = await getTaxReadinessInTransaction(
      companyId,
      tx as unknown as TaxReadinessQueryDb,
    );
    const taxCode = readiness.taxCodes.find((row) =>
      row.qboId === taxCodeQboId && isUsableTaxCodeDto(row));
    if (readiness.status !== 'ready' || taxCode === undefined) {
      throw new RuleServiceError('CONFLICT', 'Tax reference is not ready.');
    }
    taxCodeName = taxCode.name;
  } else {
    invalid('Tax calculation is invalid.');
  }

  return {
    action: {
      categoryQboId,
      taxCalculation: input.taxCalculation,
      taxCodeQboId,
      tagIds,
    },
    categoryName: category.name,
    taxCodeName,
  };
}

export async function loadCompanyRule(
  tx: RuleDb,
  companyId: string,
  ruleId: string,
  options: { includeRetired?: boolean } = {},
): Promise<RuleRow> {
  const rule = await tx.rule.findFirst({
    where: { id: ruleId, companyId },
    include: { ruleTags: true, candidateOrigin: true },
  });
  if (rule === null || (!options.includeRetired && rule.retiredAt !== null)) {
    throw new RuleServiceError('NOT_FOUND', 'Rule was not found.');
  }
  return rule;
}

function ruleActionInput(rule: RuleRow): RuleActionInput {
  if (
    rule.categoryQboId === null
    || (
      rule.taxCalculation !== 'TaxInclusive'
      && rule.taxCalculation !== 'TaxExcluded'
      && rule.taxCalculation !== 'NotApplicable'
    )
  ) invalid('Rule does not contain a canonical executable action.');
  return {
    categoryQboId: rule.categoryQboId,
    taxCalculation: rule.taxCalculation,
    taxCodeQboId: rule.taxCodeQboId,
    tagIds: rule.ruleTags.map(({ tagId }) => tagId),
  };
}

export async function validateExistingRuleAction(
  tx: RuleDb,
  companyId: string,
  rule: RuleRow,
): ReturnType<typeof resolveRuleAction> {
  return resolveRuleAction(tx, companyId, ruleActionInput(rule));
}

export async function assertPriorityAvailable(
  tx: RuleDb,
  companyId: string,
  priority: number,
  excludingRuleId?: string,
): Promise<void> {
  const conflict = await tx.rule.findFirst({
    where: {
      companyId,
      enabled: true,
      retiredAt: null,
      priority,
      ...(excludingRuleId ? { id: { not: excludingRuleId } } : {}),
    },
    select: { id: true },
  });
  if (conflict !== null) {
    throw new RuleServiceError('CONFLICT', 'Rule priority conflicts with an active rule.');
  }
}

export async function createRuleInTransaction(
  tx: RuleTransaction,
  companyId: string,
  actor: RuleActor,
  input: CreateRuleInput,
): Promise<RuleRow> {
  const matchText = safeText(input.matchText, 200, 'Rule condition');
  const priority = safePriority(input.priority);
  const resolved = await resolveRuleAction(tx, companyId, input);
  await validateSourceCase(tx, companyId, input.sourceCaseId);
  if (input.originIntent === 'make_recurring' && input.autoPost) {
    invalid('Recurring rules must start with autoPost disabled.');
  }
  if (input.originIntent === 'auto_candidate' && input.autoPost) {
    invalid('Candidate rules must start with autoPost disabled.');
  }
  await assertPriorityAvailable(tx, companyId, priority);
  const revision = input.initialRevision ?? 0;
  if (!Number.isInteger(revision) || revision < 0) invalid('Initial revision is invalid.');
  const created = await tx.rule.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      companyId,
      matchField: 'payee',
      matchText,
      category: resolved.categoryName,
      categoryQboId: resolved.action.categoryQboId,
      taxCalculation: resolved.action.taxCalculation,
      taxCode: resolved.taxCodeName,
      taxCodeQboId: resolved.action.taxCodeQboId,
      priority,
      autoPost: input.autoPost,
      revision,
      originIntent: input.originIntent,
      sourceCaseId: input.sourceCaseId ?? null,
      sourceCandidateId: input.sourceCandidateId ?? null,
      createdById: actor.id,
      updatedById: actor.id,
      ruleTags: { create: resolved.action.tagIds.map((tagId) => ({ tagId })) },
    },
    include: { ruleTags: true, candidateOrigin: true },
  });
  await appendRuleRevision(tx, created, actor.id);
  await auditRule(tx, actor, created, 'rule-created', 'Created');
  return created;
}

export async function updateRuleInTransaction(
  tx: RuleTransaction,
  companyId: string,
  ruleId: string,
  expectedRevision: number,
  actor: RuleActor,
  patch: UpdateRuleInput,
): Promise<RuleRow> {
  const current = await loadCompanyRule(tx, companyId, ruleId);
  if (current.revision !== expectedRevision) {
    throw new RuleServiceError('STALE_REVISION', 'Rule revision changed.');
  }
  const currentAction = ruleActionInput(current);
  const resolved = await resolveRuleAction(tx, companyId, {
    categoryQboId: patch.categoryQboId ?? currentAction.categoryQboId,
    taxCalculation: patch.taxCalculation ?? currentAction.taxCalculation,
    taxCodeQboId: patch.taxCodeQboId !== undefined
      ? patch.taxCodeQboId
      : currentAction.taxCodeQboId,
    tagIds: patch.tagIds ?? currentAction.tagIds,
  });
  const priority = patch.priority === undefined
    ? current.priority
    : safePriority(patch.priority);
  if (priority !== current.priority) {
    await assertPriorityAvailable(tx, companyId, priority, current.id);
  }
  if (current.autoPost === false && patch.autoPost === true) {
    const keys = Object.keys(patch).filter((key) => key !== 'autoPost');
    if (keys.length > 0) invalid('autoPost elevation must be a standalone rule change.');
  }
  if (patch.matchText === undefined && Object.keys(patch).length === 0) {
    invalid('Rule update is empty.');
  }
  if (patch.tagIds !== undefined) {
    await tx.ruleTag.deleteMany({ where: { ruleId: current.id } });
    await tx.ruleTag.createMany({
      data: resolved.action.tagIds.map((tagId) => ({ ruleId: current.id, tagId })),
    });
  }
  const updated = await tx.rule.update({
    where: { id: current.id },
    data: {
      ...(patch.matchText !== undefined
        ? { matchText: safeText(patch.matchText, 200, 'Rule condition') }
        : {}),
      category: resolved.categoryName,
      categoryQboId: resolved.action.categoryQboId,
      taxCalculation: resolved.action.taxCalculation,
      taxCode: resolved.taxCodeName,
      taxCodeQboId: resolved.action.taxCodeQboId,
      priority,
      ...(patch.autoPost !== undefined ? { autoPost: patch.autoPost } : {}),
      revision: { increment: 1 },
      updatedById: actor.id,
    },
    include: { ruleTags: true, candidateOrigin: true },
  });
  await appendRuleRevision(tx, updated, actor.id);
  await auditRule(tx, actor, updated, 'rule-updated', 'Updated');
  return updated;
}

export async function setRuleEnabledInTransaction(
  tx: RuleTransaction,
  companyId: string,
  ruleId: string,
  expectedRevision: number,
  enabled: boolean,
  actor: RuleActor,
): Promise<RuleRow> {
  const current = await loadCompanyRule(tx, companyId, ruleId);
  if (current.revision !== expectedRevision) {
    throw new RuleServiceError('STALE_REVISION', 'Rule revision changed.');
  }
  await validateExistingRuleAction(tx, companyId, current);
  if (current.enabled === enabled) {
    throw new RuleServiceError('CONFLICT', 'Rule already has the requested state.');
  }
  if (enabled) await assertPriorityAvailable(tx, companyId, current.priority, current.id);
  const updated = await tx.rule.update({
    where: { id: current.id },
    data: {
      enabled,
      revision: { increment: 1 },
      updatedById: actor.id,
    },
    include: { ruleTags: true, candidateOrigin: true },
  });
  await appendRuleRevision(tx, updated, actor.id);
  await auditRule(
    tx,
    actor,
    updated,
    enabled ? 'rule-enabled' : 'rule-disabled',
    enabled ? 'Enabled' : 'Disabled',
  );
  return updated;
}

export async function retireRuleInTransaction(
  tx: RuleTransaction,
  companyId: string,
  ruleId: string,
  expectedRevision: number,
  actor: RuleActor,
  retiredAt = new Date(),
): Promise<RuleRow> {
  const current = await loadCompanyRule(tx, companyId, ruleId);
  if (current.revision !== expectedRevision) {
    throw new RuleServiceError('STALE_REVISION', 'Rule revision changed.');
  }
  await validateExistingRuleAction(tx, companyId, current);
  const updated = await tx.rule.update({
    where: { id: current.id },
    data: {
      enabled: false,
      retiredAt,
      revision: { increment: 1 },
      updatedById: actor.id,
    },
    include: { ruleTags: true, candidateOrigin: true },
  });
  await appendRuleRevision(tx, updated, actor.id);
  await auditRule(tx, actor, updated, 'rule-retired', 'Retired');
  return updated;
}

export async function reorderRulesInTransaction(
  tx: RuleTransaction,
  companyId: string,
  ids: string[],
  expectedRevision: number,
  actor: RuleActor,
): Promise<RuleRow[]> {
  if (ids.length === 0 || new Set(ids).size !== ids.length) invalid('Rule order is invalid.');
  const existing = await tx.rule.findMany({
    where: { companyId, enabled: true, retiredAt: null },
    include: { ruleTags: true, candidateOrigin: true },
  });
  const existingIds = new Set(existing.map(({ id }) => id));
  if (existingIds.size !== ids.length || ids.some((id) => !existingIds.has(id))) {
    throw new RuleServiceError('CONFLICT', 'Order must contain the exact active rule set.');
  }
  if (Math.max(...existing.map(({ revision }) => revision)) !== expectedRevision) {
    throw new RuleServiceError('STALE_REVISION', 'Rule order revision changed.');
  }
  for (const [priority, id] of ids.entries()) {
    const current = existing.find((row) => row.id === id)!;
    if (current.priority === priority) continue;
    const updated = await tx.rule.update({
      where: { id },
      data: { priority, revision: { increment: 1 }, updatedById: actor.id },
      include: { ruleTags: true, candidateOrigin: true },
    });
    await appendRuleRevision(tx, updated, actor.id);
    await auditRule(tx, actor, updated, 'rule-reordered', `Priority ${priority}`);
  }
  return tx.rule.findMany({
    where: { companyId, enabled: true, retiredAt: null },
    include: { ruleTags: true, candidateOrigin: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
  });
}

async function auditRule(
  tx: RuleTransaction,
  actor: RuleActor,
  rule: RuleRow,
  action: string,
  after: string,
): Promise<void> {
  await tx.auditEntry.create({
    data: {
      companyId: rule.companyId,
      actorId: actor.id,
      actorLabel: actor.label,
      payee: rule.matchText,
      amount: 0,
      action,
      before: 'Rule',
      after,
      payload: { ruleId: rule.id, revision: rule.revision },
    },
  });
}

export async function readCanonicalRuleRevision(
  tx: RuleDb,
  companyId: string,
  ruleId: string,
  revision?: number,
): Promise<CanonicalRuleRevision> {
  const row = await tx.ruleRevision.findFirst({
    where: { companyId, ruleId, ...(revision === undefined ? {} : { revision }) },
    orderBy: { revision: 'desc' },
  });
  if (row === null) throw new RuleServiceError('NOT_FOUND', 'Rule revision was not found.');
  const tagIds = normalizeActionTagIds(row.tagIds);
  if (
    row.categoryQboId === null
    || (
      row.taxCalculation !== 'TaxInclusive'
      && row.taxCalculation !== 'TaxExcluded'
      && row.taxCalculation !== 'NotApplicable'
    )
  ) invalid('Rule revision is not executable.');
  return parseRuleRevision({
    id: row.id,
    ruleId: row.ruleId,
    companyId: row.companyId,
    revision: row.revision,
    state: row.state,
    condition: { matchField: 'payee', matchText: row.matchText },
    action: {
      categoryQboId: row.categoryQboId,
      taxCalculation: row.taxCalculation,
      taxCodeQboId: row.taxCodeQboId,
      tagIds,
    },
    categoryName: row.category,
    taxCodeName: row.taxCode,
    priority: row.priority,
    autoPost: row.autoPost,
    originIntent: row.originIntent,
    sourceCaseId: row.sourceCaseId,
    sourceCandidateId: row.sourceCandidateId,
    changedBy: row.changedBy,
    createdAt: row.createdAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
  });
}

export async function testRuleCondition(
  db: RuleDb,
  companyId: string,
  matchText: string,
  options: { priorityTop?: boolean; excludeRuleId?: string } = {},
): Promise<{
  samples: RuleMutationSample[];
  pendingCount: number;
  postedCount: number;
  conflicts: ClassificationConflict[];
  legacy: RuleTestResult;
}> {
  const needle = safeText(matchText, 200, 'Rule condition').toLowerCase();
  const [transactions, existingRules] = await Promise.all([
    db.transaction.findMany({
      where: { companyId, status: { in: ['PENDING', 'POSTED', 'DRY_RUN'] } },
      select: { id: true, payee: true, date: true, amount: true, status: true },
      orderBy: { date: 'desc' },
      take: 200,
    }),
    db.rule.findMany({
      where: {
        companyId,
        enabled: true,
        retiredAt: null,
        ...(options.excludeRuleId ? { id: { not: options.excludeRuleId } } : {}),
      },
      include: { ruleTags: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    }),
  ]);
  const matched = transactions.filter(({ payee }) => payee.toLowerCase().includes(needle));
  const legacyMatches: RuleTestMatch[] = matched.map((transaction) => {
    const existingWinner = ruleSuggestion(transaction.payee, existingRules);
    return {
      txnId: transaction.id,
      payee: transaction.payee,
      date: transaction.date.toISOString(),
      amount: Number(transaction.amount),
      status: transaction.status as TxnStatus,
      wouldWin: options.priorityTop !== false || existingWinner === null,
      currentWinner: existingWinner?.winnerMatchText ?? null,
    };
  });
  const overlaps = existingRules.filter((rule) => matched.some(({ payee }) => {
    const candidate = rule.matchText.trim().toLowerCase();
    return candidate.length > 0 && payee.toLowerCase().includes(candidate);
  }));
  const legacyConflicts: RuleTestConflict[] = overlaps.map((rule) => ({
    ruleId: rule.id,
    matchText: rule.matchText,
    category: rule.category,
    priority: rule.priority,
  }));
  const conflicts: ClassificationConflict[] = overlaps.slice(0, 20).map((rule) => {
    const action: ClassificationAction | null = rule.categoryQboId !== null
      && (
        rule.taxCalculation === 'TaxInclusive'
        || rule.taxCalculation === 'TaxExcluded'
        || rule.taxCalculation === 'NotApplicable'
      )
      && parseActionTagIds(rule.ruleTags.map(({ tagId }) => tagId)) !== null
      ? {
          categoryQboId: rule.categoryQboId,
          taxCalculation: rule.taxCalculation,
          taxCodeQboId: rule.taxCodeQboId,
          tagIds: rule.ruleTags.map(({ tagId }) => tagId).sort(),
        }
      : null;
    return {
      id: `rule:${rule.id}`,
      companyId,
      sourceId: rule.id,
      kind: 'rule',
      reason: 'An active rule overlaps a matching transaction.',
      action,
      actionSummary: action === null ? null : {
        categoryName: rule.category,
        taxCalculation: action.taxCalculation,
        taxCodeName: rule.taxCode,
        tagNames: [],
      },
      evidenceCount: 0,
    };
  });
  const samples: RuleMutationSample[] = matched.slice(0, 20).map((transaction) => ({
    transactionId: transaction.id,
    payee: transaction.payee,
    date: transaction.date.toISOString(),
    amountCents: Math.round(Number(transaction.amount) * 100),
    status: transaction.status === 'PENDING' ? 'PENDING' : 'POSTED',
  }));
  const pendingCount = matched.filter(({ status }) => status === 'PENDING').length;
  const postedCount = matched.length - pendingCount;
  return {
    samples,
    pendingCount,
    postedCount,
    conflicts,
    legacy: {
      matches: legacyMatches,
      pendingCount,
      postedCount,
      conflicts: legacyConflicts,
    },
  };
}

export async function listRules(companyId: string, db: RuleDb = prisma): Promise<RuleRow[]> {
  return db.rule.findMany({
    where: { companyId, enabled: true, retiredAt: null },
    include: { ruleTags: true, candidateOrigin: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function createRule(
  companyId: string,
  actor: RuleActor,
  input: Omit<CreateRuleInput, 'priority' | 'initialRevision'> & { priority?: number },
  db: PrismaClient = prisma,
): Promise<RuleRow> {
  return runCompanyMutationTransaction(db, companyId, async (tx) => {
    let priority = input.priority;
    if (priority === undefined) {
      const aggregate = await tx.rule.aggregate({
        where: { companyId, enabled: true, retiredAt: null },
        _min: { priority: true },
      });
      priority = aggregate._min.priority === null ? 0 : aggregate._min.priority - 1;
    }
    return createRuleInTransaction(tx, companyId, actor, {
      ...input,
      priority,
      initialRevision: 0,
    });
  });
}

export function testRule(
  companyId: string,
  matchText: string,
  priorityTop = true,
  db: RuleDb = prisma,
): Promise<RuleTestResult> {
  return testRuleCondition(db, companyId, matchText, { priorityTop })
    .then(({ legacy }) => legacy);
}

export async function updateRule(
  companyId: string,
  ruleId: string,
  actor: RuleActor,
  patch: UpdateRuleInput,
  db: PrismaClient = prisma,
): Promise<RuleRow> {
  return runCompanyMutationTransaction(db, companyId, async (tx) => {
    const current = await loadCompanyRule(tx, companyId, ruleId);
    return updateRuleInTransaction(tx, companyId, ruleId, current.revision, actor, patch);
  });
}

export async function reorderRules(
  companyId: string,
  ids: string[],
  actor: RuleActor,
  db: PrismaClient = prisma,
): Promise<RuleRow[]> {
  return runCompanyMutationTransaction(db, companyId, async (tx) => {
    const current = await tx.rule.findMany({
      where: { companyId, enabled: true, retiredAt: null },
      select: { revision: true },
    });
    return reorderRulesInTransaction(
      tx,
      companyId,
      ids,
      Math.max(...current.map(({ revision }) => revision)),
      actor,
    );
  });
}

export async function retireRule(
  companyId: string,
  ruleId: string,
  actor: RuleActor,
  db: PrismaClient = prisma,
): Promise<void> {
  await runCompanyMutationTransaction(db, companyId, async (tx) => {
    const current = await loadCompanyRule(tx, companyId, ruleId);
    await retireRuleInTransaction(tx, companyId, ruleId, current.revision, actor);
  });
}
