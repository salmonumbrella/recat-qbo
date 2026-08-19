import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  holdingAccountIds: [] as string[],
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    Link: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
  };
});

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    session: { id: 'admin-1', email: 'admin@example.com', isInstanceAdmin: true },
    sessionLoading: false,
    setSession: vi.fn(),
    companies: [{
      id: 'company-1',
      realmId: 'realm-1',
      legalName: 'Generic Books',
      nickname: 'Generic',
      env: 'sandbox',
      syncMode: 'polling',
      pollIntervalMin: 10,
      holdingAccountIds: mocks.holdingAccountIds,
      dryRun: true,
      tagsRequired: false,
      retainAttachmentFiles: false,
      connectedAt: '2026-08-01T00:00:00.000Z',
      disconnectedAt: null,
      lastSyncedAt: null,
    }],
    refreshCompanies: vi.fn(),
    setActiveCompany: vi.fn(),
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet },
  };
});

import Setup from './Setup';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.holdingAccountIds = [];
  sessionStorage.clear();
});

it('opts setup choice cards into shared hover feedback', async () => {
  mocks.apiGet.mockResolvedValue({
    needsSetup: false,
    credentialsSet: true,
    smtpConfigured: true,
    redirectUri: 'http://localhost/auth/qbo/callback',
    webhookUrl: 'http://localhost/webhooks/qbo',
  });

  render(<Setup />);

  expect((await screen.findByText('Try the demo')).closest('label'))
    .toHaveClass('interactive-surface');
  expect(screen.getByText('Connect my real QuickBooks').closest('label'))
    .toHaveClass('interactive-surface');
});

it('preselects only localized Uncategorised expense accounts by default', async () => {
  sessionStorage.setItem('recat.setupWizard.v3', JSON.stringify({
    stepId: 'accounts',
    mode: 'real',
    env: 'sandbox',
    syncMode: 'polling',
    adminEmail: 'admin@example.com',
    adminSent: true,
    companyId: 'company-1',
    connectEntry: true,
  }));
  mocks.apiGet.mockImplementation(async (path: string) => {
    if (path.endsWith('/holding-account-options')) {
      return [
        {
          qboId: 'localized-expense',
          name: 'Localized expense | Uncategorised Expense',
          count: 3,
        },
        {
          qboId: 'localized-income',
          name: 'Localized income | Uncategorised Income',
          count: 2,
        },
        {
          qboId: 'localized-asset',
          name: 'Localized asset | Uncategorised Asset',
          count: 1,
        },
      ];
    }
    return {
      needsSetup: false,
      credentialsSet: true,
      smtpConfigured: true,
      redirectUri: 'http://localhost/auth/qbo/callback',
      webhookUrl: 'http://localhost/webhooks/qbo',
    };
  });

  render(<Setup />);

  expect(await screen.findByRole('checkbox', {
    name: /Localized expense \| Uncategorised Expense/,
  })).toBeChecked();
  expect(screen.getByRole('checkbox', {
    name: /Localized income \| Uncategorised Income/,
  })).not.toBeChecked();
  expect(screen.getByRole('checkbox', {
    name: /Localized asset \| Uncategorised Asset/,
  })).not.toBeChecked();
});

it('uses configured holding accounts instead of name-based defaults', async () => {
  mocks.holdingAccountIds = ['custom-holding'];
  sessionStorage.setItem('recat.setupWizard.v3', JSON.stringify({
    stepId: 'accounts',
    mode: 'real',
    env: 'sandbox',
    syncMode: 'polling',
    adminEmail: 'admin@example.com',
    adminSent: true,
    companyId: 'company-1',
    connectEntry: true,
  }));
  mocks.apiGet.mockImplementation(async (path: string) => {
    if (path.endsWith('/holding-account-options')) {
      return [
        {
          qboId: 'localized-expense',
          name: 'Localized expense | Uncategorised Expense',
          count: 3,
        },
        {
          qboId: 'custom-holding',
          name: 'Clearing account',
          count: 4,
        },
      ];
    }
    return {
      needsSetup: false,
      credentialsSet: true,
      smtpConfigured: true,
      redirectUri: 'http://localhost/auth/qbo/callback',
      webhookUrl: 'http://localhost/webhooks/qbo',
    };
  });

  render(<Setup />);

  expect(await screen.findByRole('checkbox', {
    name: /Localized expense \| Uncategorised Expense/,
  })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Clearing account/ })).toBeChecked();
});
