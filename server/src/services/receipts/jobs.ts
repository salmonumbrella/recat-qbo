import { prisma } from '../../lib/prisma.js';

const LEASE_MS = 60_000;
const MAX_CLAIMS = 4;
const MAX_ATTEMPTS = 3;
const CAPACITY_LOCK = 728_202_605;

export interface ReceiptJob {
  id: string;
  documentId: string;
  companyId: string;
  generation: number;
  configVersion: string;
  status: string;
  dueAt: Date;
  lockOwner: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ClaimedReceiptJob = ReceiptJob;

export type ReceiptJobResult =
  | { kind: 'succeeded'; at?: Date }
  | {
    kind: 'failed';
    transient: boolean;
    errorCode: string;
    at?: Date;
  };

export interface ReceiptJobDb {
  $transaction<T>(callback: (tx: ReceiptJobDb) => Promise<T>): Promise<T>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface ReceiptJobDeps {
  db: ReceiptJobDb;
  now?(tx: ReceiptJobDb): Promise<Date> | Date;
}

const defaultDeps: ReceiptJobDeps = {
  db: prisma as unknown as ReceiptJobDb,
};

export class ReceiptJobError extends Error {
  readonly code = 'RECEIPT_JOB_INVALID';

  constructor() {
    super('Invalid receipt job operation.');
    this.name = 'ReceiptJobError';
  }
}

export async function claimReceiptJobs(
  owner: string,
  limit: number,
  deps: ReceiptJobDeps = defaultDeps,
): Promise<ClaimedReceiptJob[]> {
  assertIdentifier(owner);
  const boundedLimit = Math.min(
    MAX_CLAIMS,
    Math.max(0, Number.isFinite(limit) ? Math.trunc(limit) : 0),
  );
  if (boundedLimit === 0) return [];

  return deps.db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT 1 AS "locked"
         FROM pg_advisory_xact_lock(${CAPACITY_LOCK})`,
    );
    const now = await currentTime(tx, deps);

    await tx.$queryRawUnsafe(
      `UPDATE "ReceiptProcessingJob" AS job
          SET "status" = 'cancelled',
              "dueAt" = $1,
              "lockOwner" = NULL,
              "leaseExpiresAt" = NULL,
              "lastErrorCode" = 'RECEIPT_SUPERSEDED',
              "updatedAt" = $1
         FROM "ReceiptDocument" AS document
        WHERE document."id" = job."documentId"
          AND job."status" IN ('queued', 'retry', 'running')
          AND (
            document."deletedAt" IS NOT NULL
            OR document."generation" <> job."generation"
          )`,
      now,
    );

    await tx.$queryRawUnsafe(
      `INSERT INTO "ReceiptExtractionAttempt" (
         "id", "jobId", "documentId", "generation", "attemptCount",
         "status", "model", "promptVersion", "schemaVersion", "errorCode",
         "startedAt", "completedAt"
       )
       SELECT gen_random_uuid(), job."id", job."documentId", job."generation",
              job."attemptCount", 'failed', 'unavailable',
              'receiptory-5afac9f0+recat-tax-components-v1',
              'recat-receipt-extraction/v1',
              'RECEIPT_ATTEMPT_ABANDONED', job."updatedAt", $1
         FROM "ReceiptProcessingJob" AS job
         JOIN "ReceiptDocument" AS document
           ON document."id" = job."documentId"
        WHERE job."status" = 'running'
          AND job."leaseExpiresAt" <= $1
          AND document."deletedAt" IS NULL
          AND document."generation" = job."generation"
       ON CONFLICT ("jobId", "attemptCount") DO NOTHING`,
      now,
    );
    await tx.$queryRawUnsafe(
      `WITH exhausted AS (
         UPDATE "ReceiptProcessingJob"
            SET "status" = 'terminal',
                "dueAt" = $1,
                "lockOwner" = NULL,
                "leaseExpiresAt" = NULL,
                "lastErrorCode" = 'RECEIPT_JOB_EXHAUSTED',
                "updatedAt" = $1
          WHERE "status" = 'running'
            AND "attemptCount" >= ${MAX_ATTEMPTS}
            AND "leaseExpiresAt" <= $1
         RETURNING "documentId", "generation"
       )
       UPDATE "ReceiptDocument" AS document
          SET "status" = 'NEEDS_REVIEW',
              "updatedAt" = $1
         FROM exhausted
        WHERE document."id" = exhausted."documentId"
          AND document."generation" = exhausted."generation"
          AND document."deletedAt" IS NULL`,
      now,
    );

    const candidates = await tx.$queryRawUnsafe<{ id: string }[]>(
      `WITH active AS MATERIALIZED (
         SELECT job."companyId"
           FROM "ReceiptProcessingJob" AS job
          WHERE job."status" = 'running'
            AND job."leaseExpiresAt" > $1
       ),
       capacity AS MATERIALIZED (
         SELECT GREATEST(0, ${MAX_CLAIMS} - COUNT(*))::integer AS slots
           FROM active
       ),
       ranked AS MATERIALIZED (
         SELECT job."id", job."dueAt",
                ROW_NUMBER() OVER (
                  PARTITION BY job."companyId"
                  ORDER BY job."dueAt", job."createdAt", job."id"
                ) AS "companyRank"
           FROM "ReceiptProcessingJob" AS job
           JOIN "ReceiptDocument" AS document
             ON document."id" = job."documentId"
           LEFT JOIN "ReceiptCompanyConfig" AS config
             ON config."companyId" = job."companyId"
          WHERE job."dueAt" <= $1
            AND job."attemptCount" < ${MAX_ATTEMPTS}
            AND (
              job."status" IN ('queued', 'retry')
              OR (
                job."status" = 'running'
                AND job."leaseExpiresAt" <= $1
              )
            )
            AND document."deletedAt" IS NULL
            AND document."generation" = job."generation"
            AND COALESCE(config."enabled", true)
            AND NOT EXISTS (
              SELECT 1 FROM active
               WHERE active."companyId" = job."companyId"
            )
       )
       SELECT job."id"
         FROM "ReceiptProcessingJob" AS job
         JOIN ranked ON ranked."id" = job."id"
         CROSS JOIN capacity
        WHERE ranked."companyRank" = 1
        ORDER BY ranked."dueAt", job."createdAt", job."id"
        FOR UPDATE OF job SKIP LOCKED
        LIMIT LEAST((SELECT slots FROM capacity), $2)`,
      now,
      boundedLimit,
    );
    if (candidates.length === 0) return [];
    const expiresAt = new Date(now.getTime() + LEASE_MS);
    return tx.$queryRawUnsafe<ClaimedReceiptJob[]>(
      `UPDATE "ReceiptProcessingJob" AS job
          SET "status" = 'running',
              "lockOwner" = $1,
              "leaseExpiresAt" = $2,
              "attemptCount" = job."attemptCount" + 1,
              "updatedAt" = $3
       WHERE job."id" = ANY($4::text[])
         AND job."attemptCount" < ${MAX_ATTEMPTS}
         AND (
           (
             job."status" IN ('queued', 'retry')
             AND job."dueAt" <= $3
           )
           OR (
             job."status" = 'running'
             AND job."leaseExpiresAt" <= $3
           )
         )
         AND EXISTS (
           SELECT 1
             FROM "ReceiptDocument" AS document
            WHERE document."id" = job."documentId"
              AND document."deletedAt" IS NULL
              AND document."generation" = job."generation"
         )
         AND COALESCE((
           SELECT config."enabled"
             FROM "ReceiptCompanyConfig" AS config
            WHERE config."companyId" = job."companyId"
         ), true)
        RETURNING ${returningColumns('job')}`,
      owner,
      expiresAt,
      now,
      candidates.map((candidate) => candidate.id),
    );
  });
}

export async function renewReceiptJob(
  job: ClaimedReceiptJob,
  owner: string,
  deps: ReceiptJobDeps = defaultDeps,
): Promise<boolean> {
  validateClaim(job, owner);
  return deps.db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT 1 AS "locked"
         FROM pg_advisory_xact_lock(${CAPACITY_LOCK})`,
    );
    const now = await currentTime(tx, deps);
    const expiresAt = new Date(now.getTime() + LEASE_MS);
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE "ReceiptProcessingJob"
          SET "leaseExpiresAt" = GREATEST("leaseExpiresAt", $1),
              "updatedAt" = $2
        WHERE "id" = $3
          AND "generation" = $4
          AND "status" = 'running'
          AND "lockOwner" = $5
          AND "attemptCount" = $6
          AND "leaseExpiresAt" > $2
        RETURNING "id"`,
      expiresAt,
      now,
      job.id,
      job.generation,
      owner,
      job.attemptCount,
    );
    return rows.length === 1;
  });
}

export async function finishReceiptJob(
  job: ClaimedReceiptJob,
  owner: string,
  result: ReceiptJobResult,
  deps: ReceiptJobDeps = defaultDeps,
): Promise<boolean> {
  validateClaim(job, owner);
  validateResult(result);
  return deps.db.$transaction(async (tx) => {
    const now = await currentTime(tx, deps);
    const at = result.at ?? now;
    const retry = result.kind === 'failed'
      && result.transient
      && job.attemptCount < MAX_ATTEMPTS;
    const status = result.kind === 'succeeded'
      ? 'completed'
      : retry ? 'retry' : 'terminal';
    const dueAt = retry
      ? new Date(at.getTime() + receiptRetryDelayMs(job.attemptCount))
      : at;
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE "ReceiptProcessingJob"
          SET "status" = $1,
              "dueAt" = $2,
              "lockOwner" = NULL,
              "leaseExpiresAt" = NULL,
              "lastErrorCode" = $3,
              "updatedAt" = $4
        WHERE "id" = $5
          AND "generation" = $6
          AND "status" = 'running'
          AND "lockOwner" = $7
          AND "attemptCount" = $8
          AND "leaseExpiresAt" > $4
        RETURNING "id"`,
      status,
      dueAt,
      result.kind === 'failed' ? result.errorCode : null,
      now,
      job.id,
      job.generation,
      owner,
      job.attemptCount,
    );
    return rows.length === 1;
  });
}

export function receiptRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 2) {
    throw new ReceiptJobError();
  }
  return [30_000, 120_000][attempt - 1]!;
}

function returningColumns(alias: string): string {
  return `${alias}."id", ${alias}."documentId", ${alias}."companyId",
    ${alias}."generation", ${alias}."configVersion", ${alias}."status",
    ${alias}."dueAt", ${alias}."lockOwner", ${alias}."leaseExpiresAt",
    ${alias}."attemptCount", ${alias}."lastErrorCode", ${alias}."createdAt",
    ${alias}."updatedAt"`;
}

function validateClaim(job: ClaimedReceiptJob, owner: string): void {
  assertIdentifier(job.id);
  assertIdentifier(owner);
  if (
    !Number.isInteger(job.generation)
    || job.generation < 1
    || !Number.isInteger(job.attemptCount)
    || job.attemptCount < 1
    || job.attemptCount > MAX_ATTEMPTS
  ) throw new ReceiptJobError();
}

function validateResult(result: ReceiptJobResult): void {
  if (
    result.kind !== 'succeeded'
    && (
      result.kind !== 'failed'
      || typeof result.transient !== 'boolean'
      || !/^RECEIPT_[A-Z0-9_]{1,80}$/.test(result.errorCode)
    )
  ) throw new ReceiptJobError();
  if (result.at !== undefined && Number.isNaN(result.at.getTime())) {
    throw new ReceiptJobError();
  }
}

function assertIdentifier(value: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new ReceiptJobError();
  }
}

async function currentTime(
  tx: ReceiptJobDb,
  deps: ReceiptJobDeps,
): Promise<Date> {
  if (deps.now) return checkedDate(await deps.now(tx));
  const rows = await tx.$queryRawUnsafe<{ now: Date | string }[]>(
    'SELECT clock_timestamp() AS "now"',
  );
  const value = rows[0]?.now;
  return checkedDate(value instanceof Date ? value : new Date(value ?? NaN));
}

function checkedDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ReceiptJobError();
  }
  return value;
}
