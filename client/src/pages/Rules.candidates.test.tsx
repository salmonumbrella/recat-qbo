import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleCandidateDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  listRules: vi.fn(),
  listCandidates: vi.fn(),
  activate: vi.fn(),
  dismiss: vi.fn(),
  toast: vi.fn(),
  activeCompanyId: 'COMPANY_GENERIC',
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: mocks.activeCompanyId,
    accounts: [{
      qboId: 'ACCOUNT_GENERIC',
      name: 'Office expense',
      classification: 'Expenses',
    }],
    tags: [{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Reviewed',
      color: '#64748b',
    }],
    taxReadiness: {
      status: 'ready',
      reason: null,
      usingSalesTax: true,
      refreshedAt: '2026-07-30T00:00:00.000Z',
      taxCodes: [],
    },
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  rules: {
    list: mocks.listRules,
    create: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    reorder: vi.fn(),
    test: vi.fn(),
  },
  ruleCandidates: {
    list: mocks.listCandidates,
    activate: mocks.activate,
    dismiss: mocks.dismiss,
  },
}));

import Rules from './Rules';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeCompanyId = 'COMPANY_GENERIC';
});

function candidate(overrides: Partial<RuleCandidateDto> = {}): RuleCandidateDto {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    companyId: 'COMPANY_GENERIC',
    state: 'ready',
    matchField: 'payee',
    matchText: 'northwind market',
    category: 'Office expense',
    categoryQboId: 'ACCOUNT_GENERIC',
    taxCalculation: 'NotApplicable',
    taxCode: null,
    taxCodeQboId: null,
    tagIds: ['11111111-1111-4111-8111-111111111111'],
    evidenceCount: 3,
    conflictingEvidenceCount: 0,
    evidenceThreshold: 3,
    schemaVersion: 'rule-candidate-v1',
    configVersion: 'config-neutral',
    staleReasons: [],
    canActivate: true,
    activatedRuleId: null,
    provenance: {
      user: 2,
      autopilot: 1,
      mcp: 0,
    },
    evidence: [
      {
        transactionId: '33333333-3333-4333-8333-333333333333',
        source: 'user',
        observedAt: '2026-07-30T00:00:00.000Z',
      },
      {
        transactionId: '44444444-4444-4444-8444-444444444444',
        source: 'autopilot',
        observedAt: '2026-07-29T00:00:00.000Z',
      },
      {
        transactionId: '55555555-5555-4555-8555-555555555555',
        source: 'user',
        observedAt: '2026-07-28T00:00:00.000Z',
      },
    ],
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('Rules candidate review', () => {
  it('explains verified provenance and activates an inert candidate explicitly', async () => {
    const ready = candidate();
    mocks.listRules.mockResolvedValue([]);
    mocks.listCandidates.mockResolvedValue({
      candidates: [ready],
      nextCursor: null,
    });
    mocks.activate.mockResolvedValue({
      ...ready,
      state: 'activated',
      canActivate: false,
      activatedRuleId: '66666666-6666-4666-8666-666666666666',
    });

    render(<Rules />);

    expect(await screen.findByText('Learned rule candidates')).toBeInTheDocument();
    expect(screen.getByText('northwind market')).toBeInTheDocument();
    expect(screen.getByText(/3 verified outcomes/i)).toBeInTheDocument();
    expect(screen.getByText(/2 reviewed by a person · 1 by autopilot/i)).toBeInTheDocument();
    expect(screen.getByText(/never posts automatically/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Activate rule' }));

    await waitFor(() => {
      expect(mocks.activate).toHaveBeenCalledWith(
        'COMPANY_GENERIC',
        ready.id,
      );
    });
    expect(screen.queryByText('northwind market')).not.toBeInTheDocument();
    expect(mocks.listRules).toHaveBeenCalledTimes(2);
  });

  it('shows conflicts and stale references without an activation control', async () => {
    mocks.listRules.mockResolvedValue([]);
    mocks.listCandidates.mockResolvedValue({
      candidates: [candidate({
        state: 'conflict',
        canActivate: false,
        conflictingEvidenceCount: 1,
        staleReasons: ['The category reference is no longer active.'],
      })],
      nextCursor: null,
    });

    render(<Rules />);

    expect(await screen.findByText(/1 conflicting outcome/i)).toBeInTheDocument();
    expect(screen.getByText(/category reference is no longer active/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate rule' })).not.toBeInTheDocument();
  });

  it('loads every bounded page for review on demand', async () => {
    const first = candidate();
    const second = candidate({
      id: '77777777-7777-4777-8777-777777777777',
      matchText: 'contoso services',
    });
    mocks.listRules.mockResolvedValue([]);
    mocks.listCandidates.mockImplementation(async (
      _companyId: string,
      cursor?: string,
    ) => cursor
      ? { candidates: [second], nextCursor: null }
      : { candidates: [first], nextCursor: first.id });

    render(<Rules />);

    expect(await screen.findByText('northwind market')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more candidates' }));

    expect(await screen.findByText('contoso services')).toBeInTheDocument();
    expect(mocks.listCandidates).toHaveBeenLastCalledWith(
      'COMPANY_GENERIC',
      first.id,
    );
    expect(screen.queryByRole('button', { name: 'Load more candidates' })).not.toBeInTheDocument();
  });

  it('keeps the next page reachable after acting on the final visible candidate', async () => {
    const ready = candidate();
    mocks.listRules.mockResolvedValue([]);
    mocks.listCandidates.mockResolvedValue({
      candidates: [ready],
      nextCursor: ready.id,
    });
    mocks.activate.mockResolvedValue({
      ...ready,
      state: 'activated',
      canActivate: false,
      activatedRuleId: '66666666-6666-4666-8666-666666666666',
    });

    render(<Rules />);
    expect(await screen.findByText('northwind market')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Activate rule' }));

    expect(await screen.findByRole('button', {
      name: 'Load more candidates',
    })).toBeInTheDocument();
  });

  it('ignores a completed candidate action after the active company changes', async () => {
    const ready = candidate();
    let resolveActivation!: (value: RuleCandidateDto) => void;
    mocks.listRules.mockResolvedValue([]);
    mocks.listCandidates.mockImplementation(async (companyId: string) => ({
      candidates: companyId === 'COMPANY_GENERIC' ? [ready] : [],
      nextCursor: null,
    }));
    mocks.activate.mockReturnValue(new Promise<RuleCandidateDto>((resolve) => {
      resolveActivation = resolve;
    }));

    const view = render(<Rules />);
    expect(await screen.findByText('northwind market')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Activate rule' }));
    await waitFor(() => {
      expect(mocks.activate).toHaveBeenCalledWith('COMPANY_GENERIC', ready.id);
    });

    mocks.activeCompanyId = 'COMPANY_OTHER';
    view.rerender(<Rules />);
    await waitFor(() => {
      expect(mocks.listCandidates).toHaveBeenCalledWith('COMPANY_OTHER');
    });

    await act(async () => {
      resolveActivation({
        ...ready,
        state: 'activated',
        canActivate: false,
        activatedRuleId: '66666666-6666-4666-8666-666666666666',
      });
    });

    expect(
      mocks.listRules.mock.calls.filter(([companyId]) => companyId === 'COMPANY_GENERIC'),
    ).toHaveLength(1);
    expect(mocks.toast).not.toHaveBeenCalledWith('Rule activated — auto-post remains off');
  });
});
