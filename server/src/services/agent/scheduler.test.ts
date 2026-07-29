import type { AgentCompanySettingsDto } from '@recat/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AgentModel } from './core/model.js';
import type { ClaimedAgentJob } from './jobs.js';
import {
  buildAgentModels,
  createAgentScheduler,
  listScheduledShadowCompanies,
  runScheduledShadowJob,
  type AgentSchedulerDeps,
  type AgentSchedulerModelConfig,
} from './scheduler.js';

const NOW = new Date('2026-07-29T08:20:00.000Z');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function job(id: string, companyId: string): ClaimedAgentJob {
  return {
    id,
    companyId,
    transactionId: `transaction-${id}`,
    revision: 0,
    configVersion: 'config-v1',
    status: 'running',
    dueAt: NOW,
    lockOwner: 'opaque-worker',
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    attemptCount: 1,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function schedulerDeps(
  overrides: Partial<AgentSchedulerDeps> = {},
): AgentSchedulerDeps {
  return {
    workerId: 'opaque-worker',
    globalConcurrency: 4,
    now: () => NOW,
    listShadowCompanies: async () => [],
    discoverJobs: async () => undefined,
    claimJobs: async () => [],
    runJob: async () => undefined,
    ...overrides,
  };
}

function companySettings(
  overrides: Partial<AgentCompanySettingsDto> = {},
): AgentCompanySettingsDto {
  return {
    mode: 'shadow',
    provider: 'openrouter',
    decisionModel: 'decision-alias',
    verifierModel: 'review-alias',
    scheduleMinutes: 10,
    companyConcurrency: 1,
    evidenceThreshold: 50,
    limits: {
      maxToolCalls: 7,
      maxTurns: 3,
      maxContextBytes: 12_345,
      maxResponseBytes: 6_789,
      timeoutMs: 9_876,
    },
    configVersion: 'config-v1',
    ...overrides,
  };
}

function model(provider: 'openrouter' | 'custom', name: string): AgentModel {
  return {
    identity: { provider, model: name },
    nextTurn: vi.fn(),
  };
}

describe('shadow agent scheduler', () => {
  it('lists only connected companies for production shadow scheduling', async () => {
    const findMany = vi.fn(async () => []);

    await listScheduledShadowCompanies({
      agentCompanyConfig: { findMany },
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        mode: 'shadow',
        company: { disconnectedAt: null },
      },
      select: { companyId: true, scheduleMinutes: true },
      orderBy: { companyId: 'asc' },
    });
  });

  it('does not overlap ticks in one process', async () => {
    const discovery = deferred<void>();
    const listShadowCompanies = vi.fn(async () => [
      { companyId: 'company-1', scheduleMinutes: 10 },
    ]);
    const discoverJobs = vi.fn(async () => discovery.promise);
    const scheduler = createAgentScheduler(schedulerDeps({
      listShadowCompanies,
      discoverJobs,
    }));

    const firstTick = scheduler.tick();
    await vi.waitFor(() => expect(discoverJobs).toHaveBeenCalledTimes(1));
    await scheduler.tick();
    expect(listShadowCompanies).toHaveBeenCalledTimes(1);

    discovery.resolve();
    await firstTick;
  });

  it('resets the overlap guard after a rejected tick', async () => {
    const listShadowCompanies = vi.fn()
      .mockRejectedValueOnce(new Error('sensitive failure'))
      .mockResolvedValueOnce([]);
    const scheduler = createAgentScheduler(schedulerDeps({ listShadowCompanies }));

    await expect(scheduler.tick()).rejects.toThrow('sensitive failure');
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(listShadowCompanies).toHaveBeenCalledTimes(2);
  });

  it('discovers only deterministic due companies and remains restart-safe', async () => {
    const listShadowCompanies = vi.fn(async () => [
      { companyId: 'due-10', scheduleMinutes: 10 },
      { companyId: 'not-due-7', scheduleMinutes: 7 },
      { companyId: 'due-4', scheduleMinutes: 4 },
    ]);
    const firstDiscover = vi.fn(async () => undefined);
    const secondDiscover = vi.fn(async () => undefined);

    await createAgentScheduler(schedulerDeps({
      listShadowCompanies,
      discoverJobs: firstDiscover,
    })).tick();
    await createAgentScheduler(schedulerDeps({
      listShadowCompanies,
      discoverJobs: secondDiscover,
    })).tick();

    expect(firstDiscover.mock.calls.map(([companyId]) => companyId)).toEqual(['due-10', 'due-4']);
    expect(secondDiscover.mock.calls).toEqual(firstDiscover.mock.calls);
  });

  it('does not let a pre-stop tick claim when restarted before discovery resolves', async () => {
    const discovery = deferred<void>();
    const discoverJobs = vi.fn(async () => discovery.promise);
    const claimJobs = vi.fn(async () => []);
    const scheduler = createAgentScheduler(schedulerDeps({
      listShadowCompanies: async () => [{ companyId: 'company-1', scheduleMinutes: 10 }],
      discoverJobs,
      claimJobs,
    }));

    const tick = scheduler.tick();
    await vi.waitFor(() => expect(discoverJobs).toHaveBeenCalledOnce());
    scheduler.stop();
    scheduler.start();
    discovery.resolve();
    await tick;
    expect(claimJobs).not.toHaveBeenCalled();

    await scheduler.tick();
    expect(claimJobs).toHaveBeenCalledOnce();
  });

  it('does not let a pre-stop tick launch when restarted before claim resolves', async () => {
    const firstClaim = deferred<readonly ClaimedAgentJob[]>();
    const claimJobs = vi.fn()
      .mockImplementationOnce(async () => firstClaim.promise)
      .mockResolvedValueOnce([job('job-2', 'company-1')]);
    const runJob = vi.fn(async () => undefined);
    const scheduler = createAgentScheduler(schedulerDeps({
      claimJobs,
      runJob,
    }));

    const tick = scheduler.tick();
    await vi.waitFor(() => expect(claimJobs).toHaveBeenCalledOnce());
    scheduler.stop();
    scheduler.start();
    firstClaim.resolve([job('job-1', 'company-1')]);
    await tick;

    expect(runJob).not.toHaveBeenCalled();

    await scheduler.tick();
    expect(runJob).toHaveBeenCalledOnce();
    expect(runJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-2' }));
  });

  it('isolates one claimed job failure from the other claimed jobs', async () => {
    const jobs = [job('job-1', 'company-1'), job('job-2', 'company-2')];
    const runJob = vi.fn(async (claimed: ClaimedAgentJob) => {
      if (claimed.id === 'job-1') throw new Error('sensitive job failure');
    });
    const scheduler = createAgentScheduler(schedulerDeps({
      claimJobs: async () => jobs,
      runJob,
    }));

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(runJob.mock.calls.map(([claimed]) => claimed.id)).toEqual(['job-1', 'job-2']);
  });

  it('builds provider-specific decision and review models with all bounded limits', () => {
    const created: AgentSchedulerModelConfig[] = [];
    const settings = companySettings();
    const built = buildAgentModels(settings, {
      aiEndpoint: 'https://custom.invalid/v1',
      aiApiKey: 'custom-secret',
      openrouterApiKey: 'openrouter-secret',
      openrouterReferer: 'https://recat.invalid',
      openrouterTitle: 'Recat',
    }, (config) => {
      created.push(config);
      return model(config.provider, config.model);
    });

    expect(created).toEqual([
      {
        provider: 'openrouter',
        model: 'decision-alias',
        apiKey: 'openrouter-secret',
        referer: 'https://recat.invalid',
        title: 'Recat',
      },
      {
        provider: 'openrouter',
        model: 'review-alias',
        apiKey: 'openrouter-secret',
        referer: 'https://recat.invalid',
        title: 'Recat',
      },
    ]);
    expect(built).toMatchObject({
      decisionModel: { identity: { provider: 'openrouter', model: 'decision-alias' } },
      reviewModel: { identity: { provider: 'openrouter', model: 'review-alias' } },
      limits: settings.limits,
    });
    expect(JSON.stringify(built)).not.toContain('openrouter-secret');
  });

  it('passes custom endpoint credentials only to model construction', () => {
    const created: AgentSchedulerModelConfig[] = [];
    const built = buildAgentModels(companySettings({
      provider: 'custom',
    }), {
      aiEndpoint: 'https://custom.invalid/v1',
      aiApiKey: 'custom-secret',
      openrouterApiKey: 'openrouter-secret',
      openrouterReferer: '',
      openrouterTitle: '',
    }, (config) => {
      created.push(config);
      return model(config.provider, config.model);
    });

    expect(created).toEqual([
      {
        provider: 'custom',
        model: 'decision-alias',
        baseUrl: 'https://custom.invalid/v1',
        apiKey: 'custom-secret',
      },
      {
        provider: 'custom',
        model: 'review-alias',
        baseUrl: 'https://custom.invalid/v1',
        apiKey: 'custom-secret',
      },
    ]);
    expect(JSON.stringify(built)).not.toContain('custom-secret');
  });

  it('fenced-terminalizes a claim when provider configuration is unavailable', async () => {
    const claimed = job('job-1', 'company-1');
    const runClaimedJob = vi.fn();
    const terminalize = vi.fn(async () => undefined);
    const createModel = vi.fn();

    await runScheduledShadowJob(claimed, 'opaque-worker', {
      getCompanySettings: async () => companySettings(),
      getProviderSettings: async () => ({
        aiEndpoint: '',
        aiApiKey: '',
        openrouterApiKey: '',
        openrouterReferer: '',
        openrouterTitle: '',
      }),
      createModel,
      runClaimedJob,
      terminalize,
      supersede: vi.fn(),
    });

    expect(createModel).not.toHaveBeenCalled();
    expect(runClaimedJob).not.toHaveBeenCalled();
    expect(terminalize).toHaveBeenCalledWith(
      claimed,
      'opaque-worker',
      'AGENT_MODEL_CONFIG_INVALID',
    );
  });

  it('does not terminalize a valid claim for an infrastructure settings read failure', async () => {
    const claimed = job('job-1', 'company-1');
    const terminalize = vi.fn(async () => undefined);

    await expect(runScheduledShadowJob(claimed, 'opaque-worker', {
      getCompanySettings: async () => {
        throw new Error('sensitive database failure');
      },
      getProviderSettings: async () => ({
        aiEndpoint: '',
        aiApiKey: '',
        openrouterApiKey: '',
        openrouterReferer: '',
        openrouterTitle: '',
      }),
      createModel: vi.fn(),
      runClaimedJob: vi.fn(),
      terminalize,
      supersede: vi.fn(),
    })).rejects.toThrow('sensitive database failure');

    expect(terminalize).not.toHaveBeenCalled();
  });

  it('fenced-supersedes a claim disabled after claim without constructing a model', async () => {
    const claimed = job('job-1', 'company-1');
    const createModel = vi.fn();
    const runClaimedJob = vi.fn();
    const terminalize = vi.fn(async () => undefined);
    const supersede = vi.fn(async () => true);

    await runScheduledShadowJob(claimed, 'opaque-worker', {
      getCompanySettings: async () => companySettings({
        mode: 'off',
        configVersion: 'config-v2',
      }),
      getProviderSettings: async () => {
        throw new Error('provider settings must not load for stale config');
      },
      createModel,
      runClaimedJob,
      terminalize,
      supersede,
    });

    expect(supersede).toHaveBeenCalledWith(claimed, 'opaque-worker');
    expect(createModel).not.toHaveBeenCalled();
    expect(runClaimedJob).not.toHaveBeenCalled();
    expect(terminalize).not.toHaveBeenCalled();
  });

  it('uses the existing jobs timer for start, tick, and stop integration', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const startAgentScheduler = vi.fn();
    const stopAgentScheduler = vi.fn();
    const runAgentTick = vi.fn(async () => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.doMock('../../lib/prisma.js', () => ({
      prisma: {
        transaction: { findMany: vi.fn(async () => []) },
        company: { findMany: vi.fn(async () => []) },
      },
    }));
    vi.doMock('../audit.js', () => ({ writeAudit: vi.fn() }));
    vi.doMock('../sync.js', () => ({ syncCompany: vi.fn(async () => undefined) }));
    vi.doMock('../../lib/mailer.js', () => ({
      isSmtpConfigured: vi.fn(async () => false),
      sendMail: vi.fn(),
    }));
    vi.doMock('./scheduler.js', () => ({
      startAgentScheduler,
      stopAgentScheduler,
      runAgentTick,
    }));

    const jobsScheduler = await import('../../jobs/scheduler.js');
    jobsScheduler.startJobs();
    expect(vi.getTimerCount()).toBe(1);
    expect(startAgentScheduler).toHaveBeenCalledOnce();
    expect(runAgentTick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runAgentTick).toHaveBeenCalledTimes(2);

    jobsScheduler.stopJobs();
    expect(stopAgentScheduler).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    consoleLog.mockRestore();
    vi.useRealTimers();
    vi.doUnmock('../../lib/prisma.js');
    vi.doUnmock('../audit.js');
    vi.doUnmock('../sync.js');
    vi.doUnmock('../../lib/mailer.js');
    vi.doUnmock('./scheduler.js');
  });
});
