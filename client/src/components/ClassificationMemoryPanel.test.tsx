import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassificationSearchHit } from '@recat/shared';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  health: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  classificationMemory: {
    search: mocks.search,
    health: mocks.health,
  },
}));

import ClassificationMemoryPanel from './ClassificationMemoryPanel';

function hit(overrides: Partial<ClassificationSearchHit> = {}): ClassificationSearchHit {
  return {
    id: 'hit-1',
    sourceId: 'case-1',
    kind: 'classification_case',
    companyId: 'company-1',
    companyName: 'Northwind Books',
    companyRelation: 'current',
    executable: true,
    advisory: false,
    matchedIn: ['alias', 'case'],
    score: 0.91,
    vendorIdentityId: 'vendor-1',
    vendorName: 'Northwind Fuel',
    action: {
      categoryQboId: 'account-1',
      taxCalculation: 'TaxInclusive',
      taxCodeQboId: 'tax-1',
      tagIds: [],
    },
    actionSummary: {
      categoryName: 'Vehicle fuel',
      taxCalculation: 'TaxInclusive',
      taxCodeName: 'GST purchase',
      tagNames: ['Reviewed'],
    },
    originIntent: 'apply_once',
    evidenceCount: 4,
    conflictingEvidenceCount: 1,
    conflicts: [{
      id: 'conflict-1',
      companyId: 'company-1',
      sourceId: 'case-2',
      kind: 'case',
      reason: 'Receipt showed a personal purchase.',
      action: null,
      actionSummary: null,
      evidenceCount: 1,
    }],
    provenance: {
      source: 'qbo_verified',
      sourceId: 'attempt-1',
      actorId: 'user-1',
      recordedAt: '2026-08-30T12:00:00.000Z',
    },
    rationale: 'Receipt and route log support business fuel.',
    examples: [],
    counterexamples: ['Personal weekend purchase'],
    jurisdiction: 'CA-BC',
    currency: 'CAD',
    verifiedAt: '2026-08-30T12:00:00.000Z',
    ruleRevision: null,
    ...overrides,
  };
}

const healthy = {
  configured: true,
  provider: 'voyage',
  model: 'voyage-4-large',
  dimensions: 1024,
  vectorAvailable: true,
  expectedGeneration: 'generation-1',
  indexedGeneration: 'generation-1',
  activeGeneration: 'generation-1',
  expectedState: 'ready',
  embedded: 8,
  skipped: 0,
  backlog: 0,
  progress: 1,
  lastSuccessAt: '2026-08-30T12:00:00.000Z',
  lastError: null,
  latestAttemptGeneration: 'generation-1',
  latestAttemptState: 'ready',
  latestAttemptAt: '2026-08-30T12:00:00.000Z',
  latestAttemptError: null,
  currentCorpusRevision: '8',
  indexedCorpusRevision: '8',
  expectedCorpusRevision: '8',
  latestAttemptCorpusRevision: '8',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.health.mockResolvedValue(healthy);
  mocks.search.mockResolvedValue({
    query: 'Northwind Fuel',
    companyId: 'company-1',
    scope: 'current_company',
    mode: 'hybrid',
    requestedMode: 'hybrid',
    degraded: false,
    degradedReason: null,
    status: 'matched',
    noMatch: false,
    total: 1,
    items: [hit()],
    nextCursor: null,
  });
});

describe('ClassificationMemoryPanel', () => {
  it('searches with transaction context and renders bounded provenance with source navigation', async () => {
    render(
      <ClassificationMemoryPanel
        companyId="company-1"
        initialQuery="Northwind Fuel"
        transactionId="transaction-1"
        title="Similar Decisions"
        autoSearch
      />,
    );

    await waitFor(() => expect(mocks.search).toHaveBeenCalledWith('company-1', {
      query: 'Northwind Fuel',
      mode: 'hybrid',
      scope: 'current_company',
      transactionId: 'transaction-1',
      limit: 20,
    }));
    expect(screen.getByText('Northwind Books')).toBeInTheDocument();
    expect(screen.getByText(/alias.*case/i)).toBeInTheDocument();
    expect(screen.getByText(/Vehicle fuel.*GST purchase/i)).toBeInTheDocument();
    expect(screen.getByText(/Receipt and route log support business fuel/i)).toBeInTheDocument();
    expect(screen.getByText(/4 verified evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/1 conflict/i)).toBeInTheDocument();
    expect(screen.getByText(/Receipt showed a personal purchase/i)).toBeInTheDocument();
    expect(screen.getByText(/verified Aug 30, 2026/i)).toBeInTheDocument();
    expect(screen.getByText('Executable')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open source case/i })).toHaveAttribute(
      'href',
      '/rules?source=classification_case&sourceId=case-1',
    );
  });

  it('labels lexical degradation and semantic backfill without overstating hybrid search', async () => {
    mocks.health.mockResolvedValue({ ...healthy, backlog: 3, progress: 0.625, expectedState: 'building' });
    mocks.search.mockResolvedValue({
      query: 'fuel', companyId: 'company-1', scope: 'current_company',
      mode: 'lexical', requestedMode: 'hybrid', degraded: true,
      degradedReason: 'semantic_unavailable', status: 'matched', noMatch: false,
      total: 1, items: [hit({ advisory: true, executable: false })], nextCursor: null,
    });

    render(<ClassificationMemoryPanel companyId="company-1" initialQuery="fuel" autoSearch />);

    expect(await screen.findByText(/lexical results/i)).toBeInTheDocument();
    expect(screen.getByText(/degraded.*semantic unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/semantic backfill.*3 remaining.*63%/i)).toBeInTheDocument();
    expect(screen.getByText('Advisory')).toBeInTheDocument();
  });

  it('distinguishes a successful no-match from unavailable semantic search', async () => {
    const user = userEvent.setup();
    mocks.search.mockResolvedValueOnce({
      query: 'unknown', companyId: 'company-1', scope: 'current_company', mode: 'exact',
      requestedMode: 'exact', degraded: false, degradedReason: null, status: 'no_match',
      noMatch: true, total: 0, items: [], nextCursor: null,
    });
    const view = render(<ClassificationMemoryPanel companyId="company-1" initialQuery="unknown" />);
    await user.click(screen.getByRole('button', { name: 'Search knowledge' }));
    expect(await screen.findByText(/nothing matched/i)).toBeInTheDocument();

    mocks.search.mockRejectedValueOnce(new Error('Semantic classification search is unavailable.'));
    view.rerender(<ClassificationMemoryPanel companyId="company-1" initialQuery="unknown" />);
    await user.selectOptions(screen.getByLabelText('Search mode'), 'semantic');
    await user.click(screen.getByRole('button', { name: 'Search knowledge' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/semantic classification search is unavailable/i);
    expect(screen.queryByText(/nothing matched/i)).not.toBeInTheDocument();
  });

  it('invalidates an in-flight result when company context changes', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.search.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    mocks.search.mockResolvedValueOnce({
      query: 'new supplier', companyId: 'company-2', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'hybrid', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 1, items: [hit({
        id: 'hit-new', companyId: 'company-2', companyName: 'New Company',
        vendorName: 'New supplier', sourceId: 'case-new',
      })], nextCursor: null,
    });
    const view = render(
      <ClassificationMemoryPanel companyId="company-1" initialQuery="old supplier" autoSearch />,
    );
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1));

    view.rerender(
      <ClassificationMemoryPanel companyId="company-2" initialQuery="new supplier" autoSearch />,
    );
    expect(await screen.findByText('New Company')).toBeInTheDocument();

    resolveOld({
      query: 'old supplier', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'hybrid', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 1, items: [hit({ companyName: 'Old Company' })], nextCursor: null,
    });
    await waitFor(() => expect(screen.queryByText('Old Company')).not.toBeInTheDocument());
  });
});
