import { createHash } from 'node:crypto';
import type { Actor, DurableMutationResult } from '../writeback.js';
import { reconcileGuardedLiveCategorization } from '../writeback.js';
import { prisma } from '../../lib/prisma.js';
import { EntityLeaseError } from '../entityLease.js';
import { lockCompanyMutationScope } from '../companyMutationScope.js';
import {
  liveAdminAuthority,
  type LiveAdminAuthorityDeps,
  type LiveAdminAuthorityDb,
} from './liveAdminAuthority.js';
import { isCanonicalLiveCheckpoint } from './liveCheckpoint.js';

const MAX_RECONCILIATION_CANDIDATES = 32;

export interface LiveReconciliationInput {
  readonly companyId: string;
  readonly transactionId: string;
  readonly qboType: 'Purchase';
  readonly qboId: string;
  readonly requestId: string;
  readonly operation: 'recategorize';
  readonly expectedRevision: number;
  readonly configVersion: string;
  readonly requestHash: string;
  readonly checkpointHash: string;
}

export interface LiveReconciliationDeps extends LiveAdminAuthorityDeps {
  readonly loadBinding: (
    input: LiveReconciliationInput,
  ) => Promise<LiveReconciliationInput | null>;
  readonly reconcile: (
    input: LiveReconciliationInput,
    options?: {
      readonly signal?: AbortSignal;
      readonly actor?: Actor;
      readonly authorizeInTransaction?: (
        db: LiveAdminAuthorityDb,
      ) => Promise<boolean>;
    },
  ) => Promise<DurableMutationResult>;
}

interface LiveReconciliationRow {
  readonly companyId: string;
  readonly transactionId: string;
  readonly qboType: string;
  readonly qboId: string;
  readonly requestId: string;
  readonly operation: string;
  readonly expectedRevision: number;
  readonly configVersion: string;
  readonly requestHash: string;
  readonly checkpoint: unknown;
  readonly snapshotRevision: number;
  readonly decisionModel: string;
  readonly verifierModel: string;
}

export class LiveReconciliationError extends Error {
  readonly code = 'LIVE_RECONCILIATION_BINDING_MISMATCH';

  constructor() {
    super('Live reconciliation binding is unavailable.');
    this.name = 'LiveReconciliationError';
  }
}

export class LiveReconciliationAuthorizationError extends Error {
  readonly code = 'FORBIDDEN';

  constructor() {
    super('Administrative authority is required for live reconciliation.');
    this.name = 'LiveReconciliationAuthorizationError';
  }
}

const defaultDeps: LiveReconciliationDeps = {
  authorizeAdmin: liveAdminAuthority.authorizeAdmin,
  authorizeAdminInTransaction: liveAdminAuthority.authorizeAdminInTransaction,
  loadBinding: loadLiveReconciliationBinding,
  reconcile: (input, options) =>
    reconcileGuardedLiveCategorization(input, options),
};

export async function reconcileLiveMutation(
  input: LiveReconciliationInput,
  options: {
    readonly signal?: AbortSignal;
    readonly actor: Actor;
  },
  deps: LiveReconciliationDeps = defaultDeps,
): Promise<DurableMutationResult> {
  if (options?.actor?.id == null) {
    throw new LiveReconciliationAuthorizationError();
  }
  if (!await deps.authorizeAdmin(options.actor.id, input.companyId)) {
    throw new LiveReconciliationAuthorizationError();
  }
  const actorId = options.actor.id;
  return reconcileBoundLiveMutation(input, deps, {
    ...options,
    authorizeInTransaction: (db) =>
      deps.authorizeAdminInTransaction?.(db, actorId, input.companyId)
      ?? deps.authorizeAdmin(actorId, input.companyId),
  });
}

/**
 * Scheduler-only system capability. A static import boundary prevents routes
 * and other production modules from acquiring this null-actor entrypoint.
 */
export async function reconcileScheduledLiveMutation(
  input: LiveReconciliationInput,
  deps: LiveReconciliationDeps = defaultDeps,
  options: { readonly signal?: AbortSignal } = {},
): Promise<DurableMutationResult> {
  return reconcileBoundLiveMutation(input, deps, options);
}

async function reconcileBoundLiveMutation(
  input: LiveReconciliationInput,
  deps: LiveReconciliationDeps,
  options: {
    readonly signal?: AbortSignal;
    readonly actor?: Actor;
    readonly authorizeInTransaction?: (
      db: LiveAdminAuthorityDb,
    ) => Promise<boolean>;
  },
): Promise<DurableMutationResult> {
  const checked = validateInput(input);
  const binding = await deps.loadBinding(checked);
  if (binding === null || !sameBinding(checked, binding)) {
    throw new LiveReconciliationError();
  }
  try {
    return await deps.reconcile(checked, options);
  } catch (error) {
    if (!(error instanceof EntityLeaseError)) throw error;
    return {
      transactionId: checked.transactionId,
      requestId: checked.requestId,
      ok: false,
      status: 'ERROR',
      outcome: 'IN_PROGRESS',
      error: {
        code: 'MUTATION_IN_PROGRESS',
        message: 'The exact reconciliation is already in progress.',
      },
    };
  }
}

export async function isLiveReconciliationOwnedRequest(
  requestId: string,
  companyId: string,
  transactionId: string,
): Promise<boolean> {
  if (
    requestId.trim() === ''
    || companyId.trim() === ''
    || transactionId.trim() === ''
  ) throw new LiveReconciliationError();
  const rows = await prisma.$queryRawUnsafe<{ owned: boolean }[]>(
    `SELECT EXISTS (
       SELECT 1
         FROM "AgentJob" job
        WHERE job."id" = $1
     ) AS owned`,
    requestId,
  );
  return rows[0]?.owned === true;
}

export async function listLiveReconciliationCandidates(
  companyId: string,
): Promise<LiveReconciliationInput[]> {
  return queryLiveReconciliationCandidates(
    `AND job."companyId" = $1`,
    [companyId],
  );
}

export async function listAllLiveReconciliationCandidates(): Promise<
  LiveReconciliationInput[]
> {
  return queryLiveReconciliationCandidates('', []);
}

async function queryLiveReconciliationCandidates(
  companyFilter: string,
  params: readonly unknown[],
): Promise<LiveReconciliationInput[]> {
  const rows = await prisma.$queryRawUnsafe<LiveReconciliationRow[]>(
    `WITH eligible AS (
       SELECT job."companyId",
            job."transactionId",
            txn."qboType",
            txn."qboId",
            attempt."requestId",
            attempt."operation",
            attempt."expectedRevision",
            job."configVersion",
            attempt."requestHash",
            run."verification" -> 'liveCheckpoint' AS checkpoint,
            job."revision" AS "snapshotRevision",
            run."decisionModel",
            run."verifierModel",
            attempt."createdAt" AS "attemptCreatedAt",
            row_number() OVER (
              PARTITION BY job."companyId"
              ORDER BY attempt."createdAt", attempt."requestId"
            ) AS "companyRank"
       FROM "AgentJob" job
       JOIN "Transaction" txn
         ON txn."id" = job."transactionId"
        AND txn."companyId" = job."companyId"
       JOIN "QboMutationAttempt" attempt
         ON attempt."transactionId" = txn."id"
        AND attempt."requestId" = job."id"
       JOIN LATERAL (
         SELECT candidate."verification",
                candidate."decisionModel",
                candidate."verifierModel"
           FROM "AgentRun" candidate
          WHERE candidate."jobId" = job."id"
            AND candidate."status" = 'uncertain'
            AND candidate."errorCode" = 'LIVE_RECONCILIATION_REQUIRED'
            AND candidate."verification" ? 'liveCheckpoint'
          ORDER BY candidate."attemptCount" DESC
          LIMIT 1
       ) run ON TRUE
      WHERE job."status" = 'terminal'
        ${companyFilter}
        AND job."dueAt" <= clock_timestamp()
        AND job."companyId" IN (
          SELECT company."id"
            FROM "Company" company
           WHERE company."disconnectedAt" IS NULL
        )
        AND txn."revision" = attempt."expectedRevision"
        AND job."revision" >= 0
        AND job."revision" < 2147483647
        AND attempt."expectedRevision" = job."revision" + 1
        AND txn."qboType" = 'Purchase'
        AND attempt."operation" = 'recategorize'
        AND (
          (
            attempt."status" = 'COMMITTING'
            AND txn."status" = 'PENDING'
          )
          OR (
            attempt."status" = 'UNCERTAIN'
            AND txn."status" = 'ERROR'
          )
        )
        AND attempt."errorCode" IS DISTINCT FROM 'QBO_READBACK_MISMATCH'
    )
    SELECT "companyId",
           "transactionId",
           "qboType",
           "qboId",
           "requestId",
           "operation",
           "expectedRevision",
           "configVersion",
           "requestHash",
           checkpoint,
           "snapshotRevision",
           "decisionModel",
           "verifierModel"
      FROM eligible
     ORDER BY "companyRank",
              md5(
                "companyId" || ':' ||
                floor(extract(epoch FROM clock_timestamp()) / 60)::text
              ),
              "attemptCreatedAt",
              "requestId"
      LIMIT ${MAX_RECONCILIATION_CANDIDATES}`,
    ...params,
  );
  return rows.flatMap(rowToInput);
}

export async function loadLiveReconciliationBinding(
  input: LiveReconciliationInput,
): Promise<LiveReconciliationInput | null> {
  const rows = await prisma.$queryRawUnsafe<LiveReconciliationRow[]>(
    `SELECT job."companyId",
            job."transactionId",
            txn."qboType",
            txn."qboId",
            attempt."requestId",
            attempt."operation",
            attempt."expectedRevision",
            job."configVersion",
            attempt."requestHash",
            run."verification" -> 'liveCheckpoint' AS checkpoint,
            job."revision" AS "snapshotRevision",
            run."decisionModel",
            run."verifierModel"
       FROM "AgentJob" job
       JOIN "Transaction" txn
         ON txn."id" = job."transactionId"
        AND txn."companyId" = job."companyId"
       JOIN "QboMutationAttempt" attempt
         ON attempt."transactionId" = txn."id"
        AND attempt."requestId" = job."id"
       JOIN LATERAL (
         SELECT candidate."status", candidate."errorCode",
                candidate."verification", candidate."decisionModel",
                candidate."verifierModel"
           FROM "AgentRun" candidate
          WHERE candidate."jobId" = job."id"
            AND candidate."verification" ? 'liveCheckpoint'
          ORDER BY candidate."attemptCount" DESC
          LIMIT 1
       ) run ON TRUE
      WHERE job."id" = $1
        AND job."companyId" = $2
        AND job."transactionId" = $3
        AND job."configVersion" = $4
        AND txn."qboType" = 'Purchase'
        AND txn."qboId" = $5
        AND txn."revision" = $6
        AND attempt."operation" = 'recategorize'
        AND attempt."expectedRevision" = $6
        AND job."revision" >= 0
        AND job."revision" < 2147483647
        AND attempt."expectedRevision" = job."revision" + 1
        AND attempt."requestHash" = $7
        AND (
          (
            (
              (
                attempt."status" = 'COMMITTING'
                AND txn."status" = 'PENDING'
              )
              OR (
                attempt."status" = 'UNCERTAIN'
                AND txn."status" = 'ERROR'
              )
            )
            AND job."status" = 'terminal'
            AND run."status" = 'uncertain'
            AND run."errorCode" IN (
              'LIVE_RECONCILIATION_REQUIRED',
              'QBO_READBACK_MISMATCH'
            )
          )
          OR (
            attempt."status" = 'VERIFIED'
            AND txn."status" = 'POSTED'
            AND job."status" = 'completed'
            AND run."status" = 'posted_verified'
          )
          OR (
            attempt."status" = 'UNCHANGED'
            AND txn."status" = 'PENDING'
            AND job."status" = 'completed'
            AND run."status" = 'unchanged'
          )
        )
      LIMIT 1`,
    input.requestId,
    input.companyId,
    input.transactionId,
    input.configVersion,
    input.qboId,
    input.expectedRevision,
    input.requestHash,
  );
  return rows.flatMap(rowToInput)[0] ?? null;
}

export async function loadLiveReconciliationRequest(
  requestId: string,
  companyId: string,
  transactionId: string,
): Promise<LiveReconciliationInput | null> {
  if (
    requestId.trim() === ''
    || companyId.trim() === ''
    || transactionId.trim() === ''
  ) throw new LiveReconciliationError();
  const rows = await prisma.$queryRawUnsafe<LiveReconciliationRow[]>(
    `SELECT job."companyId",
            job."transactionId",
            txn."qboType",
            txn."qboId",
            attempt."requestId",
            attempt."operation",
            attempt."expectedRevision",
            job."configVersion",
            attempt."requestHash",
            run."verification" -> 'liveCheckpoint' AS checkpoint,
            job."revision" AS "snapshotRevision",
            run."decisionModel",
            run."verifierModel"
       FROM "AgentJob" job
       JOIN "Transaction" txn
         ON txn."id" = job."transactionId"
        AND txn."companyId" = job."companyId"
       JOIN "QboMutationAttempt" attempt
         ON attempt."transactionId" = txn."id"
        AND attempt."requestId" = job."id"
       JOIN LATERAL (
         SELECT candidate."status", candidate."errorCode",
                candidate."verification", candidate."decisionModel",
                candidate."verifierModel"
           FROM "AgentRun" candidate
          WHERE candidate."jobId" = job."id"
            AND candidate."status" = 'uncertain'
            AND candidate."errorCode" IN (
              'LIVE_RECONCILIATION_REQUIRED',
              'QBO_READBACK_MISMATCH'
            )
            AND candidate."verification" ? 'liveCheckpoint'
          ORDER BY candidate."attemptCount" DESC
          LIMIT 1
       ) run ON TRUE
      WHERE job."id" = $1
        AND job."companyId" = $2
        AND job."transactionId" = $3
        AND job."status" = 'terminal'
        AND txn."qboType" = 'Purchase'
        AND txn."revision" = attempt."expectedRevision"
        AND job."revision" >= 0
        AND job."revision" < 2147483647
        AND attempt."expectedRevision" = job."revision" + 1
        AND attempt."operation" = 'recategorize'
        AND (
          (
            attempt."status" = 'COMMITTING'
            AND txn."status" = 'PENDING'
          )
          OR (
            attempt."status" = 'UNCERTAIN'
            AND txn."status" = 'ERROR'
          )
        )
      LIMIT 1`,
    requestId,
    companyId,
    transactionId,
  );
  return rows.flatMap(rowToInput)[0] ?? null;
}

/**
 * Interactive capability lookup. The browser supplies only the opaque run ID;
 * every mutation authority field is joined from durable live ownership.
 */
export async function loadLiveReconciliationOperation(
  operationId: string,
  companyId: string,
): Promise<LiveReconciliationInput | null> {
  if (
    operationId.trim() === ''
    || operationId.length > 200
    || companyId.trim() === ''
    || companyId.length > 200
  ) throw new LiveReconciliationError();
  const rows = await prisma.$queryRawUnsafe<LiveReconciliationRow[]>(
    `SELECT job."companyId",
            job."transactionId",
            txn."qboType",
            txn."qboId",
            attempt."requestId",
            attempt."operation",
            attempt."expectedRevision",
            job."configVersion",
            attempt."requestHash",
            run."verification" -> 'liveCheckpoint' AS checkpoint,
            job."revision" AS "snapshotRevision",
            run."decisionModel",
            run."verifierModel"
       FROM "AgentRun" run
       JOIN "AgentJob" job
         ON job."id" = run."jobId"
        AND job."companyId" = run."companyId"
        AND job."transactionId" = run."transactionId"
        AND job."configVersion" = run."configVersion"
       JOIN "Transaction" txn
         ON txn."id" = job."transactionId"
        AND txn."companyId" = job."companyId"
       JOIN "QboMutationAttempt" attempt
         ON attempt."transactionId" = txn."id"
        AND attempt."requestId" = job."id"
      WHERE run."id" = $1
        AND run."companyId" = $2
        AND run."status" = 'uncertain'
        AND run."errorCode" IN (
          'LIVE_RECONCILIATION_REQUIRED',
          'QBO_READBACK_MISMATCH'
        )
        AND run."verification" ? 'liveCheckpoint'
        AND job."status" = 'terminal'
        AND txn."qboType" = 'Purchase'
        AND txn."revision" = attempt."expectedRevision"
        AND job."revision" >= 0
        AND job."revision" < 2147483647
        AND attempt."expectedRevision" = job."revision" + 1
        AND attempt."operation" = 'recategorize'
        AND (
          (
            attempt."status" = 'COMMITTING'
            AND txn."status" = 'PENDING'
          )
          OR (
            attempt."status" = 'UNCERTAIN'
            AND txn."status" = 'ERROR'
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM "AgentRun" newer
           WHERE newer."jobId" = run."jobId"
             AND newer."attemptCount" > run."attemptCount"
        )
      LIMIT 1`,
    operationId,
    companyId,
  );
  return rows.flatMap(rowToInput)[0] ?? null;
}

export async function deferLiveReconciliation(
  input: LiveReconciliationInput,
): Promise<void> {
  const checked = validateInput(input);
  await prisma.$transaction(async (tx) => {
    await lockCompanyMutationScope(tx, checked.companyId);
    const rows = await tx.$queryRawUnsafe<{
      checkpoint: unknown;
      snapshotRevision: number;
      decisionModel: string;
      verifierModel: string;
    }[]>(
      `SELECT run."verification" -> 'liveCheckpoint' AS checkpoint,
              job."revision" AS "snapshotRevision",
              run."decisionModel",
              run."verifierModel"
         FROM "AgentJob" job
         JOIN "Transaction" txn
           ON txn."id" = job."transactionId"
          AND txn."companyId" = job."companyId"
         JOIN "QboMutationAttempt" attempt
           ON attempt."transactionId" = txn."id"
          AND attempt."requestId" = job."id"
         JOIN LATERAL (
           SELECT candidate."verification",
                  candidate."decisionModel",
                  candidate."verifierModel"
             FROM "AgentRun" candidate
            WHERE candidate."jobId" = job."id"
              AND candidate."status" = 'uncertain'
              AND candidate."errorCode" IN (
                'LIVE_RECONCILIATION_REQUIRED',
                'QBO_READBACK_MISMATCH'
              )
              AND candidate."verification" ? 'liveCheckpoint'
            ORDER BY candidate."attemptCount" DESC
            LIMIT 1
         ) run ON TRUE
        WHERE job."id" = $1
          AND job."companyId" = $2
          AND job."transactionId" = $3
          AND job."configVersion" = $4
          AND job."status" = 'terminal'
          AND txn."qboType" = $5
          AND txn."qboId" = $6
          AND txn."revision" = $7
          AND attempt."operation" = $8
          AND attempt."expectedRevision" = $7
          AND job."revision" >= 0
          AND job."revision" < 2147483647
          AND attempt."expectedRevision" = job."revision" + 1
          AND attempt."requestHash" = $9
          AND (
            (
              attempt."status" = 'COMMITTING'
              AND txn."status" = 'PENDING'
            )
            OR (
              attempt."status" = 'UNCERTAIN'
              AND txn."status" = 'ERROR'
            )
          )
        LIMIT 1
        FOR UPDATE OF job, txn, attempt`,
      checked.requestId,
      checked.companyId,
      checked.transactionId,
      checked.configVersion,
      checked.qboType,
      checked.qboId,
      checked.expectedRevision,
      checked.operation,
      checked.requestHash,
    );
    if (
      rows[0] === undefined
      || !isCanonicalLiveCheckpoint(rows[0].checkpoint, rows[0])
      || hashCheckpoint(rows[0].checkpoint) !== checked.checkpointHash
    ) throw new LiveReconciliationError();
    const updated = await tx.$executeRawUnsafe(
      `UPDATE "AgentJob"
          SET "dueAt" = clock_timestamp() + INTERVAL '1 minute',
              "updatedAt" = clock_timestamp()
        WHERE "id" = $1
          AND "companyId" = $2
          AND "transactionId" = $3
          AND "configVersion" = $4
          AND "status" = 'terminal'`,
      checked.requestId,
      checked.companyId,
      checked.transactionId,
      checked.configVersion,
    );
    if (updated !== 1) throw new LiveReconciliationError();
  });
}

function rowToInput(row: LiveReconciliationRow): LiveReconciliationInput[] {
  if (
    row.qboType !== 'Purchase'
    || row.operation !== 'recategorize'
    || !Number.isSafeInteger(row.snapshotRevision)
    || row.snapshotRevision < 0
    || !Number.isSafeInteger(row.snapshotRevision + 1)
    || row.expectedRevision !== row.snapshotRevision + 1
    || !isCanonicalLiveCheckpoint(row.checkpoint, {
      snapshotRevision: row.snapshotRevision,
      decisionModel: row.decisionModel,
      verifierModel: row.verifierModel,
    })
  ) return [];
  return [validateInput({
    companyId: row.companyId,
    transactionId: row.transactionId,
    qboType: row.qboType,
    qboId: row.qboId,
    requestId: row.requestId,
    operation: row.operation,
    expectedRevision: row.expectedRevision,
    configVersion: row.configVersion,
    requestHash: row.requestHash,
    checkpointHash: hashCheckpoint(row.checkpoint),
  })];
}

function validateInput(input: LiveReconciliationInput): LiveReconciliationInput {
  if (
    typeof input !== 'object'
    || input === null
    || input.companyId.trim() === ''
    || input.transactionId.trim() === ''
    || input.qboType !== 'Purchase'
    || input.qboId.trim() === ''
    || input.requestId.trim() === ''
    || input.operation !== 'recategorize'
    || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 1
    || input.configVersion.trim() === ''
    || !/^[a-f0-9]{64}$/u.test(input.requestHash)
    || !/^[a-f0-9]{64}$/u.test(input.checkpointHash)
  ) throw new LiveReconciliationError();
  return input;
}

function sameBinding(
  expected: LiveReconciliationInput,
  actual: LiveReconciliationInput,
): boolean {
  return expected.companyId === actual.companyId
    && expected.transactionId === actual.transactionId
    && expected.qboType === actual.qboType
    && expected.qboId === actual.qboId
    && expected.requestId === actual.requestId
    && expected.operation === actual.operation
    && expected.expectedRevision === actual.expectedRevision
    && expected.configVersion === actual.configVersion
    && expected.requestHash === actual.requestHash
    && expected.checkpointHash === actual.checkpointHash;
}

export function hashCheckpoint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
