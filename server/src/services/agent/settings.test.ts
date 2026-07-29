import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAgentSettings,
  updateShadowSettings,
  type AgentCompanyConfigRow,
  type AgentSettingsDeps,
} from './settings.js';

const configuredProvider = {
  suggestionProvider: 'openrouter' as const,
  agentDecisionModel: 'openai/gpt-4.1-mini',
  agentVerifierModel: 'openai/gpt-4.1-mini',
  aiEndpoint: '',
  aiApiKey: '',
  openrouterApiKey: 'instance-only-secret',
};

function createDeps(): AgentSettingsDeps & { rows: Map<string, AgentCompanyConfigRow> } {
  const rows = new Map<string, AgentCompanyConfigRow>();
  return {
    rows,
    db: {
      agentCompanyConfig: {
        findUnique: async ({ where }) => rows.get(where.companyId) ?? null,
        upsert: async ({ where, create, update }) => {
          const row = rows.get(where.companyId);
          const next = row ? { ...row, ...update } : create;
          rows.set(where.companyId, next);
          return next;
        },
      },
    },
    getInstanceSettings: async () => configuredProvider,
  };
}

describe('shadow agent company settings', () => {
  let deps: AgentSettingsDeps & { rows: Map<string, AgentCompanyConfigRow> };

  beforeEach(() => {
    deps = createDeps();
  });

  it.each([24, 1001])('rejects evidence threshold %i', async (evidenceThreshold) => {
    await expect(updateShadowSettings('company-1', { evidenceThreshold }, deps))
      .rejects.toMatchObject({ code: 'AGENT_SETTING_INVALID' });
  });

  it('defaults new company settings to off and threshold 50', async () => {
    await expect(getAgentSettings('company-1', deps)).resolves.toMatchObject({
      mode: 'off',
      provider: 'openrouter',
      evidenceThreshold: 50,
      companyConcurrency: 1,
      decisionModel: configuredProvider.agentDecisionModel,
      verifierModel: configuredProvider.agentVerifierModel,
    });
    expect(deps.rows).toHaveLength(0);
  });

  it('changes config version only when a validated setting changes', async () => {
    const initial = await getAgentSettings('company-1', deps);
    const unchanged = await updateShadowSettings('company-1', { mode: 'off' }, deps);
    const changed = await updateShadowSettings('company-1', { mode: 'shadow', evidenceThreshold: 51 }, deps);

    expect(unchanged.configVersion).toBe(initial.configVersion);
    expect(changed.configVersion).not.toBe(initial.configVersion);
    expect(deps.rows.get('company-1')).toMatchObject({ mode: 'shadow', evidenceThreshold: 51 });
  });

  it('uses one instance settings snapshot for first-time defaults and provider availability', async () => {
    const first = {
      ...configuredProvider,
      agentDecisionModel: 'first-decision-model',
      agentVerifierModel: 'first-verifier-model',
    };
    const second = {
      ...configuredProvider,
      suggestionProvider: 'custom' as const,
      agentDecisionModel: 'second-decision-model',
      agentVerifierModel: 'second-verifier-model',
      aiEndpoint: '',
    };
    let reads = 0;
    const sequential: AgentSettingsDeps = {
      ...deps,
      getInstanceSettings: async () => {
        reads += 1;
        return reads === 1 ? first : second;
      },
    };

    await expect(updateShadowSettings('company-1', { mode: 'shadow' }, sequential))
      .resolves.toMatchObject({
        provider: 'openrouter',
        decisionModel: 'first-decision-model',
        verifierModel: 'first-verifier-model',
      });
    expect(reads).toBe(1);
  });

  it('keeps provider secrets in instance settings and rejects unavailable provider configuration', async () => {
    const unavailable: AgentSettingsDeps = {
      ...deps,
      getInstanceSettings: async () => ({
        ...configuredProvider,
        openrouterApiKey: '',
      }),
    };

    await expect(updateShadowSettings('company-1', { mode: 'shadow' }, unavailable))
      .rejects.toMatchObject({ code: 'AGENT_SETTING_INVALID' });
    expect(deps.rows.get('company-1')).toBeUndefined();
  });

  it('isolates stored settings by company', async () => {
    await updateShadowSettings('company-1', { scheduleMinutes: 60 }, deps);
    await updateShadowSettings('company-2', { evidenceThreshold: 75 }, deps);

    await expect(getAgentSettings('company-1', deps)).resolves.toMatchObject({
      scheduleMinutes: 60,
      evidenceThreshold: 50,
    });
    await expect(getAgentSettings('company-2', deps)).resolves.toMatchObject({
      scheduleMinutes: 10,
      evidenceThreshold: 75,
    });
  });

  it('rejects limits that exceed the shadow runner safety caps', async () => {
    await expect(updateShadowSettings('company-1', {
      limits: { maxTurns: 9 },
    }, deps)).rejects.toMatchObject({ code: 'AGENT_SETTING_INVALID' });
  });
});
