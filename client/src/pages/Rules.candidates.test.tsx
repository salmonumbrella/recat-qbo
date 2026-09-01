import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleCandidateDto, RuleDetailDto, RuleMutationResult } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  lifecycleRules: vi.fn(),
  detail: vi.fn(),
  revisions: vi.fn(),
  testRule: vi.fn(),
  listCandidates: vi.fn(),
  getCandidate: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  intentId: vi.fn(),
  search: vi.fn(),
  health: vi.fn(),
  toast: vi.fn(),
  activeCompanyId: 'COMPANY_GENERIC',
  activeCompany: { id: 'COMPANY_GENERIC', holdingAccountIds: ['DESIGNATED_HOLDING'] } as never,
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: mocks.activeCompanyId,
    activeCompany: mocks.activeCompany,
    accounts: [
      {
        qboId: 'ACCOUNT_GENERIC',
        name: 'Office expense',
        classification: 'Expenses',
      },
      {
        qboId: 'LOCALIZED_HOLDING',
        name: 'Uncategorised Expense',
        classification: 'Expenses',
      },
      {
        qboId: 'DESIGNATED_HOLDING',
        name: 'Uncategorized Expenses Pending Review',
        classification: 'Expenses',
      },
    ],
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
  createCategorizationRequestId: mocks.intentId,
  classificationMemory: {
    search: mocks.search,
    health: mocks.health,
  },
  ruleOperations: {
    prepare: mocks.prepare,
    commit: mocks.commit,
  },
  rules: {
    lifecycle: mocks.lifecycleRules,
    detail: mocks.detail,
    revisions: mocks.revisions,
    test: mocks.testRule,
  },
  ruleCandidates: {
    list: mocks.listCandidates,
    get: mocks.getCandidate,
  },
}));

import Rules from './Rules';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeCompanyId = 'COMPANY_GENERIC';
  mocks.activeCompany = { id: 'COMPANY_GENERIC', holdingAccountIds: ['DESIGNATED_HOLDING'] } as never;
  mocks.lifecycleRules.mockResolvedValue({ items: [], nextCursor: null });
  mocks.detail.mockResolvedValue(ruleDetail());
  mocks.listCandidates.mockResolvedValue({ candidates: [], nextCursor: null });
  mocks.getCandidate.mockResolvedValue(candidate());
  mocks.revisions.mockResolvedValue({ items: [], nextCursor: null });
  mocks.search.mockResolvedValue({
    query: 'supplier', companyId: 'COMPANY_GENERIC', scope: 'current_company',
    mode: 'hybrid', requestedMode: 'hybrid', degraded: false, degradedReason: null,
    status: 'no_match', noMatch: true, total: 0, items: [], nextCursor: null,
  });
  mocks.health.mockResolvedValue({ configured: false, vectorAvailable: false, backlog: 0, progress: 0 });
  mocks.intentId.mockReturnValue('99999999-9999-4999-8999-999999999999');
  window.history.replaceState({}, '', '/rules');
});

function ruleDetail(overrides: Partial<RuleDetailDto> = {}): RuleDetailDto {
  return {
    active: true,
    executable: true,
    reviewRequiredAt: null,
    reviewReason: null,
    revision: {
      id: 'revision-3', ruleId: 'rule-1', companyId: 'COMPANY_GENERIC', revision: 3,
      state: 'enabled', condition: { matchField: 'payee', matchText: 'Generic supplier' },
      action: {
        categoryQboId: 'ACCOUNT_GENERIC', taxCalculation: 'NotApplicable',
        taxCodeQboId: null, tagIds: [],
      },
      categoryName: 'Office expense', taxCodeName: null, priority: 0, autoPost: false,
      originIntent: null, sourceCaseId: null, sourceCandidateId: null, changedBy: 'user-1',
      createdAt: '2026-08-30T00:00:00.000Z', retiredAt: null,
      valid: true, invalidReasons: [],
    },
    ...overrides,
  };
}

function prepared(
  mutation: RuleMutationResult['mutation'],
  overrides: Partial<NonNullable<RuleMutationResult['preview']>> = {},
): RuleMutationResult {
  return {
    ok: true, operationId: `operation-${mutation}`, companyId: 'COMPANY_GENERIC', mutation,
    originIntent: mutation === 'activate_candidate' || mutation === 'dismiss_candidate'
      ? 'auto_candidate' : null,
    status: 'PREPARED', ruleId: mutation.includes('candidate') ? null : 'rule-1',
    revision: null, rule: null, candidate: null, error: null,
    preview: {
      operationId: `operation-${mutation}`, companyId: 'COMPANY_GENERIC',
      ruleId: mutation.includes('candidate') ? null : 'rule-1',
      candidateId: mutation.includes('candidate') ? candidate().id : null,
      mutation, originIntent: mutation.includes('candidate') ? 'auto_candidate' : null,
      currentRevision: mutation.includes('candidate') ? 0 : 3,
      proposedRevision: mutation.includes('candidate') ? 1 : 4,
      condition: { matchField: 'payee', matchText: 'Generic supplier' },
      action: ruleDetail().revision.action, categoryName: 'Office expense', taxCodeName: null,
      priority: 0, autoPost: false, affectedPendingCount: 2, affectedPostedCount: 1,
      sampleTransactions: [], conflicts: [], warnings: [],
      expiresAt: '2026-08-31T01:00:00.000Z', preparationDigest: 'digest',
      ...overrides,
    },
  };
}

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
  // The name test only knows QuickBooks' built-ins. An account the operator
  // designated as a holding account under their own name must still never be a
  // rule destination — an auto-post rule would file transactions straight back
  // into the account Recat is watching.
  it('excludes a designated holding account whatever the operator named it', async () => {
    mocks.lifecycleRules.mockResolvedValue({ items: [ruleDetail()], nextCursor: null });

    render(<Rules />);

    await waitFor(() => expect(mocks.lifecycleRules).toHaveBeenCalled());
    expect(screen.queryAllByRole('option', {
      name: /Uncategorized Expenses Pending Review/,
    })).toHaveLength(0);
    // The ordinary account is still offered, so this is exclusion and not an
    // empty list.
    expect(screen.getAllByRole('option', {
      name: 'Expenses · Office expense',
    })).not.toHaveLength(0);
  });

  it('excludes localized Uncategorised holding accounts from category destinations', async () => {
    mocks.lifecycleRules.mockResolvedValue({ items: [ruleDetail()], nextCursor: null });

    render(<Rules />);

    await waitFor(() => expect(mocks.lifecycleRules).toHaveBeenCalled());
    expect(screen.queryAllByRole('option', {
      name: /Uncategorised Expense/,
    })).toHaveLength(0);
    expect(screen.getAllByRole('option', {
      name: 'Expenses · Office expense',
    })).not.toHaveLength(0);
  });

  it('explains verified provenance and activates an inert candidate explicitly', async () => {
    const ready = candidate();
    mocks.listCandidates
      .mockResolvedValueOnce({ candidates: [ready], nextCursor: null })
      .mockResolvedValue({ candidates: [], nextCursor: null });
    mocks.prepare.mockResolvedValue(prepared('activate_candidate'));
    mocks.commit.mockResolvedValue({
      ...prepared('activate_candidate'), status: 'COMMITTED', preview: null,
      candidate: { candidateId: ready.id, state: 'activated', ruleId: 'rule-created' },
    });

    render(<Rules />);

    expect(await screen.findByText('Learned rule candidates')).toBeInTheDocument();
    expect(screen.getByText('northwind market')).toBeInTheDocument();
    expect(screen.getByText(/3 verified outcomes/i)).toBeInTheDocument();
    expect(screen.getByText(/2 reviewed by a person · 1 by autopilot/i)).toBeInTheDocument();
    expect(screen.getByText(/never posts automatically/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Activate rule' }));

    await waitFor(() => {
      expect(mocks.prepare).toHaveBeenCalledWith('COMPANY_GENERIC', {
        mutation: 'activate_candidate', candidateId: ready.id, expectedRevision: 0,
        idempotencyKey: '99999999-9999-4999-8999-999999999999',
      });
    });
    expect(screen.getByText(/2 pending.*1 posted/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm activate candidate' }));
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledWith(
      'COMPANY_GENERIC', 'operation-activate_candidate',
      '99999999-9999-4999-8999-999999999999',
    ));
    expect(screen.queryByText('northwind market')).not.toBeInTheDocument();
    expect(mocks.lifecycleRules).toHaveBeenCalledTimes(4);
  });

  it('shows conflicts and stale references without an activation control', async () => {
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

  it('rediscovers disabled and retired rules and shows bounded revision history', async () => {
    const enabled = ruleDetail();
    const disabled = ruleDetail({
      active: false,
      executable: false,
      revision: { ...ruleDetail().revision, id: 'revision-disabled', ruleId: 'rule-disabled', revision: 5, state: 'disabled', condition: { matchField: 'payee', matchText: 'Disabled supplier' } },
    });
    const retired = ruleDetail({
      active: false,
      executable: false,
      revision: { ...ruleDetail().revision, id: 'revision-retired', ruleId: 'rule-retired', revision: 7, state: 'retired', retiredAt: '2026-08-30T00:00:00.000Z', condition: { matchField: 'payee', matchText: 'Retired supplier' } },
    });
    mocks.lifecycleRules.mockResolvedValue({ items: [enabled, disabled, retired], nextCursor: null });
    mocks.revisions.mockResolvedValue({
      items: [disabled.revision, { ...disabled.revision, id: 'revision-disabled-4', revision: 4, state: 'enabled' }],
      nextCursor: null,
    });
    const user = userEvent.setup();

    render(<Rules />);

    expect(await screen.findByText('Disabled supplier')).toBeInTheDocument();
    expect(screen.getByText('Retired supplier')).toBeInTheDocument();
    expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Retired').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Enable Disabled supplier' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable Retired supplier' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'View history for Disabled supplier' }));
    await waitFor(() => expect(mocks.revisions).toHaveBeenCalledWith(
      'COMPANY_GENERIC', 'rule-disabled', undefined, 100,
    ));
    expect(screen.getByText(/revision 5.*disabled/i)).toBeInTheDocument();
    expect(screen.getByText(/revision 4.*enabled/i)).toBeInTheDocument();
  });

  it('rehydrates a linked source rule even when it is beyond the current lifecycle page', async () => {
    const source = ruleDetail({
      revision: {
        ...ruleDetail().revision,
        id: 'revision-source',
        ruleId: 'rule-source',
        condition: { matchField: 'payee', matchText: 'Linked source supplier' },
      },
    });
    mocks.detail.mockResolvedValue(source);
    window.history.replaceState({}, '', '/rules?source=rule&sourceId=rule-source');

    render(<Rules />);

    await waitFor(() => expect(mocks.detail).toHaveBeenCalledWith('COMPANY_GENERIC', 'rule-source'));
    expect(screen.getByText('Linked source supplier')).toBeInTheDocument();
  });

  it('clears a deep-linked rule after retirement so stale actions cannot reappear', async () => {
    const source = ruleDetail({
      revision: {
        ...ruleDetail().revision,
        ruleId: 'rule-source',
        condition: { matchField: 'payee', matchText: 'Linked source supplier' },
      },
    });
    mocks.detail.mockResolvedValue(source);
    mocks.lifecycleRules.mockResolvedValue({ items: [], nextCursor: null });
    mocks.prepare.mockResolvedValue(prepared('retire'));
    mocks.commit.mockResolvedValue({ ...prepared('retire'), status: 'COMMITTED', preview: null });
    window.history.replaceState({}, '', '/rules?source=rule&sourceId=rule-source');
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'Retire Linked source supplier' }));
    await user.click(screen.getByRole('button', { name: 'Confirm retire rule' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retire Linked source supplier' })).not.toBeInTheDocument());
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    expect(mocks.listCandidates).toHaveBeenCalledTimes(2);
  });

  it('clears a deep-linked candidate after activation so stale actions cannot reappear', async () => {
    const source = candidate();
    mocks.getCandidate.mockResolvedValue(source);
    mocks.listCandidates.mockResolvedValue({ candidates: [], nextCursor: null });
    mocks.prepare.mockResolvedValue(prepared('activate_candidate'));
    mocks.commit.mockResolvedValue({
      ...prepared('activate_candidate'), status: 'COMMITTED', preview: null,
      candidate: { candidateId: source.id, state: 'activated', ruleId: 'created-rule' },
    });
    window.history.replaceState({}, '', `/rules?source=rule_candidate&sourceId=${source.id}`);
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'Activate rule' }));
    await user.click(screen.getByRole('button', { name: 'Confirm activate candidate' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Activate rule' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    expect(mocks.getCandidate).toHaveBeenCalledTimes(1);
    expect(mocks.listCandidates).toHaveBeenCalledTimes(2);
  });

  it('prepares and commits disablement using the server preview', async () => {
    mocks.lifecycleRules.mockResolvedValue({ items: [ruleDetail()], nextCursor: null });
    mocks.prepare.mockResolvedValue(prepared('disable'));
    mocks.commit.mockResolvedValue({ ...prepared('disable'), status: 'COMMITTED', preview: null });
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'Disable Generic supplier' }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('COMPANY_GENERIC', {
      mutation: 'disable', ruleId: 'rule-1', expectedRevision: 3,
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
    }));
    expect(screen.getByText(/2 pending.*1 posted/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm disable rule' }));
    expect(mocks.commit).toHaveBeenCalledWith(
      'COMPANY_GENERIC', 'operation-disable', '99999999-9999-4999-8999-999999999999',
    );
  });

  it('blocks duplicate preparation and retries a transport failure with one intent key', async () => {
    let rejectPrepare!: (error: Error) => void;
    mocks.lifecycleRules.mockResolvedValue({ items: [ruleDetail()], nextCursor: null });
    mocks.prepare.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectPrepare = reject; }));
    mocks.prepare.mockResolvedValueOnce(prepared('disable'));
    const user = userEvent.setup();
    render(<Rules />);

    const disable = await screen.findByRole('button', { name: 'Disable Generic supplier' });
    await user.dblClick(disable);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.intentId).toHaveBeenCalledTimes(1);
    rejectPrepare(new Error('Network interrupted'));

    await user.click(await screen.findByRole('button', { name: 'Retry preparation' }));
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(mocks.prepare.mock.calls[1]).toEqual(mocks.prepare.mock.calls[0]);
    expect(mocks.intentId).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Confirm disable rule' })).toBeInTheDocument();
  });

  it('prepares enablement and retirement instead of mutating lifecycle directly', async () => {
    const disabled = ruleDetail({
      active: false,
      executable: false,
      revision: { ...ruleDetail().revision, state: 'disabled' },
    });
    const enabled = ruleDetail({
      revision: {
        ...ruleDetail().revision,
        id: 'revision-enabled',
        ruleId: 'rule-enabled',
        condition: { matchField: 'payee', matchText: 'Enabled supplier' },
      },
    });
    mocks.lifecycleRules.mockResolvedValue({ items: [disabled, enabled], nextCursor: null });
    mocks.prepare.mockResolvedValueOnce(prepared('enable')).mockResolvedValueOnce(prepared('retire'));
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'Enable Generic supplier' }));
    expect(mocks.prepare).toHaveBeenLastCalledWith('COMPANY_GENERIC', {
      mutation: 'enable', ruleId: 'rule-1', expectedRevision: 3,
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
    });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Retire Enabled supplier' }));
    expect(mocks.prepare).toHaveBeenLastCalledWith('COMPANY_GENERIC', {
      mutation: 'retire', ruleId: 'rule-enabled', expectedRevision: 3,
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
    });
  });

  it('prepares a complete reordered enabled set without a forbidden rule selector', async () => {
    const first = ruleDetail();
    const second = ruleDetail({
      revision: {
        ...ruleDetail().revision,
        id: 'revision-8',
        ruleId: 'rule-2',
        revision: 8,
        priority: 1,
        condition: { matchField: 'payee', matchText: 'Second supplier' },
      },
    });
    mocks.lifecycleRules.mockResolvedValue({ items: [first, second], nextCursor: null });
    mocks.prepare.mockResolvedValue(prepared('reorder'));
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'Move Generic supplier down' }));
    expect(mocks.prepare).toHaveBeenCalledWith('COMPANY_GENERIC', {
      mutation: 'reorder',
      expectedRevision: 8,
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
      proposal: { orderIds: ['rule-2', 'rule-1'] },
    });
  });

  it('drains every enabled lifecycle page before allowing a complete reorder', async () => {
    const enabled = Array.from({ length: 101 }, (_, priority) => ruleDetail({
      revision: {
        ...ruleDetail().revision,
        id: `revision-${priority}`,
        ruleId: `rule-${priority}`,
        revision: priority + 1,
        priority,
        condition: { matchField: 'payee', matchText: `Supplier ${priority}` },
      },
    }));
    mocks.lifecycleRules.mockImplementation(async (
      _companyId: string,
      state: string,
      cursor?: string,
    ) => {
      if (state === 'all') return { items: enabled.slice(0, 2), nextCursor: null };
      return cursor
        ? { items: enabled.slice(100), nextCursor: null }
        : { items: enabled.slice(0, 100), nextCursor: 'enabled-page-2' };
    });
    mocks.prepare.mockResolvedValue(prepared('reorder'));
    const user = userEvent.setup();
    render(<Rules />);

    const move = await screen.findByRole('button', { name: 'Move Supplier 0 down' });
    await waitFor(() => expect(move).toBeEnabled());
    await user.click(move);

    expect(mocks.lifecycleRules).toHaveBeenCalledWith(
      'COMPANY_GENERIC', 'enabled', 'enabled-page-2', 100,
    );
    const preparedBody = mocks.prepare.mock.calls.at(-1)?.[1];
    expect(preparedBody).toMatchObject({ mutation: 'reorder', expectedRevision: 2 });
    expect(preparedBody.proposal.orderIds).toHaveLength(101);
    expect(preparedBody.proposal.orderIds.slice(0, 3)).toEqual(['rule-1', 'rule-0', 'rule-2']);
    expect(preparedBody.proposal.orderIds.at(-1)).toBe('rule-100');
  });

  it('fails ordering closed when the enabled snapshot belongs to the prior company', async () => {
    let resolveOldPage!: (value: { items: RuleDetailDto[]; nextCursor: null }) => void;
    mocks.lifecycleRules.mockImplementation((companyId: string, state: string, cursor?: string) => {
      if (state === 'all') return Promise.resolve({ items: companyId === 'COMPANY_GENERIC' ? [ruleDetail()] : [], nextCursor: null });
      if (companyId === 'COMPANY_GENERIC' && cursor) {
        return new Promise((resolve) => { resolveOldPage = resolve; });
      }
      if (companyId === 'COMPANY_GENERIC') {
        return Promise.resolve({ items: [ruleDetail()], nextCursor: 'old-page-2' });
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const view = render(<Rules />);
    expect(await screen.findByRole('button', { name: 'Move Generic supplier down' })).toBeDisabled();

    mocks.activeCompanyId = 'COMPANY_OTHER';
    view.rerender(<Rules />);
    await waitFor(() => expect(mocks.lifecycleRules).toHaveBeenCalledWith(
      'COMPANY_OTHER', 'enabled', undefined, 100,
    ));
    resolveOldPage({ items: [ruleDetail()], nextCursor: null });

    await waitFor(() => expect(screen.queryByText('Generic supplier')).not.toBeInTheDocument());
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('tests a lifecycle rule and shows bounded impact and conflicts', async () => {
    mocks.lifecycleRules.mockResolvedValue({ items: [ruleDetail()], nextCursor: null });
    mocks.testRule.mockResolvedValue({
      matches: [], pendingCount: 4, postedCount: 2,
      conflicts: [{ ruleId: 'other', matchText: 'supplier', category: 'Travel', priority: 2 }],
    });
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'Test rule' }));
    expect(mocks.testRule).toHaveBeenCalledWith('COMPANY_GENERIC', 'Generic supplier');
    expect(await screen.findByText(/4 pending.*2 posted.*1 conflicts/i)).toBeInTheDocument();
    expect(screen.getByText(/supplier.*Travel/i)).toBeInTheDocument();
  });

  it('keeps initial rule and candidate failures visible and retries them independently', async () => {
    mocks.lifecycleRules.mockRejectedValueOnce(new Error('Rule lifecycle unavailable'));
    mocks.listCandidates.mockRejectedValueOnce(new Error('Candidates unavailable'));
    const user = userEvent.setup();
    render(<Rules />);

    expect(await screen.findByRole('alert', { name: 'Rules unavailable' })).toHaveTextContent(/rule lifecycle unavailable/i);
    expect(screen.getByRole('alert', { name: 'Candidates unavailable' })).toHaveTextContent(/candidates unavailable/i);
    expect(screen.queryByText(/no rules in this lifecycle state/i)).not.toBeInTheDocument();

    mocks.lifecycleRules.mockResolvedValue({ items: [ruleDetail()], nextCursor: null });
    mocks.listCandidates.mockResolvedValue({ candidates: [candidate()], nextCursor: null });
    await user.click(screen.getByRole('button', { name: 'Retry rules' }));
    expect(await screen.findByText('Generic supplier')).toBeInTheDocument();
    expect(screen.getByRole('alert', { name: 'Candidates unavailable' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry candidates' }));
    expect(await screen.findByText('northwind market')).toBeInTheDocument();
  });

  it('renders complete revision action, provenance, validity, and change context', async () => {
    const current = ruleDetail();
    const previous = {
      ...current.revision,
      id: 'revision-2',
      revision: 2,
      state: 'disabled' as const,
      action: null,
      categoryName: 'Historical category',
      taxCodeName: 'Historical tax',
      priority: 4,
      autoPost: true,
      originIntent: 'make_recurring' as const,
      sourceCaseId: 'case-source',
      changedBy: 'reviewer@example.com',
      valid: false,
      invalidReasons: ['Historical category is inactive.'],
    };
    mocks.lifecycleRules.mockResolvedValue({ items: [current], nextCursor: null });
    mocks.revisions.mockResolvedValue({ items: [current.revision, previous], nextCursor: null });
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'View history for Generic supplier' }));
    const revision3 = screen.getByRole('article', { name: 'Revision 3' });
    expect(revision3).toHaveTextContent(/Office expense.*NotApplicable.*priority 0.*auto-post off/i);
    expect(revision3).toHaveTextContent(/changed.*disabled.*enabled.*priority 4.*0.*auto-post on.*off/i);
    const revision2 = screen.getByRole('article', { name: 'Revision 2' });
    expect(revision2).toHaveTextContent(/legacy action unavailable/i);
    expect(revision2).toHaveTextContent(/make recurring.*case-source.*reviewer@example.com/i);
    expect(revision2).toHaveTextContent(/historical category is inactive/i);
  });

  it('shows one bounded newest-history window and never drains hidden older revisions', async () => {
    const current = ruleDetail();
    const revisions = Array.from({ length: 100 }, (_, index) => ({
      ...current.revision,
      id: `history-${100 - index}`,
      revision: 100 - index,
    }));
    mocks.lifecycleRules.mockResolvedValue({ items: [current], nextCursor: null });
    mocks.revisions.mockResolvedValue({ items: revisions, nextCursor: 'older-history' });
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'View history for Generic supplier' }));

    expect(mocks.revisions).toHaveBeenCalledWith('COMPANY_GENERIC', 'rule-1', undefined, 100);
    expect(screen.getAllByRole('article', { name: /^Revision / })).toHaveLength(100);
    expect(screen.getByRole('status', { name: 'Revision history truncated' })).toHaveTextContent(
      /showing 100 newest revisions.*older history exists/i,
    );
    expect(screen.queryByRole('button', { name: 'Load more history' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Revision 1' })).toHaveTextContent(
      /older comparison unavailable.*history is truncated/i,
    );
    expect(mocks.revisions).toHaveBeenCalledTimes(1);
  });

  it('does not call a partial legacy history page initial when an older cursor exists', async () => {
    const current = ruleDetail();
    const legacy = {
      ...current.revision,
      id: 'legacy-partial',
      revision: 2,
      action: null,
      valid: false,
      invalidReasons: ['Legacy action cannot execute.'],
    };
    mocks.lifecycleRules.mockResolvedValue({ items: [current], nextCursor: null });
    mocks.revisions.mockResolvedValue({ items: [current.revision, legacy], nextCursor: 'older-history' });
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'View history for Generic supplier' }));

    expect(screen.getByRole('article', { name: 'Revision 2' })).toHaveTextContent(/legacy action unavailable/i);
    expect(screen.getByRole('article', { name: 'Revision 2' })).toHaveTextContent(
      /older comparison unavailable.*history is truncated/i,
    );
    expect(screen.queryByText('Initial recorded revision.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more history' })).not.toBeInTheDocument();
  });

  it('detects canonical action identifiers, tax mode, tag order, validity, and provenance changes', async () => {
    const current = ruleDetail({
      revision: {
        ...ruleDetail().revision,
        action: {
          categoryQboId: 'CATEGORY_NEW', taxCalculation: 'TaxExcluded',
          taxCodeQboId: 'TAX_NEW', tagIds: ['tag-a', 'tag-b'],
        },
        categoryName: 'Same category', taxCodeName: 'Same tax code',
        originIntent: 'auto_candidate', sourceCaseId: 'case-new', sourceCandidateId: null,
        changedBy: 'actor-new', valid: true, invalidReasons: [],
      },
    });
    const previous = {
      ...current.revision,
      id: 'revision-2', revision: 2,
      action: {
        categoryQboId: 'CATEGORY_OLD', taxCalculation: 'TaxInclusive' as const,
        taxCodeQboId: 'TAX_OLD', tagIds: ['tag-b', 'tag-a'],
      },
      originIntent: 'make_recurring' as const, sourceCaseId: 'case-old',
      sourceCandidateId: 'candidate-old', changedBy: 'actor-old',
      valid: false, invalidReasons: ['Old reference invalid.'],
    };
    mocks.lifecycleRules.mockResolvedValue({ items: [current], nextCursor: null });
    mocks.revisions.mockResolvedValue({ items: [current.revision, previous], nextCursor: null });
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'View history for Generic supplier' }));

    const newest = screen.getByRole('article', { name: 'Revision 3' });
    expect(newest).toHaveTextContent(/Same category.*CATEGORY_NEW.*TaxExcluded.*Same tax code.*TAX_NEW/i);
    expect(newest).toHaveTextContent(
      /changed.*category QBO ID.*CATEGORY_OLD.*CATEGORY_NEW.*tax calculation.*TaxInclusive.*TaxExcluded.*tax code QBO ID.*TAX_OLD.*TAX_NEW.*tag order.*validity invalid.*valid.*origin intent.*make recurring.*auto candidate.*source case.*case-old.*case-new.*source candidate.*candidate-old.*none.*actor.*actor-old.*actor-new/i,
    );
    expect(newest).not.toHaveTextContent(/no material classification fields changed/i);
  });

  it('requires a standalone auto-post preview with truthful affected counts', async () => {
    mocks.lifecycleRules.mockResolvedValue({ items: [ruleDetail()], nextCursor: null });
    mocks.prepare.mockResolvedValue(prepared('update', {
      autoPost: true, affectedPendingCount: 7, affectedPostedCount: 2,
      warnings: ['Enabling auto-post affects matching pending transactions.'],
    }));
    mocks.commit.mockResolvedValue({ ...prepared('update'), status: 'COMMITTED', preview: null });
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'Enable auto-post for Generic supplier' }));
    expect(mocks.prepare).toHaveBeenCalledWith('COMPANY_GENERIC', {
      mutation: 'update', ruleId: 'rule-1', expectedRevision: 3,
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
      proposal: { autoPost: true },
    });
    expect(await screen.findByText(/7 pending.*2 posted/i)).toBeInTheDocument();
    expect(screen.getByText(/enabling auto-post affects matching pending transactions/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm enable auto-post' }));
    expect(mocks.commit).toHaveBeenCalledWith(
      'COMPANY_GENERIC', 'operation-update', '99999999-9999-4999-8999-999999999999',
    );
  });

  it('previews candidate dismissal instead of using the retired one-call endpoint', async () => {
    const ready = candidate();
    mocks.listCandidates.mockResolvedValue({ candidates: [ready], nextCursor: null });
    mocks.prepare.mockResolvedValue(prepared('dismiss_candidate'));
    mocks.commit.mockResolvedValue({
      ...prepared('dismiss_candidate'), status: 'COMMITTED', preview: null,
      candidate: { candidateId: ready.id, state: 'dismissed', ruleId: null },
    });
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(mocks.prepare).toHaveBeenCalledWith('COMPANY_GENERIC', {
      mutation: 'dismiss_candidate', candidateId: ready.id, expectedRevision: 0,
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
    });
    await user.click(screen.getByRole('button', { name: 'Confirm dismiss candidate' }));
    expect(mocks.commit).toHaveBeenCalled();
  });

  it('loads every bounded page for review on demand', async () => {
    const first = candidate();
    const second = candidate({
      id: '77777777-7777-4777-8777-777777777777',
      matchText: 'contoso services',
    });
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

  it('caps visible lifecycle pages at 200 rows and stops before another request', async () => {
    const rules = Array.from({ length: 300 }, (_, index) => ruleDetail({
      revision: {
        ...ruleDetail().revision,
        id: `revision-cap-${index}`,
        ruleId: `rule-cap-${index}`,
        priority: index,
        condition: { matchField: 'payee', matchText: `Capped supplier ${index}` },
      },
    }));
    mocks.lifecycleRules.mockImplementation(async (
      _companyId: string,
      state: string,
      cursor?: string,
    ) => {
      if (state === 'enabled') return { items: [], nextCursor: null };
      if (!cursor) return { items: rules.slice(0, 100), nextCursor: 'rule-page-2' };
      if (cursor === 'rule-page-2') return { items: rules.slice(100, 200), nextCursor: 'rule-page-3' };
      return { items: rules.slice(200), nextCursor: null };
    });
    const user = userEvent.setup();
    render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'Load more rules' }));

    expect(await screen.findByText('Capped supplier 199')).toBeInTheDocument();
    expect(document.querySelectorAll('[id^="rule-rule-cap-"]')).toHaveLength(200);
    expect(screen.getByRole('status', { name: 'Rule lifecycle truncated' })).toHaveTextContent(
      /showing first 200 rules.*more rules exist/i,
    );
    expect(screen.queryByRole('button', { name: 'Load more rules' })).not.toBeInTheDocument();
    expect(mocks.lifecycleRules.mock.calls.filter(([, state]) => state === 'all')).toHaveLength(2);
  });

  it('caps visible candidate pages at 100 rows and stops before another request', async () => {
    const candidates = Array.from({ length: 120 }, (_, index) => candidate({
      id: `candidate-cap-${index}`,
      matchText: `Capped candidate ${index}`,
    }));
    mocks.listCandidates.mockImplementation(async (
      _companyId: string,
      cursor?: string,
    ) => {
      const pageNumber = cursor ? Number(cursor.replace('candidate-page-', '')) : 0;
      return {
        candidates: candidates.slice(pageNumber * 20, pageNumber * 20 + 20),
        nextCursor: `candidate-page-${pageNumber + 1}`,
      };
    });
    const user = userEvent.setup();
    render(<Rules />);

    for (let page = 1; page < 5; page += 1) {
      await user.click(await screen.findByRole('button', { name: 'Load more candidates' }));
    }

    expect(await screen.findByText('Capped candidate 99')).toBeInTheDocument();
    expect(document.querySelectorAll('[id^="rule-candidate-candidate-cap-"]')).toHaveLength(100);
    expect(screen.getByRole('status', { name: 'Rule candidates truncated' })).toHaveTextContent(
      /showing newest 100 candidates.*older candidates exist/i,
    );
    expect(screen.queryByRole('button', { name: 'Load more candidates' })).not.toBeInTheDocument();
    expect(mocks.listCandidates).toHaveBeenCalledTimes(5);
  });

  it('keeps all 200 enabled rules when an absent retired deep link is shown separately', async () => {
    const rules = Array.from({ length: 200 }, (_, index) => ruleDetail({
      revision: {
        ...ruleDetail().revision,
        id: `revision-source-cap-${index}`,
        ruleId: `rule-source-cap-${index}`,
        priority: index,
        condition: { matchField: 'payee', matchText: `Live capped supplier ${index}` },
      },
    }));
    const source = ruleDetail({
      active: false,
      executable: false,
      revision: {
        ...ruleDetail().revision,
        id: 'revision-retired-source',
        ruleId: 'rule-retired-source',
        state: 'retired',
        retiredAt: '2026-08-31T00:00:00.000Z',
        condition: { matchField: 'payee', matchText: 'Linked retired supplier' },
      },
    });
    mocks.detail.mockResolvedValue(source);
    mocks.lifecycleRules.mockImplementation(async (
      _companyId: string,
      state: string,
      cursor?: string,
    ) => {
      if (state !== 'enabled') return { items: [], nextCursor: null };
      return cursor
        ? { items: rules.slice(100), nextCursor: null }
        : { items: rules.slice(0, 100), nextCursor: 'enabled-page-2' };
    });
    window.history.replaceState({}, '', '/rules?source=rule&sourceId=rule-retired-source');
    const user = userEvent.setup();
    render(<Rules />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Rule lifecycle' }), 'enabled');
    await user.click(await screen.findByRole('button', { name: 'Load more rules' }));

    expect(await screen.findByText('Live capped supplier 199')).toBeInTheDocument();
    expect(document.querySelectorAll('[id^="rule-rule-source-cap-"]')).toHaveLength(200);
    const linkedSource = screen.getByRole('region', { name: 'Linked source rule' });
    expect(linkedSource).toHaveTextContent('Linked retired supplier');
    expect(screen.queryByRole('status', { name: 'Rule lifecycle truncated' })).not.toBeInTheDocument();
  });

  it.each([
    ['activated', 'Linked activated candidate'],
    ['dismissed', 'Linked dismissed candidate'],
  ] as const)('keeps all 100 candidates when an absent %s deep link is shown separately', async (state, matchText) => {
    const candidates = Array.from({ length: 100 }, (_, index) => candidate({
      id: `candidate-source-cap-${index}`,
      matchText: `Live capped candidate ${index}`,
    }));
    const source = candidate({
      id: `candidate-${state}-source`,
      state,
      matchText,
      canActivate: false,
      activatedRuleId: state === 'activated' ? 'rule-created' : null,
    });
    mocks.getCandidate.mockResolvedValue(source);
    mocks.listCandidates.mockImplementation(async (
      _companyId: string,
      cursor?: string,
    ) => {
      const pageNumber = cursor ? Number(cursor.replace('candidate-source-page-', '')) : 0;
      return {
        candidates: candidates.slice(pageNumber * 20, pageNumber * 20 + 20),
        nextCursor: pageNumber < 4 ? `candidate-source-page-${pageNumber + 1}` : null,
      };
    });
    window.history.replaceState({}, '', `/rules?source=rule_candidate&sourceId=${source.id}`);
    const user = userEvent.setup();
    render(<Rules />);

    for (let page = 1; page < 5; page += 1) {
      await user.click(await screen.findByRole('button', { name: 'Load more candidates' }));
    }

    expect(await screen.findByText('Live capped candidate 99')).toBeInTheDocument();
    expect(document.querySelectorAll('[id^="rule-candidate-candidate-source-cap-"]')).toHaveLength(100);
    const linkedSource = screen.getByRole('region', { name: 'Linked source candidate' });
    expect(linkedSource).toHaveTextContent(matchText);
    expect(within(linkedSource).queryByRole('button', { name: 'Activate rule' })).not.toBeInTheDocument();
    expect(within(linkedSource).queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Rule candidates truncated' })).not.toBeInTheDocument();
  });

  it('does not repeat linked sources that already belong to their live collection', async () => {
    const sourceRule = ruleDetail({
      revision: {
        ...ruleDetail().revision,
        ruleId: 'rule-present-source',
        condition: { matchField: 'payee', matchText: 'Present linked supplier' },
      },
    });
    mocks.detail.mockResolvedValue(sourceRule);
    mocks.lifecycleRules.mockImplementation(async (_companyId: string, state: string) => ({
      items: state === 'all' ? [sourceRule] : [],
      nextCursor: null,
    }));
    window.history.replaceState({}, '', '/rules?source=rule&sourceId=rule-present-source');
    const view = render(<Rules />);

    expect(await screen.findByText('Present linked supplier')).toBeInTheDocument();
    expect(screen.getAllByText('Present linked supplier')).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Linked source rule' })).not.toBeInTheDocument();

    const sourceCandidate = candidate({ id: 'candidate-present-source', matchText: 'Present linked candidate' });
    mocks.getCandidate.mockResolvedValue(sourceCandidate);
    mocks.listCandidates.mockResolvedValue({ candidates: [sourceCandidate], nextCursor: null });
    window.history.replaceState({}, '', `/rules?source=rule_candidate&sourceId=${sourceCandidate.id}`);
    view.unmount();
    render(<Rules />);

    expect(await screen.findByText('Present linked candidate')).toBeInTheDocument();
    expect(screen.getAllByText('Present linked candidate')).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Linked source candidate' })).not.toBeInTheDocument();
  });

  it('fences late lifecycle and candidate pages after a company switch', async () => {
    let resolveRules!: (value: { items: RuleDetailDto[]; nextCursor: null }) => void;
    let resolveCandidates!: (value: { candidates: RuleCandidateDto[]; nextCursor: null }) => void;
    mocks.lifecycleRules.mockImplementation((companyId: string, state: string, cursor?: string) => {
      if (state === 'enabled' || companyId === 'COMPANY_OTHER') return Promise.resolve({ items: [], nextCursor: null });
      if (cursor) return new Promise((resolve) => { resolveRules = resolve; });
      return Promise.resolve({ items: [ruleDetail()], nextCursor: 'old-rule-page' });
    });
    mocks.listCandidates.mockImplementation((companyId: string, cursor?: string) => {
      if (companyId === 'COMPANY_OTHER') return Promise.resolve({ candidates: [], nextCursor: null });
      if (cursor) return new Promise((resolve) => { resolveCandidates = resolve; });
      return Promise.resolve({ candidates: [candidate()], nextCursor: 'old-candidate-page' });
    });
    const user = userEvent.setup();
    const view = render(<Rules />);

    await user.click(await screen.findByRole('button', { name: 'Load more rules' }));
    await user.click(screen.getByRole('button', { name: 'Load more candidates' }));
    mocks.activeCompanyId = 'COMPANY_OTHER';
    view.rerender(<Rules />);
    await waitFor(() => expect(mocks.listCandidates).toHaveBeenCalledWith('COMPANY_OTHER'));

    await act(async () => {
      resolveRules({ items: [ruleDetail({ revision: { ...ruleDetail().revision, ruleId: 'late-rule', condition: { matchField: 'payee', matchText: 'Late old rule' } } })], nextCursor: null });
      resolveCandidates({ candidates: [candidate({ id: 'late-candidate', matchText: 'Late old candidate' })], nextCursor: null });
    });

    expect(screen.queryByText('Late old rule')).not.toBeInTheDocument();
    expect(screen.queryByText('Late old candidate')).not.toBeInTheDocument();
  });

  it('keeps the next page reachable after acting on the final visible candidate', async () => {
    const ready = candidate();
    mocks.listCandidates.mockResolvedValue({
      candidates: [ready],
      nextCursor: ready.id,
    });
    mocks.prepare.mockResolvedValue(prepared('activate_candidate'));

    render(<Rules />);
    expect(await screen.findByText('northwind market')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Activate rule' }));

    expect(await screen.findByRole('button', {
      name: 'Load more candidates',
    })).toBeInTheDocument();
  });

  it('ignores a completed candidate action after the active company changes', async () => {
    const ready = candidate();
    let resolveActivation!: (value: RuleMutationResult) => void;
    mocks.listCandidates.mockImplementation(async (companyId: string) => ({
      candidates: companyId === 'COMPANY_GENERIC' ? [ready] : [],
      nextCursor: null,
    }));
    mocks.prepare.mockReturnValue(new Promise<RuleMutationResult>((resolve) => {
      resolveActivation = resolve;
    }) as never);

    const view = render(<Rules />);
    expect(await screen.findByText('northwind market')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Activate rule' }));
    await waitFor(() => {
      expect(mocks.prepare).toHaveBeenCalledWith('COMPANY_GENERIC', expect.objectContaining({
        mutation: 'activate_candidate', candidateId: ready.id,
      }));
    });

    mocks.activeCompanyId = 'COMPANY_OTHER';
    view.rerender(<Rules />);
    await waitFor(() => {
      expect(mocks.listCandidates).toHaveBeenCalledWith('COMPANY_OTHER');
    });

    await act(async () => {
      resolveActivation(prepared('activate_candidate'));
    });

    expect(
      mocks.lifecycleRules.mock.calls.filter(([companyId]) => companyId === 'COMPANY_GENERIC'),
    ).toHaveLength(2);
    expect(mocks.toast).not.toHaveBeenCalledWith('Rule activated — auto-post remains off');
  });
});
