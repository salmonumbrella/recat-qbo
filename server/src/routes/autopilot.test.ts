import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../lib/http.js';

const COMPANY_ID = '00000000-0000-4000-8000-000000000010';
const OTHER_COMPANY_ID = '00000000-0000-4000-8000-000000000020';
const RUN_ID = '00000000-0000-4000-8000-000000000030';

const mocks = vi.hoisted(() => ({
  agentJobCount: vi.fn(),
  agentJobFindFirst: vi.fn(),
  agentJobUpdateMany: vi.fn(),
  agentRunFindFirst: vi.fn(),
  agentRunFindMany: vi.fn(),
  companyFindUnique: vi.fn(),
  getAgentSettings: vi.fn(),
  getShadowEvidenceSummary: vi.fn(),
  membershipFindUnique: vi.fn(),
  prismaTransaction: vi.fn(),
  sessionFindUnique: vi.fn(),
  updateShadowSettings: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    agentJob: {
      count: mocks.agentJobCount,
      findFirst: mocks.agentJobFindFirst,
      updateMany: mocks.agentJobUpdateMany,
    },
    agentRun: {
      findFirst: mocks.agentRunFindFirst,
      findMany: mocks.agentRunFindMany,
    },
    company: { findUnique: mocks.companyFindUnique },
    membership: { findUnique: mocks.membershipFindUnique },
    session: { findUnique: mocks.sessionFindUnique },
    $transaction: mocks.prismaTransaction,
  },
}));

vi.mock('../services/agent/settings.js', () => ({
  AgentSettingError: class AgentSettingError extends Error {
    readonly code = 'AGENT_SETTING_INVALID';
  },
  getAgentSettings: mocks.getAgentSettings,
  updateShadowSettings: mocks.updateShadowSettings,
}));

vi.mock('../services/agent/evaluation.js', () => ({
  getShadowEvidenceSummary: mocks.getShadowEvidenceSummary,
  getShadowEvidenceSummaryInTransaction: mocks.getShadowEvidenceSummary,
}));

vi.mock('../services/instanceSettings.js', () => ({
  getInstanceSettings: vi.fn(),
}));

import { autopilotRouter } from './autopilot.js';

function testApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/companies/:companyId/autopilot', autopilotRouter);
  app.use(errorMiddleware);
  return app;
}

const sessionHeaders = { Cookie: 'recat_session=autopilot-route-test' };
let role: 'viewer' | 'categorizer' | 'admin' = 'admin';
let disconnected = false;

const overviewTransactionClient = {
  agentJob: {
    count: (...args: unknown[]) => mocks.agentJobCount(...args),
    findFirst: (...args: unknown[]) => mocks.agentJobFindFirst(...args),
  },
};

const CONFIG_VERSION = 'a'.repeat(64);

const settings = {
  mode: 'shadow',
  provider: 'custom',
  decisionModel: 'decision-model',
  verifierModel: 'verifier-model',
  scheduleMinutes: 10,
  companyConcurrency: 1,
  evidenceThreshold: 50,
  limits: {
    maxToolCalls: 8,
    maxTurns: 4,
    maxContextBytes: 65_536,
    maxResponseBytes: 32_768,
    timeoutMs: 30_000,
  },
  configVersion: CONFIG_VERSION,
};

const run = {
  id: RUN_ID,
  companyId: COMPANY_ID,
  transactionId: 'PRIVATE_TRANSACTION_ID',
  revision: 7,
  configVersion: CONFIG_VERSION,
  attemptCount: 1,
  status: 'verified',
  snapshot: { payee: 'PRIVATE_PAYEE_SENTINEL', providerKey: 'PRIVATE_KEY_SENTINEL' },
  decision: {
    kind: 'proposal',
    taxCalculation: 'TaxInclusive',
    confidence: 0.92,
    rationale: 'PRIVATE_RATIONALE_SENTINEL',
    evidence: [
      { kind: 'rule', id: '00000000-0000-4000-8000-000000000050' },
      { kind: 'category', qboId: 'PRIVATE_QBO_ACCOUNT_SENTINEL' },
    ],
    tagIds: ['00000000-0000-4000-8000-000000000060'],
    lines: [{
      grossCents: -12_345,
      categoryQboId: 'PRIVATE_QBO_ACCOUNT_SENTINEL',
      taxCodeQboId: 'PRIVATE_QBO_TAX_SENTINEL',
      memo: 'PRIVATE_MEMO_SENTINEL',
      tagIds: [],
    }],
  },
  verification: {
    diagnosticCode: 'AGENT_RUN_VERIFIED',
    verificationMode: 'distinct_model',
    turns: 2,
    toolCalls: 3,
    evidenceEvaluation: {
      state: 'eligible',
      outcomeRequestId: 'PRIVATE_REQUEST_ID_SENTINEL',
      inputRevision: 7,
      agreement: true,
    },
    rawProviderResponse: 'PRIVATE_PROVIDER_RESPONSE_SENTINEL',
  },
  decisionModel: 'decision-model',
  verifierModel: 'verifier-model',
  verifierKind: 'distinct_model',
  promptVersion: 'agent-model-v1',
  schemaVersion: '1',
  durationMs: 250,
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    raw: 'PRIVATE_USAGE_SENTINEL',
  },
  errorCode: null,
  createdAt: new Date('2026-07-29T10:00:00.000Z'),
  completedAt: new Date('2026-07-29T10:00:00.250Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  role = 'admin';
  disconnected = false;
  mocks.prismaTransaction.mockImplementation(
    async (callback: (tx: typeof overviewTransactionClient) => Promise<unknown>) =>
      callback(overviewTransactionClient),
  );
  mocks.sessionFindUnique.mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: 'autopilot-route-user',
      isInstanceAdmin: false,
      memberships: [],
    },
  });
  mocks.companyFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      disconnectedAt: disconnected ? new Date('2026-07-29T08:00:00.000Z') : null,
    }),
  );
  mocks.membershipFindUnique.mockImplementation(
    async ({ where }: { where: { userId_companyId: { companyId: string } } }) =>
      where.userId_companyId.companyId === COMPANY_ID ? { role } : null,
  );
  mocks.getAgentSettings.mockResolvedValue(settings);
  mocks.updateShadowSettings.mockResolvedValue(settings);
  mocks.getShadowEvidenceSummary.mockResolvedValue({
    eligibleRuns: 12,
    agreements: 10,
    disagreements: 2,
    threshold: 50,
    thresholdMet: false,
  });
  mocks.agentJobCount.mockImplementation(
    async ({ where }: { where: { status?: string | { in: string[] } } }) => {
      if (where.status === 'running') return 1;
      if (where.status === 'queued') return 3;
      if (typeof where.status === 'object' && where.status.in.includes('queued')) return 3;
      if (where.status === 'retry') return 1;
      if (where.status === 'terminal') return 2;
      if (where.status === 'cancelled') return 4;
      return 0;
    },
  );
  mocks.agentJobFindFirst.mockImplementation(
    async ({ where }: { where: { status: string | { in: string[] } } }) =>
      where.status === 'running'
        ? { leaseExpiresAt: new Date('2026-07-29T10:01:00.000Z') }
        : { dueAt: new Date('2026-07-29T09:00:00.000Z') },
  );
  mocks.agentJobUpdateMany.mockResolvedValue({ count: 4 });
  mocks.agentRunFindMany.mockResolvedValue([
    run,
    {
      ...run,
      id: '00000000-0000-4000-8000-000000000031',
      createdAt: new Date('2026-07-29T09:59:00.000Z'),
      completedAt: new Date('2026-07-29T09:59:00.250Z'),
    },
  ]);
  mocks.agentRunFindFirst.mockImplementation(
    async ({ where }: { where: { id: string; companyId: string } }) =>
      where.id === RUN_ID && where.companyId === COMPANY_ID ? run : null,
  );
});

describe('autopilot route authorization and settings', () => {
  it('lets company admins configure shadow mode and categorizers inspect runs', async () => {
    const app = testApp();
    const patch = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders)
      .send({ evidenceThreshold: 75 });

    role = 'categorizer';
    const runs = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs`)
      .set(sessionHeaders);

    role = 'viewer';
    const forbidden = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs`)
      .set(sessionHeaders);

    expect(patch.status).toBe(200);
    expect(runs.status).toBe(200);
    expect(forbidden.status).toBe(403);
    expect(mocks.updateShadowSettings).toHaveBeenCalledWith(
      COMPANY_ID,
      { evidenceThreshold: 75 },
    );
  });

  it('rejects non-admin updates and unknown, out-of-range, or mistyped settings', async () => {
    const app = testApp();
    role = 'categorizer';
    const forbidden = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders)
      .send({ mode: 'shadow' });

    role = 'admin';
    const invalidBodies = [
      { evidenceThreshold: 24 },
      { companyConcurrency: '1' },
      { scheduleMinutes: 1, unknown: true },
      { limits: { timeoutMs: 30_000, providerKey: 'PRIVATE_KEY_SENTINEL' } },
    ];
    const invalid = await Promise.all(invalidBodies.map((body) =>
      request(app)
        .patch(`/api/companies/${COMPANY_ID}/autopilot`)
        .set(sessionHeaders)
        .send(body)));

    expect(forbidden.status).toBe(403);
    expect(invalid.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(mocks.updateShadowSettings).not.toHaveBeenCalled();
  });

  it('rejects enabling shadow after disconnect while still allowing an administrator to turn it off', async () => {
    disconnected = true;
    const app = testApp();
    const enabled = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders)
      .send({ mode: 'shadow' });
    const disabled = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders)
      .send({ mode: 'off' });

    expect(enabled.status).toBe(409);
    expect(enabled.body).toEqual({
      error: 'Shadow autopilot cannot be enabled for a disconnected company.',
      code: 'COMPANY_DISCONNECTED',
    });
    expect(disabled.status).toBe(200);
    expect(mocks.updateShadowSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateShadowSettings).toHaveBeenCalledWith(COMPANY_ID, { mode: 'off' });
  });

  it('fails company isolation closed for both list and detail reads', async () => {
    role = 'categorizer';
    const app = testApp();
    const otherCompany = await request(app)
      .get(`/api/companies/${OTHER_COMPANY_ID}/autopilot/runs`)
      .set(sessionHeaders);
    const foreignRun = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/foreign-run`)
      .set(sessionHeaders);

    expect(otherCompany.status).toBe(403);
    expect(foreignRun.status).toBe(404);
    expect(mocks.agentRunFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'foreign-run', companyId: COMPANY_ID },
    }));
  });
});

describe('autopilot safe operational responses', () => {
  it('returns bounded health and evidence without lease ownership or raw content', async () => {
    role = 'categorizer';
    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders);
    const serialized = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      settings,
      evidence: { eligibleRuns: 12, threshold: 50, thresholdMet: false },
      queue: {
        queued: 3,
        running: 1,
        retrying: 1,
        terminal: 2,
        cancelled: 4,
        earliestDueAt: '2026-07-29T09:00:00.000Z',
        earliestLeaseExpiryAt: '2026-07-29T10:01:00.000Z',
      },
    });
    expect(serialized).not.toMatch(/lockOwner|leaseExpiresAt|snapshot|providerKey/i);
  });

  it('builds settings, evidence, and queue health from one repeatable-read snapshot client', async () => {
    role = 'categorizer';
    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(mocks.prismaTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'RepeatableRead' },
    );
    expect(mocks.getAgentSettings).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ db: overviewTransactionClient }),
    );
    expect(mocks.getShadowEvidenceSummary).toHaveBeenCalledWith(
      COMPANY_ID,
      overviewTransactionClient,
    );
  });

  it('projects proposals, evaluation, models, usage, and timing without raw accounting content', async () => {
    role = 'categorizer';
    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);
    const serialized = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: RUN_ID,
      status: 'verified',
      attemptCount: 1,
      configVersion: CONFIG_VERSION,
      proposal: {
        kind: 'proposal',
        taxCalculation: 'TaxInclusive',
        confidence: 0.92,
        lineCount: 1,
        evidenceKinds: ['category', 'rule'],
      },
      verification: {
        diagnosticCode: 'AGENT_RUN_VERIFIED',
        verifierKind: 'distinct_model',
        evidence: { state: 'eligible', agreement: true },
      },
      models: {
        decision: 'decision-model',
        verifier: 'verifier-model',
        promptVersion: 'agent-model-v1',
        schemaVersion: '1',
      },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      timing: {
        durationMs: 250,
        createdAt: '2026-07-29T10:00:00.000Z',
        completedAt: '2026-07-29T10:00:00.250Z',
      },
      errorCode: null,
    });
    expect(serialized).not.toMatch(
      /PRIVATE_|transactionId|revision|snapshot|rationale|memo|qbo|rawProvider|outcomeRequestId/i,
    );
  });

  it('reports the verification mode that actually ran instead of only the configured reviewer pair', async () => {
    role = 'categorizer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      verifierKind: 'distinct_model',
      verification: {
        diagnosticCode: 'AGENT_RUN_REVIEW_TAX_INVALID',
        verificationMode: 'deterministic',
      },
    });

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.verification.verifierKind).toBe('deterministic');
  });

  it.each([
    ['running without verification', 'running', null],
    ['abandoned without verification mode', 'failed', { diagnosticCode: 'AGENT_RUN_ABANDONED' }],
    ['corrupt verification mode', 'failed', { verificationMode: 'future_mode' }],
  ])('reports verification unavailable for %s', async (_label, status, verification) => {
    role = 'categorizer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      status,
      verification,
    });

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body.verification.verifierKind).toBe('unavailable');
  });

  it('fails closed on corrupt run versions while preserving bounded model aliases', async () => {
    role = 'categorizer';
    mocks.agentRunFindFirst.mockResolvedValue({
      ...run,
      configVersion: 'not-a-hash',
      promptVersion: 'future-or-corrupt-prompt',
      schemaVersion: '999',
      decisionModel: 'bounded-decision-alias',
      verifierModel: 'bounded-verifier-alias',
    });

    const response = await request(testApp())
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs/${RUN_ID}`)
      .set(sessionHeaders);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      configVersion: 'unavailable',
      models: {
        decision: 'bounded-decision-alias',
        verifier: 'bounded-verifier-alias',
        promptVersion: 'unavailable',
        schemaVersion: 'unavailable',
      },
    });
  });

  it('uses bounded opaque cursor pagination and rejects malformed limits', async () => {
    role = 'categorizer';
    const app = testApp();
    const first = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs?limit=1`)
      .set(sessionHeaders);
    const invalid = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs?limit=51`)
      .set(sessionHeaders);

    expect(first.status).toBe(200);
    expect(first.body.runs).toHaveLength(1);
    expect(typeof first.body.nextCursor).toBe('string');
    expect(first.body.nextCursor).not.toContain(RUN_ID);
    expect(invalid.status).toBe(400);

    mocks.agentRunFindMany.mockResolvedValue([]);
    const next = await request(app)
      .get(`/api/companies/${COMPANY_ID}/autopilot/runs?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set(sessionHeaders);
    expect(next.status).toBe(200);
    expect(mocks.agentRunFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: COMPANY_ID }),
      take: 2,
    }));
  });

  it('cancels only queued and retry jobs without deleting history or touching running leases', async () => {
    const app = testApp();
    role = 'categorizer';
    const forbidden = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/cancel-queued`)
      .set(sessionHeaders);

    role = 'admin';
    const cancelled = await request(app)
      .post(`/api/companies/${COMPANY_ID}/autopilot/cancel-queued`)
      .set(sessionHeaders);

    expect(forbidden.status).toBe(403);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ cancelled: 4 });
    expect(mocks.agentJobUpdateMany).toHaveBeenCalledWith({
      where: {
        companyId: COMPANY_ID,
        status: { in: ['queued', 'retry'] },
      },
      data: {
        status: 'cancelled',
        lockOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'AGENT_CANCELLED_BY_ADMIN',
      },
    });
    expect(mocks.agentRunFindMany).not.toHaveBeenCalled();
  });
});
