import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RuleDetailDto, RuleMutationResult } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  lifecycleRules: vi.fn(),
  listCandidates: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  revisions: vi.fn(),
  testRule: vi.fn(),
  intentId: vi.fn(),
  search: vi.fn(),
  health: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'COMPANY_GENERIC',
    activeCompany: { id: 'COMPANY_GENERIC', holdingAccountIds: [] },
    accounts: [{ qboId: 'ACCOUNT_GENERIC', name: 'Office expense', classification: 'Expenses' }],
    tags: [],
    taxReadiness: { status: 'ready', reason: null, usingSalesTax: true, refreshedAt: '2026-07-30T00:00:00.000Z', taxCodes: [] },
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  createCategorizationRequestId: mocks.intentId,
  classificationMemory: { search: mocks.search, health: mocks.health },
  ruleOperations: { prepare: mocks.prepare, commit: mocks.commit },
  rules: { lifecycle: mocks.lifecycleRules, revisions: mocks.revisions, test: mocks.testRule },
  ruleCandidates: { list: mocks.listCandidates },
}));

import Rules from './Rules';

function ruleDetail(): RuleDetailDto {
  return {
    active: true,
    executable: true,
    reviewRequiredAt: null,
    reviewReason: null,
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

function prepared(): RuleMutationResult {
  return {
    ok: true, operationId: 'operation-update', companyId: 'COMPANY_GENERIC', mutation: 'update',
    originIntent: null, status: 'PREPARED', ruleId: 'rule-1', revision: null, rule: null,
    candidate: null, error: null,
    preview: {
      operationId: 'operation-update', companyId: 'COMPANY_GENERIC', ruleId: 'rule-1', candidateId: null,
      mutation: 'update', originIntent: null, currentRevision: 3, proposedRevision: 4,
      condition: { matchField: 'payee', matchText: 'Generic supplier' },
      action: ruleDetail().revision.action, categoryName: 'Office expense', taxCodeName: null,
      priority: 0, autoPost: false, affectedPendingCount: 0, affectedPostedCount: 0,
      sampleTransactions: [], conflicts: [], warnings: [], expiresAt: '2026-08-31T01:00:00.000Z', preparationDigest: 'digest',
    },
  };
}

function renderRules() {
  return render(<MemoryRouter><Rules /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lifecycleRules.mockResolvedValue({ items: [], nextCursor: null });
  mocks.listCandidates.mockResolvedValue({ candidates: [], nextCursor: null });
  mocks.revisions.mockResolvedValue({ items: [], nextCursor: null });
  mocks.search.mockResolvedValue({
    query: 'supplier', companyId: 'COMPANY_GENERIC', scope: 'current_company', mode: 'hybrid', requestedMode: 'hybrid',
    degraded: false, degradedReason: null, status: 'no_match', noMatch: true, total: 0, items: [], nextCursor: null,
  });
  mocks.health.mockResolvedValue({ configured: false, vectorAvailable: false, backlog: 0, progress: 0 });
  mocks.intentId.mockReturnValue('99999999-9999-4999-8999-999999999999');
});

it('renders the standard responsive Rules shell and an intentional zero-rules state', async () => {
  renderRules();

  expect(await screen.findByRole('heading', { level: 1, name: 'Rules' })).toBeInTheDocument();
  expect(screen.getByText(/manage executable rules and review their governed history/i)).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'No executable rules' })).toHaveTextContent(/No executable rules match this lifecycle/);
  expect(screen.getByRole('link', { name: 'Create rule from Queue' })).toHaveAttribute('href', '/');
});

it('changes lifecycle through the shared Select and prepares a category update through the shared Combobox', async () => {
  mocks.lifecycleRules.mockResolvedValue({ items: [ruleDetail()], nextCursor: null });
  mocks.prepare.mockResolvedValue(prepared());
  const user = userEvent.setup();
  renderRules();

  await user.click(await screen.findByRole('combobox', { name: 'Rule lifecycle' }));
  await user.click(screen.getByRole('option', { name: 'Enabled' }));
  await waitFor(() => expect(mocks.lifecycleRules).toHaveBeenCalledWith('COMPANY_GENERIC', 'enabled', undefined, 100));

  await user.click(screen.getByRole('combobox', { name: 'Category for Generic supplier' }));
  await user.type(screen.getByRole('textbox', { name: 'Category for Generic supplier' }), 'office');
  await user.keyboard('{ArrowDown}{Enter}');
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('COMPANY_GENERIC', expect.objectContaining({
    mutation: 'update', ruleId: 'rule-1', proposal: { categoryQboId: 'ACCOUNT_GENERIC' },
  })));
});

it('has no native select anywhere in the Rules render tree', async () => {
  renderRules();
  await screen.findByText(/No executable rules match this lifecycle/);
  expect(document.querySelectorAll('select')).toHaveLength(0);
});
