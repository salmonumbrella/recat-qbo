import { Buffer } from 'node:buffer';
import { Router } from 'express';
import { z } from 'zod';
import type { AgentCompanySettingsDto, AgentRunStatus } from '@recat/shared';
import { asyncHandler, HttpError, validate } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import {
  agentDecisionSchemaVersion,
  parseAgentDecision,
} from '../services/agent/core/decision.js';
import { AGENT_MODEL_PROMPT_VERSION } from '../services/agent/core/model.js';
import {
  getShadowEvidenceSummaryInTransaction,
  type EvaluationQueryDb,
} from '../services/agent/evaluation.js';
import {
  AgentSettingError,
  getAgentSettings,
  type AgentSettingsDb,
  updateShadowSettings,
} from '../services/agent/settings.js';
import {
  getInstanceSettings,
  type InstanceSettingsDb,
} from '../services/instanceSettings.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_CURSOR_LENGTH = 512;
const MAX_SAFE_CODE_LENGTH = 120;
const MAX_ALIAS_LENGTH = 200;

const limitsSchema = z.object({
  maxToolCalls: z.number().int().min(1).max(8).optional(),
  maxTurns: z.number().int().min(1).max(4).optional(),
  maxContextBytes: z.number().int().min(1).max(65_536).optional(),
  maxResponseBytes: z.number().int().min(1).max(32_768).optional(),
  timeoutMs: z.number().int().min(1).max(30_000).optional(),
}).strict();

const settingsPatchSchema = z.object({
  mode: z.enum(['off', 'shadow']).optional(),
  provider: z.enum(['custom', 'openrouter']).optional(),
  decisionModel: z.string().trim().min(1).max(MAX_ALIAS_LENGTH).optional(),
  verifierModel: z.string().trim().min(1).max(MAX_ALIAS_LENGTH).optional(),
  scheduleMinutes: z.number().int().min(1).max(1_440).optional(),
  companyConcurrency: z.number().int().min(1).max(4).optional(),
  evidenceThreshold: z.number().int().min(25).max(1_000).optional(),
  limits: limitsSchema.optional(),
}).strict().refine((body) => Object.keys(body).length > 0, {
  message: 'At least one setting is required.',
});

const listQuerySchema = z.object({
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number)
    .refine((value) => value <= MAX_PAGE_SIZE, `Must be at most ${MAX_PAGE_SIZE}.`)
    .optional(),
}).strict();

const runIdSchema = z.string().trim().min(1).max(200);

type RunRow = {
  id: string;
  configVersion: string;
  attemptCount: number;
  status: string;
  decision: unknown;
  verification: unknown;
  decisionModel: string;
  verifierModel: string;
  promptVersion: string;
  schemaVersion: string;
  durationMs: number | null;
  usage: unknown;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export interface AutopilotSafeRunDto {
  id: string;
  status: AgentRunStatus;
  attemptCount: number;
  configVersion: string;
  proposal:
    | {
        kind: 'proposal';
        taxCalculation: 'TaxInclusive' | 'TaxExcluded' | 'NotApplicable';
        confidence: number;
        lineCount: number;
        evidenceKinds: ('category' | 'rule' | 'similar_transaction' | 'tax_code')[];
      }
    | {
        kind: 'abstain';
        reasonCode:
          | 'INSUFFICIENT_CONTEXT'
          | 'CONFLICTING_EVIDENCE'
          | 'UNSUPPORTED_TRANSACTION'
          | 'INVALID_TAX_STATE'
          | 'PROVIDER_FAILURE';
      }
    | null;
  verification: {
    diagnosticCode: string | null;
    verifierKind: 'deterministic' | 'same_model' | 'distinct_model' | 'unavailable';
    evidence: {
      state: 'eligible' | 'invalidated';
      agreement?: boolean;
      invalidationReason?: 'corrected' | 'reverted';
    } | null;
  };
  models: {
    decision: string;
    verifier: string;
    promptVersion: string;
    schemaVersion: string;
  };
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null;
  timing: {
    durationMs: number | null;
    createdAt: string;
    completedAt: string | null;
  };
  errorCode: string | null;
}

interface PageCursor {
  createdAt: Date;
  id: string;
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string'
    && value.length <= MAX_SAFE_CODE_LENGTH
    && /^AGENT_[A-Z0-9_]+$/.test(value)
    ? value
    : null;
}

function safeAlias(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_ALIAS_LENGTH
    ? trimmed
    : 'unavailable';
}

function safeConfigVersion(value: string): string {
  return /^[0-9a-f]{64}$/.test(value) ? value : 'unavailable';
}

function safePromptVersion(value: string): string {
  return value === AGENT_MODEL_PROMPT_VERSION ? value : 'unavailable';
}

function safeSchemaVersion(value: string): string {
  return value === String(agentDecisionSchemaVersion) ? value : 'unavailable';
}

function safeNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function projectProposal(value: unknown): AutopilotSafeRunDto['proposal'] {
  try {
    const decision = parseAgentDecision({ decision: value });
    if (decision.kind === 'abstain') {
      return { kind: 'abstain', reasonCode: decision.reasonCode };
    }
    return {
      kind: 'proposal',
      taxCalculation: decision.taxCalculation,
      confidence: decision.confidence,
      lineCount: decision.lines.length,
      evidenceKinds: [...new Set(decision.evidence.map((entry) => entry.kind))].sort(),
    };
  } catch {
    return null;
  }
}

function projectEvidence(value: unknown): AutopilotSafeRunDto['verification']['evidence'] {
  const evidence = runtimeRecord(runtimeRecord(value)?.evidenceEvaluation);
  if (evidence?.state === 'eligible' && typeof evidence.agreement === 'boolean') {
    return { state: 'eligible', agreement: evidence.agreement };
  }
  if (
    evidence?.state === 'invalidated'
    && (evidence.invalidationReason === 'corrected' || evidence.invalidationReason === 'reverted')
  ) {
    return {
      state: 'invalidated',
      invalidationReason: evidence.invalidationReason,
    };
  }
  return null;
}

function verifierKind(value: unknown): AutopilotSafeRunDto['verification']['verifierKind'] {
  return value === 'same_model' || value === 'distinct_model' || value === 'deterministic'
    ? value
    : 'unavailable';
}

function runStatus(value: string): AgentRunStatus {
  return value === 'running' || value === 'verified' || value === 'abstain' || value === 'failed'
    ? value
    : 'failed';
}

function projectUsage(value: unknown): AutopilotSafeRunDto['usage'] {
  const usage = runtimeRecord(value);
  if (usage === null) return null;
  const inputTokens = safeNonnegativeInteger(usage.inputTokens);
  const outputTokens = safeNonnegativeInteger(usage.outputTokens);
  const totalTokens = safeNonnegativeInteger(usage.totalTokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return null;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

export function toAutopilotSafeRunDto(run: RunRow): AutopilotSafeRunDto {
  const verification = runtimeRecord(run.verification);
  const durationMs = safeNonnegativeInteger(run.durationMs);
  return {
    id: run.id,
    status: runStatus(run.status),
    attemptCount: safeNonnegativeInteger(run.attemptCount) ?? 0,
    configVersion: safeConfigVersion(run.configVersion),
    proposal: projectProposal(run.decision),
    verification: {
      diagnosticCode: safeCode(verification?.diagnosticCode),
      verifierKind: verifierKind(verification?.verificationMode),
      evidence: projectEvidence(run.verification),
    },
    models: {
      decision: safeAlias(run.decisionModel),
      verifier: safeAlias(run.verifierModel),
      promptVersion: safePromptVersion(run.promptVersion),
      schemaVersion: safeSchemaVersion(run.schemaVersion),
    },
    usage: projectUsage(run.usage),
    timing: {
      durationMs: durationMs ?? null,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    },
    errorCode: safeCode(run.errorCode),
  };
}

function encodeCursor(row: Pick<RunRow, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id]), 'utf8')
    .toString('base64url');
}

function decodeCursor(value: string): PageCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof decoded[0] !== 'string'
      || typeof decoded[1] !== 'string'
      || decoded[1].length < 1
      || decoded[1].length > 200
    ) {
      throw new Error('invalid');
    }
    const createdAt = new Date(decoded[0]);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== decoded[0]) {
      throw new Error('invalid');
    }
    return { createdAt, id: decoded[1] };
  } catch {
    throw new HttpError(400, 'Invalid request: malformed cursor', 'VALIDATION');
  }
}

function runSelect() {
  return {
    id: true,
    configVersion: true,
    attemptCount: true,
    status: true,
    decision: true,
    verification: true,
    decisionModel: true,
    verifierModel: true,
    promptVersion: true,
    schemaVersion: true,
    durationMs: true,
    usage: true,
    errorCode: true,
    createdAt: true,
    completedAt: true,
  } as const;
}

interface QueueDb {
  agentJob: Pick<typeof prisma.agentJob, 'count' | 'findFirst'>;
}

async function queueHealth(companyId: string, db: QueueDb) {
  const [queued, running, retrying, terminal, cancelled, oldest, nextLease] = await Promise.all([
    db.agentJob.count({ where: { companyId, status: 'queued' } }),
    db.agentJob.count({ where: { companyId, status: 'running' } }),
    db.agentJob.count({ where: { companyId, status: 'retry' } }),
    db.agentJob.count({ where: { companyId, status: 'terminal' } }),
    db.agentJob.count({ where: { companyId, status: 'cancelled' } }),
    db.agentJob.findFirst({
      where: { companyId, status: { in: ['queued', 'retry'] } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      select: { dueAt: true },
    }),
    db.agentJob.findFirst({
      where: { companyId, status: 'running' },
      orderBy: [{ leaseExpiresAt: 'asc' }, { id: 'asc' }],
      select: { leaseExpiresAt: true },
    }),
  ]);
  return {
    queued,
    running,
    retrying,
    terminal,
    cancelled,
    earliestDueAt: oldest?.dueAt.toISOString() ?? null,
    earliestLeaseExpiryAt: nextLease?.leaseExpiresAt?.toISOString() ?? null,
  };
}

async function overview(companyId: string) {
  return prisma.$transaction(async (tx) => {
    const [settings, evidence, queue] = await Promise.all([
      getAgentSettings(companyId, {
        db: tx as unknown as AgentSettingsDb,
        getInstanceSettings: () =>
          getInstanceSettings(tx as unknown as InstanceSettingsDb),
      }),
      getShadowEvidenceSummaryInTransaction(
        companyId,
        tx as unknown as EvaluationQueryDb,
      ),
      queueHealth(companyId, tx as unknown as QueueDb),
    ]);
    return { settings, queue, evidence };
  }, { isolationLevel: 'RepeatableRead' });
}

function companyId(req: { company?: { id: string } }): string {
  if (!req.company) throw new HttpError(404, 'Company not found', 'COMPANY_NOT_FOUND');
  return req.company.id;
}

export const autopilotRouter = Router({ mergeParams: true });
autopilotRouter.use(requireUser, withCompany({ allowDisconnected: true }));

autopilotRouter.get(
  '/',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    res.json(await overview(companyId(req)));
  }),
);

autopilotRouter.patch(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = validate(settingsPatchSchema)(req.body);
    if (req.company?.disconnectedAt != null && body.mode === 'shadow') {
      throw new HttpError(
        409,
        'Shadow autopilot cannot be enabled for a disconnected company.',
        'COMPANY_DISCONNECTED',
      );
    }
    try {
      const updated = await updateShadowSettings(companyId(req), body);
      res.json(updated satisfies AgentCompanySettingsDto);
    } catch (error) {
      if (error instanceof AgentSettingError) {
        throw new HttpError(400, 'Invalid shadow agent settings.', error.code);
      }
      throw error;
    }
  }),
);

autopilotRouter.get(
  '/runs',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const query = validate(listQuerySchema)(req.query);
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await prisma.agentRun.findMany({
      where: {
        companyId: companyId(req),
        ...(cursor === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: runSelect(),
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({
      runs: page.map((row) => toAutopilotSafeRunDto(row)),
      nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
    });
  }),
);

autopilotRouter.get(
  '/runs/:id',
  requireRole('categorizer'),
  asyncHandler(async (req, res) => {
    const id = runIdSchema.safeParse(req.params.id);
    if (!id.success) throw new HttpError(400, 'Invalid request: malformed run id', 'VALIDATION');
    const run = await prisma.agentRun.findFirst({
      where: { id: id.data, companyId: companyId(req) },
      select: runSelect(),
    });
    if (run === null) throw new HttpError(404, 'Shadow run not found', 'AGENT_RUN_NOT_FOUND');
    res.json(toAutopilotSafeRunDto(run));
  }),
);

autopilotRouter.post(
  '/cancel-queued',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const result = await prisma.agentJob.updateMany({
      where: {
        companyId: companyId(req),
        status: { in: ['queued', 'retry'] },
      },
      data: {
        status: 'cancelled',
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'AGENT_CANCELLED_BY_ADMIN',
      },
    });
    res.json({ cancelled: result.count });
  }),
);
