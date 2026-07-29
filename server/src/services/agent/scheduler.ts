import { randomUUID } from 'node:crypto';
import type { AgentCompanySettingsDto } from '@recat/shared';
import { prisma } from '../../lib/prisma.js';
import { getInstanceSettings } from '../instanceSettings.js';
import type { AgentModel } from './core/model.js';
import type { AgentLimits } from './core/runner.js';
import {
  cancelSupersededAgentJob,
  claimShadowJobs,
  discoverShadowJobs,
  finishAgentJob,
  type ClaimedAgentJob,
} from './jobs.js';
import {
  OpenAiCompatibleAgentModel,
  type OpenAiCompatibleAgentModelConfig,
} from './openAiCompatibleModel.js';
import { AgentSettingError, getAgentSettings } from './settings.js';
import { runClaimedShadowJob } from './worker.js';

const GLOBAL_CONCURRENCY = 4;

export type AgentSchedulerModelConfig = OpenAiCompatibleAgentModelConfig;

export interface AgentProviderSettings {
  readonly aiEndpoint: string;
  readonly aiApiKey: string;
  readonly openrouterApiKey: string;
  readonly openrouterReferer: string;
  readonly openrouterTitle: string;
}

export interface AgentWorkerModels {
  readonly decisionModel: AgentModel;
  readonly reviewModel: AgentModel;
  readonly limits: AgentLimits;
}

export interface ScheduledShadowCompany {
  readonly companyId: string;
  readonly scheduleMinutes: number;
}

interface ScheduledCompanyDb {
  agentCompanyConfig: {
    findMany(args: {
      where: { mode: 'shadow'; company: { disconnectedAt: null } };
      select: { companyId: true; scheduleMinutes: true };
      orderBy: { companyId: 'asc' };
    }): Promise<ScheduledShadowCompany[]>;
  };
}

export interface AgentSchedulerDeps {
  readonly workerId: string;
  readonly globalConcurrency: number;
  readonly now: () => Date;
  readonly listShadowCompanies: () => Promise<readonly ScheduledShadowCompany[]>;
  readonly discoverJobs: (companyId: string) => Promise<unknown>;
  readonly claimJobs: (
    workerId: string,
    limit: number,
  ) => Promise<readonly ClaimedAgentJob[]>;
  readonly runJob: (job: ClaimedAgentJob) => Promise<void>;
}

export interface ScheduledShadowJobDeps {
  readonly getCompanySettings: (
    companyId: string,
  ) => Promise<AgentCompanySettingsDto>;
  readonly getProviderSettings: () => Promise<AgentProviderSettings>;
  readonly createModel: (config: AgentSchedulerModelConfig) => AgentModel;
  readonly runClaimedJob: (
    job: ClaimedAgentJob,
    workerId: string,
    models: AgentWorkerModels,
  ) => Promise<void>;
  readonly terminalize: (
    job: ClaimedAgentJob,
    workerId: string,
    errorCode: 'AGENT_MODEL_CONFIG_INVALID',
  ) => Promise<unknown>;
  readonly supersede: (
    job: ClaimedAgentJob,
    workerId: string,
  ) => Promise<boolean>;
}

export interface AgentScheduler {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

/**
 * Builds both adapters from the current company aliases and the decrypted
 * instance settings. Credentials are passed directly into the in-memory
 * adapters and are not copied into jobs, runs, or diagnostics.
 */
export function buildAgentModels(
  settings: AgentCompanySettingsDto,
  providerSettings: AgentProviderSettings,
  createModel: (config: AgentSchedulerModelConfig) => AgentModel =
    (config) => new OpenAiCompatibleAgentModel(config),
): AgentWorkerModels {
  if (settings.mode !== 'shadow') throw new Error('Agent model configuration is unavailable.');

  const forModel = (model: string): AgentSchedulerModelConfig => {
    if (settings.provider === 'openrouter') {
      if (providerSettings.openrouterApiKey === '') {
        throw new Error('Agent model configuration is unavailable.');
      }
      return {
        provider: 'openrouter',
        model,
        apiKey: providerSettings.openrouterApiKey,
        referer: providerSettings.openrouterReferer,
        title: providerSettings.openrouterTitle,
      };
    }
    if (settings.provider === 'custom' && providerSettings.aiEndpoint !== '') {
      return {
        provider: 'custom',
        model,
        baseUrl: providerSettings.aiEndpoint,
        apiKey: providerSettings.aiApiKey,
      };
    }
    throw new Error('Agent model configuration is unavailable.');
  };

  return {
    decisionModel: createModel(forModel(settings.decisionModel)),
    reviewModel: createModel(forModel(settings.verifierModel)),
    limits: { ...settings.limits },
  };
}

/**
 * Reloads mutable configuration after claim. If an enabled provider or model
 * can no longer be constructed, the owner/attempt-fenced terminal update
 * prevents the claim from silently waiting for lease expiry.
 */
export async function runScheduledShadowJob(
  job: ClaimedAgentJob,
  workerId: string,
  deps: ScheduledShadowJobDeps,
): Promise<void> {
  let settings: AgentCompanySettingsDto;
  try {
    settings = await deps.getCompanySettings(job.companyId);
  } catch (error) {
    if (!(error instanceof AgentSettingError)) throw error;
    await deps.terminalize(job, workerId, 'AGENT_MODEL_CONFIG_INVALID');
    return;
  }

  if (settings.mode !== 'shadow' || settings.configVersion !== job.configVersion) {
    if (!await deps.supersede(job, workerId)) {
      throw new Error('Agent job configuration changed during supersession.');
    }
    return;
  }

  const providerSettings = await deps.getProviderSettings();
  let models: AgentWorkerModels;
  try {
    models = buildAgentModels(settings, providerSettings, deps.createModel);
  } catch {
    await deps.terminalize(job, workerId, 'AGENT_MODEL_CONFIG_INVALID');
    return;
  }
  await deps.runClaimedJob(job, workerId, models);
}

export function createAgentScheduler(deps: AgentSchedulerDeps): AgentScheduler {
  let acceptingClaims = true;
  let lifecycleGeneration = 0;
  let running = false;

  return {
    start(): void {
      acceptingClaims = true;
    },
    stop(): void {
      acceptingClaims = false;
      lifecycleGeneration += 1;
    },
    async tick(): Promise<void> {
      if (!acceptingClaims || running) return;
      const tickGeneration = lifecycleGeneration;
      const isCurrentLifecycle = () => (
        acceptingClaims && lifecycleGeneration === tickGeneration
      );
      running = true;
      try {
        const now = checkedDate(deps.now());
        const companies = await deps.listShadowCompanies();
        if (!isCurrentLifecycle()) return;
        for (const company of companies) {
          if (isDue(now, company.scheduleMinutes)) {
            await deps.discoverJobs(company.companyId);
            if (!isCurrentLifecycle()) return;
          }
        }

        const jobs = await deps.claimJobs(deps.workerId, deps.globalConcurrency);
        if (!isCurrentLifecycle()) return;
        await Promise.allSettled(jobs.map((job) => deps.runJob(job)));
        if (!isCurrentLifecycle()) return;
      } finally {
        running = false;
      }
    },
  };
}

function isDue(now: Date, scheduleMinutes: number): boolean {
  if (!Number.isInteger(scheduleMinutes) || scheduleMinutes < 1) return false;
  const epochMinute = Math.floor(now.getTime() / 60_000);
  return epochMinute % scheduleMinutes === 0;
}

function checkedDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('Invalid agent scheduler clock.');
  }
  return value;
}

const processWorkerId = randomUUID();

const productionJobDeps: ScheduledShadowJobDeps = {
  getCompanySettings: getAgentSettings,
  getProviderSettings: getInstanceSettings,
  createModel: (config) => new OpenAiCompatibleAgentModel(config),
  runClaimedJob: async (job, workerId, models) => {
    await runClaimedShadowJob(job, {
      db: prisma,
      workerId,
      decisionModel: models.decisionModel,
      reviewModel: models.reviewModel,
      limits: models.limits,
    });
  },
  terminalize: async (job, workerId, errorCode) => {
    await finishAgentJob(job.id, workerId, job.attemptCount, {
      kind: 'failed',
      transient: false,
      errorCode,
    });
  },
  supersede: async (job, workerId) => cancelSupersededAgentJob(job, workerId),
};

export async function listScheduledShadowCompanies(
  db: ScheduledCompanyDb = prisma as unknown as ScheduledCompanyDb,
): Promise<ScheduledShadowCompany[]> {
  return db.agentCompanyConfig.findMany({
    where: {
      mode: 'shadow',
      company: { disconnectedAt: null },
    },
    select: { companyId: true, scheduleMinutes: true },
    orderBy: { companyId: 'asc' },
  });
}

const productionScheduler = createAgentScheduler({
  workerId: processWorkerId,
  globalConcurrency: GLOBAL_CONCURRENCY,
  now: () => new Date(),
  listShadowCompanies: listScheduledShadowCompanies,
  discoverJobs: discoverShadowJobs,
  claimJobs: claimShadowJobs,
  runJob: async (job) => runScheduledShadowJob(job, processWorkerId, productionJobDeps),
});

export function startAgentScheduler(): void {
  productionScheduler.start();
}

export function stopAgentScheduler(): void {
  productionScheduler.stop();
}

export async function runAgentTick(): Promise<void> {
  await productionScheduler.tick();
}
