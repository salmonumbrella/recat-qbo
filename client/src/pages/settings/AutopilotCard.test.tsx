import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AutopilotOverviewDto,
  AutopilotRunListDto,
} from '../../lib/api';

const mocks = vi.hoisted(() => ({
  cancelQueued: vi.fn(),
  get: vi.fn(),
  listRuns: vi.fn(),
  patch: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  autopilot: {
    cancelQueued: mocks.cancelQueued,
    get: mocks.get,
    listRuns: mocks.listRuns,
    patch: mocks.patch,
  },
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({ toast: mocks.toast }),
}));

import AutopilotCard, { AutopilotQueueStatus } from './AutopilotCard';

const CONFIG_VERSION = 'a'.repeat(64);
const SECOND_CONFIG_VERSION = 'b'.repeat(64);

const overview: AutopilotOverviewDto = {
  settings: {
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
  },
  queue: {
    queued: 3,
    running: 1,
    retrying: 1,
    terminal: 0,
    cancelled: 2,
    earliestDueAt: '2026-07-29T09:00:00.000Z',
    earliestLeaseExpiryAt: '2026-07-29T10:01:00.000Z',
  },
  evidence: {
    eligibleRuns: 12,
    agreements: 10,
    disagreements: 2,
    threshold: 50,
    thresholdMet: false,
  },
};

const secondOverview: AutopilotOverviewDto = {
  ...overview,
  settings: {
    ...overview.settings,
    decisionModel: 'company-2-decision',
    verifierModel: 'company-2-verifier',
    configVersion: SECOND_CONFIG_VERSION,
  },
  queue: {
    ...overview.queue,
    queued: 9,
    running: 0,
    retrying: 0,
    cancelled: 7,
  },
  evidence: {
    ...overview.evidence,
    eligibleRuns: 4,
    agreements: 4,
    disagreements: 0,
  },
};

const runs: AutopilotRunListDto = {
  runs: [
    {
      id: 'run-1',
      status: 'verified',
      attemptCount: 1,
      configVersion: CONFIG_VERSION,
      proposal: {
        kind: 'proposal',
        taxCalculation: 'TaxInclusive',
        confidence: 0.9,
        lineCount: 1,
        evidenceKinds: ['rule'],
      },
      verification: {
        diagnosticCode: 'AGENT_RUN_VERIFIED',
        verifierKind: 'same_model',
        evidence: null,
      },
      models: {
        decision: 'decision-model',
        verifier: 'decision-model',
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
    },
  ],
  nextCursor: 'opaque-next-cursor',
};

const olderRuns: AutopilotRunListDto = {
  runs: [{
    ...runs.runs[0]!,
    id: 'run-older',
    status: 'failed',
    proposal: { kind: 'abstain', reasonCode: 'PROVIDER_FAILURE' },
    verification: {
      diagnosticCode: 'AGENT_RUN_ABANDONED',
      verifierKind: 'unavailable',
      evidence: null,
    },
    timing: {
      durationMs: null,
      createdAt: '2026-07-29T09:00:00.000Z',
      completedAt: '2026-07-29T09:01:00.000Z',
    },
  }],
  nextCursor: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(overview);
  mocks.listRuns.mockResolvedValue(runs);
  mocks.patch.mockResolvedValue(overview.settings);
  mocks.cancelQueued.mockResolvedValue({ cancelled: 4 });
});

describe('AutopilotCard', () => {
  it('shows health, progress, verifier kinds, and no shadow mutation action', async () => {
    render(<AutopilotCard companyId="company-1" role="categorizer" />);

    expect(await screen.findByText('Same-model critique')).toBeInTheDocument();
    expect(screen.getByText('Shadow autopilot')).toBeInTheDocument();
    expect(screen.getByText('Deterministic checks')).toBeInTheDocument();
    expect(screen.getByText('Distinct-model review')).toBeInTheDocument();
    expect(screen.getByText(/same-model results never count toward the evidence threshold/i))
      .toBeInTheDocument();
    expect(screen.getByText(/12 of 50 qualified outcomes/i)).toBeInTheDocument();
    expect(screen.getByText('2 cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply|approve|post|stage|write/i }))
      .not.toBeInTheDocument();
  });

  it('lets an admin save bounded settings and explicitly cancel only queued work', async () => {
    render(<AutopilotCard companyId="company-1" role="admin" />);
    const user = userEvent.setup();

    await screen.findByLabelText('Evidence threshold');
    await user.clear(screen.getByLabelText('Evidence threshold'));
    await user.type(screen.getByLabelText('Evidence threshold'), '75');
    await user.click(screen.getByRole('button', { name: 'Save shadow settings' }));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith(
      'company-1',
      expect.objectContaining({ evidenceThreshold: 75 }),
    ));

    expect(screen.getByText(/running leases are not interrupted and run history is kept/i))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel queued and retrying work' }));
    await waitFor(() => expect(mocks.cancelQueued).toHaveBeenCalledWith('company-1'));
  });

  it('keeps settings and cancellation read-only for categorizers', async () => {
    render(<AutopilotCard companyId="company-1" role="categorizer" />);

    await screen.findByText('Shadow autopilot');
    expect(screen.queryByRole('button', { name: 'Save shadow settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel queued and retrying work' }))
      .not.toBeInTheDocument();
  });

  it('ignores stale save and cancellation responses after the company changes', async () => {
    const pendingSave = deferred<typeof overview.settings>();
    const pendingCancel = deferred<{ cancelled: number }>();
    mocks.get.mockImplementation(async (companyId: string) =>
      companyId === 'company-1' ? overview : secondOverview);
    mocks.listRuns.mockResolvedValue({ runs: [], nextCursor: null });
    mocks.patch.mockReturnValueOnce(pendingSave.promise);
    mocks.cancelQueued.mockReturnValueOnce(pendingCancel.promise);
    const view = render(<AutopilotCard companyId="company-1" role="admin" />);
    const user = userEvent.setup();

    await screen.findByDisplayValue('decision-model');
    await user.click(screen.getByRole('button', { name: 'Save shadow settings' }));
    await user.click(screen.getByRole('button', { name: 'Cancel queued and retrying work' }));
    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledWith('company-1', expect.any(Object));
      expect(mocks.cancelQueued).toHaveBeenCalledWith('company-1');
    });

    view.rerender(<AutopilotCard companyId="company-2" role="admin" />);
    expect(await screen.findByDisplayValue('company-2-decision')).toBeInTheDocument();
    expect(screen.getByText('9 queued')).toBeInTheDocument();
    expect(screen.getByText('7 cancelled')).toBeInTheDocument();

    await act(async () => {
      pendingSave.resolve({
        ...overview.settings,
        decisionModel: 'stale-old-decision',
      });
      pendingCancel.resolve({ cancelled: 4 });
    });

    expect(screen.getByDisplayValue('company-2-decision')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('stale-old-decision')).not.toBeInTheDocument();
    expect(screen.getByText('9 queued')).toBeInTheDocument();
    expect(screen.getByText('7 cancelled')).toBeInTheDocument();
  });
});

describe('AutopilotQueueStatus', () => {
  it('surfaces health and recent safe run inspection on the categorization queue', async () => {
    render(<AutopilotQueueStatus companyId="company-1" />);

    expect(await screen.findByText(/1 line proposal/i)).toBeInTheDocument();
    expect(screen.getByText(/3 queued · 1 running · 1 retrying/i)).toBeInTheDocument();
    expect(screen.getByText(/12 of 50 qualified outcomes/i)).toBeInTheDocument();
    expect(screen.getByText(/attempt 1/i)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`config ${CONFIG_VERSION}`))).toBeInTheDocument();
    expect(screen.getByText(/TaxInclusive · evidence rule/i)).toBeInTheDocument();
    expect(screen.getByText(/AGENT_RUN_VERIFIED/i)).toBeInTheDocument();
    expect(screen.getByText(/started 2026-07-29T10:00:00.000Z/i)).toBeInTheDocument();
    expect(screen.getByText(/completed 2026-07-29T10:00:00.250Z/i)).toBeInTheDocument();
    expect(screen.getByText(/input 100 · output 20 · total 120 tokens/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply|approve|post|stage|write/i }))
      .not.toBeInTheDocument();
  });

  it('loads older run summaries through the opaque cursor without adding mutation controls', async () => {
    mocks.listRuns
      .mockResolvedValueOnce(runs)
      .mockResolvedValueOnce(olderRuns);
    render(<AutopilotQueueStatus companyId="company-1" />);
    const user = userEvent.setup();

    await screen.findByText(/1 line proposal/i);
    await user.click(screen.getByRole('button', { name: 'Load older runs' }));

    await waitFor(() => expect(mocks.listRuns).toHaveBeenLastCalledWith(
      'company-1',
      { limit: 5, cursor: 'opaque-next-cursor' },
    ));
    expect(await screen.findByText(/Abstained · provider failure/i)).toBeInTheDocument();
    expect(screen.getByText(/Verification unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply|approve|post|stage|write/i }))
      .not.toBeInTheDocument();
  });

  it('keeps older-run pagination retryable after a transient read failure', async () => {
    mocks.listRuns
      .mockResolvedValueOnce(runs)
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce(olderRuns);
    render(<AutopilotQueueStatus companyId="company-1" />);
    const user = userEvent.setup();

    await screen.findByText(/1 line proposal/i);
    await user.click(screen.getByRole('button', { name: 'Load older runs' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load older runs' }))
      .toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Load older runs' }));

    expect(await screen.findByText(/Abstained · provider failure/i)).toBeInTheDocument();
    expect(mocks.listRuns).toHaveBeenCalledTimes(3);
  });

  it('keeps queue health visible when the supplementary initial history read fails', async () => {
    mocks.listRuns.mockRejectedValueOnce(new Error('temporary read failure'));

    render(<AutopilotQueueStatus companyId="company-1" />);

    expect(await screen.findByText(/3 queued · 1 running · 1 retrying/i)).toBeInTheDocument();
    expect(screen.getByText(/12 of 50 qualified outcomes/i)).toBeInTheDocument();
    expect(screen.getByText('No shadow runs yet.')).toBeInTheDocument();
  });

  it('ignores slow older-run pagination after the company changes', async () => {
    const pendingOlderRuns = deferred<AutopilotRunListDto>();
    mocks.get.mockImplementation(async (companyId: string) =>
      companyId === 'company-1' ? overview : secondOverview);
    mocks.listRuns.mockImplementation(async (
      companyId: string,
      params: { cursor?: string },
    ) => {
      if (companyId === 'company-1' && params.cursor !== undefined) {
        return pendingOlderRuns.promise;
      }
      return companyId === 'company-1'
        ? runs
        : { runs: [], nextCursor: null };
    });
    const view = render(<AutopilotQueueStatus companyId="company-1" />);
    const user = userEvent.setup();

    await screen.findByText(/1 line proposal/i);
    await user.click(screen.getByRole('button', { name: 'Load older runs' }));
    await waitFor(() => expect(mocks.listRuns).toHaveBeenCalledWith(
      'company-1',
      { limit: 5, cursor: 'opaque-next-cursor' },
    ));

    view.rerender(<AutopilotQueueStatus companyId="company-2" />);
    expect(await screen.findByText(/9 queued · 0 running · 0 retrying/i)).toBeInTheDocument();
    expect(screen.getByText('No shadow runs yet.')).toBeInTheDocument();

    await act(async () => pendingOlderRuns.resolve(olderRuns));

    expect(screen.queryByText(/Abstained · provider failure/i)).not.toBeInTheDocument();
    expect(screen.getByText('No shadow runs yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older runs' })).not.toBeInTheDocument();
  });
});
