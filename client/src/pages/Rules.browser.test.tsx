import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { HistoricalObservationPastDecision, RuleDetailDto, RuleMutationResult } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(),
  revisions: vi.fn(),
  testRule: vi.fn(),
  affectedTransactions: vi.fn(),
  listCandidates: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  intentId: vi.fn(),
  search: vi.fn(),
  health: vi.fn(),
  pastDecisions: vi.fn(),
  getObservation: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'COMPANY_GENERIC',
    activeCompany: { id: 'COMPANY_GENERIC', holdingAccountIds: [] },
    accounts: [{ qboId: 'ACCOUNT_GENERIC', name: 'Office expense', classification: 'Expenses' }],
    tags: [],
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  createCategorizationRequestId: mocks.intentId,
  classificationMemory: {
    search: mocks.search,
    health: mocks.health,
    pastDecisions: mocks.pastDecisions,
    getObservation: mocks.getObservation,
  },
  ruleOperations: { prepare: mocks.prepare, commit: mocks.commit },
  rules: {
    lifecycle: mocks.lifecycle,
    revisions: mocks.revisions,
    test: mocks.testRule,
    affectedTransactions: mocks.affectedTransactions,
  },
  ruleCandidates: { list: mocks.listCandidates },
}));

import Rules from './Rules';

function rule(): RuleDetailDto {
  return {
    active: true, executable: true, reviewRequiredAt: null, reviewReason: null,
    revision: {
      id: 'revision-3', ruleId: 'rule-1', companyId: 'COMPANY_GENERIC', revision: 3,
      state: 'enabled', condition: { matchField: 'payee', matchText: 'Generic supplier' },
      action: { categoryQboId: 'ACCOUNT_GENERIC', taxCalculation: 'NotApplicable', taxCodeQboId: null, tagIds: [] },
      categoryName: 'Office expense', taxCodeName: null, priority: 0, autoPost: false,
      originIntent: null, sourceCaseId: null, sourceCandidateId: null, changedBy: null,
      createdAt: '2026-08-30T00:00:00.000Z', retiredAt: null, valid: true, invalidReasons: [],
    },
  };
}

function observation(): HistoricalObservationPastDecision {
  return {
    kind: 'historical_observation', id: 'observation-a', companyId: 'COMPANY_GENERIC',
    transactionId: 'transaction-a', qboType: 'Purchase', qboId: 'purchase-a',
    payee: 'Historical supplier', memo: null,
    actionSummary: { categoryName: 'Office expense', taxCalculation: 'NotApplicable', taxCodeName: null, tagNames: [] },
    sourceStatus: 'POSTED', observedRecatRevision: 4, observedQboRevision: '7',
    observedAt: '2026-08-30T00:00:00.000Z', supersededByCaseId: null,
    advisory: true, executable: false,
  };
}

function prepared(): RuleMutationResult {
  return {
    ok: true, operationId: 'operation-disable', companyId: 'COMPANY_GENERIC', mutation: 'disable',
    originIntent: null, status: 'PREPARED', ruleId: 'rule-1', revision: null, rule: null, candidate: null, error: null,
    preview: {
      operationId: 'operation-disable', companyId: 'COMPANY_GENERIC', ruleId: 'rule-1', candidateId: null,
      mutation: 'disable', originIntent: null, currentRevision: 3, proposedRevision: 4,
      condition: rule().revision.condition, action: rule().revision.action, categoryName: 'Office expense', taxCodeName: null,
      priority: 0, autoPost: false, affectedPendingCount: 0, affectedPostedCount: 0, sampleTransactions: [], conflicts: [], warnings: [],
      expiresAt: '2026-09-01T01:00:00.000Z', preparationDigest: 'digest',
    },
  };
}

function renderRules() {
  return render(<MemoryRouter><Rules /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/rules');
  mocks.lifecycle.mockResolvedValue({ items: [rule()], nextCursor: null });
  mocks.revisions.mockResolvedValue({ items: [], nextCursor: null });
  mocks.testRule.mockResolvedValue({ pendingCount: 0, postedCount: 0, conflicts: [], matches: [] });
  mocks.affectedTransactions.mockResolvedValue({ items: [], nextCursor: null, matchedCount: 0, pendingCount: 0, postedCount: 0 });
  mocks.listCandidates.mockResolvedValue({ candidates: [], nextCursor: null });
  mocks.search.mockResolvedValue({
    query: 'supplier', companyId: 'COMPANY_GENERIC', scope: 'current_company', mode: 'hybrid', requestedMode: 'hybrid',
    degraded: false, degradedReason: null, status: 'no_match', noMatch: true, total: 0, items: [], nextCursor: null,
  });
  mocks.health.mockResolvedValue({ configured: false, vectorAvailable: false, backlog: 0, progress: 0 });
  mocks.pastDecisions.mockResolvedValue({ items: [], nextCursor: null });
  mocks.intentId.mockReturnValue('99999999-9999-4999-8999-999999999999');
  mocks.prepare.mockResolvedValue(prepared());
});

it('keeps the four rules-browser surfaces distinct and opens an exact advisory source', async () => {
  window.history.replaceState({}, '', '/rules?source=historical_observation&sourceId=observation-a');
  mocks.getObservation.mockResolvedValue(observation());

  renderRules();

  expect(await screen.findByRole('heading', { name: 'Executable Rules' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Past Decisions' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Learned Candidates' })).toBeInTheDocument();
  expect(await screen.findByText('Advisory historical observation')).toBeInTheDocument();
  expect(mocks.getObservation).toHaveBeenCalledWith('COMPANY_GENERIC', 'observation-a');
});

it('keeps a rule edit on the existing governed prepare then commit path', async () => {
  renderRules();
  await userEvent.setup().click(await screen.findByRole('button', { name: /disable generic supplier/i }));

  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('COMPANY_GENERIC', expect.objectContaining({
    mutation: 'disable', ruleId: 'rule-1', expectedRevision: 3,
  })));
  expect(mocks.commit).not.toHaveBeenCalled();
});
