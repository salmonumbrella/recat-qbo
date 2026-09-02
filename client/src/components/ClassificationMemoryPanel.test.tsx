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

async function chooseControl(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  optionName: string,
) {
  await user.click(screen.getByRole('combobox', { name: label }));
  const search = screen.queryByRole('textbox', { name: label });
  if (search) await user.type(search, optionName);
  await user.click(screen.getByRole('option', { name: optionName }));
}

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
  mocks.search.mockReset();
  mocks.health.mockReset();
  mocks.health.mockResolvedValue(healthy);
  mocks.search.mockResolvedValue({
    query: 'Northwind Fuel',
    companyId: 'company-1',
    scope: 'current_company',
    mode: 'hybrid',
    requestedMode: 'auto',
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
  it('keeps the search mode accessible through the shared control label', () => {
    render(<ClassificationMemoryPanel companyId="company-1" initialQuery="Northwind Fuel" />);

    expect(screen.getByRole('combobox', { name: 'Search mode' })).toBeInTheDocument();
    expect(screen.getByText('Search mode')).toBeInTheDocument();
  });

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
      mode: 'auto',
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
      mode: 'lexical', requestedMode: 'auto', degraded: true,
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

    mocks.search.mockRejectedValueOnce(new Error('Hybrid classification search is unavailable.'));
    view.rerender(<ClassificationMemoryPanel companyId="company-1" initialQuery="unknown" />);
    await chooseControl(user, 'Search mode', 'Hybrid');
    await user.click(screen.getByRole('button', { name: 'Search knowledge' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/hybrid classification search is unavailable/i);
    expect(screen.queryByText(/nothing matched/i)).not.toBeInTheDocument();
  });

  it('invalidates an in-flight result when company context changes', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.search.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    mocks.search.mockResolvedValueOnce({
      query: 'new supplier', companyId: 'company-2', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
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
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 1, items: [hit({ companyName: 'Old Company' })], nextCursor: null,
    });
    await waitFor(() => expect(screen.queryByText('Old Company')).not.toBeInTheDocument());
  });

  it('loads bounded search pages with the same context and deduplicates hits', async () => {
    mocks.search.mockResolvedValueOnce({
      query: 'Northwind Fuel', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 2, items: [hit()], nextCursor: 'cursor-1',
    }).mockResolvedValueOnce({
      query: 'Northwind Fuel', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 2, items: [
        hit(),
        hit({ id: 'hit-2', sourceId: 'rule-2', kind: 'rule', vendorName: 'Northwind Repairs' }),
      ], nextCursor: null,
    });
    const user = userEvent.setup();
    render(
      <ClassificationMemoryPanel
        companyId="company-1"
        initialQuery="Northwind Fuel"
        transactionId="transaction-1"
        autoSearch
      />,
    );

    await user.click(await screen.findByRole('button', { name: /load more.*1 of 2/i }));
    await waitFor(() => expect(mocks.search).toHaveBeenLastCalledWith('company-1', {
      query: 'Northwind Fuel', mode: 'auto', scope: 'current_company',
      transactionId: 'transaction-1', limit: 20, cursor: 'cursor-1',
    }));
    expect(await screen.findByText('Northwind Repairs')).toBeInTheDocument();
    expect(screen.getAllByText('Northwind Fuel')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('fences a late page when query or mode changes', async () => {
    let resolvePage!: (value: unknown) => void;
    mocks.search.mockResolvedValueOnce({
      query: 'fuel', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 2, items: [hit()], nextCursor: 'cursor-1',
    }).mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    const user = userEvent.setup();
    render(<ClassificationMemoryPanel companyId="company-1" initialQuery="fuel" autoSearch />);
    await user.click(await screen.findByRole('button', { name: /load more/i }));

    await user.clear(screen.getByLabelText('Classification search'));
    await user.type(screen.getByLabelText('Classification search'), 'repairs');
    await chooseControl(user, 'Search mode', 'Exact');
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Northwind Books')).not.toBeInTheDocument();
    resolvePage({
      query: 'fuel', companyId: 'company-1', scope: 'current_company', mode: 'hybrid',
      requestedMode: 'auto', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 2, items: [hit({ id: 'late', vendorName: 'Late stale result' })], nextCursor: null,
    });

    await waitFor(() => expect(screen.queryByText('Late stale result')).not.toBeInTheDocument());
  });

  it('does not invent navigation for vendor-only knowledge hits', async () => {
    mocks.search.mockResolvedValue({
      query: 'Northwind', companyId: 'company-1', scope: 'current_company', mode: 'exact',
      requestedMode: 'exact', degraded: false, degradedReason: null, status: 'matched',
      noMatch: false, total: 1, items: [hit({
        kind: 'vendor_identity', sourceId: 'vendor-1', action: null, actionSummary: null,
      })], nextCursor: null,
    });
    const user = userEvent.setup();
    render(<ClassificationMemoryPanel companyId="company-1" initialQuery="Northwind" />);
    await chooseControl(user, 'Search mode', 'Exact');
    await user.click(screen.getByRole('button', { name: 'Search knowledge' }));

    expect(await screen.findByText('Northwind Books')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open source/i })).not.toBeInTheDocument();
  });
});
