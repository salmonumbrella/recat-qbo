import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'admin',
  retain: true,
  instanceAdmin: true,
  updateCompany: vi.fn(),
  attachmentStoragePolicy: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  companies: { attachmentStoragePolicy: mocks.attachmentStoragePolicy },
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({
    role: mocks.role,
    session: { isInstanceAdmin: mocks.instanceAdmin },
    activeCompany: {
      id: 'company-1',
      retainAttachmentFiles: mocks.retain,
    },
    updateCompany: mocks.updateCompany,
    toast: mocks.toast,
  }),
}));

import AttachmentRetentionCard from './AttachmentRetentionCard';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'admin';
  mocks.retain = true;
  mocks.instanceAdmin = true;
  mocks.updateCompany.mockResolvedValue(undefined);
  mocks.attachmentStoragePolicy.mockResolvedValue({
    companyQuotaBytes: '1073741824',
    instanceQuotaBytes: '10737418240',
    companyUsageBytes: '1048576',
    instanceUsageBytes: '2097152',
    retentionDays: 365,
    companyQuotaOverrideBytes: null,
    companyRetentionOverrideDays: null,
  });
});

describe('AttachmentRetentionCard', () => {
  it('shows finite policy and physical usage', async () => {
    render(<AttachmentRetentionCard />);

    expect(screen.getByRole('checkbox', { name: /retain receipt files/i })).toBeChecked();
    expect(screen.getByText(/future uploads only/i)).toBeInTheDocument();
    expect(await screen.findByText(/up to 365 days/i)).toBeInTheDocument();
    expect(screen.getByText(/1 GiB company quota/i)).toBeInTheDocument();
    expect(screen.getByText(/1 MiB used by this company/i)).toBeInTheDocument();
  });

  it('lets an admin disable retention with pending-state protection', async () => {
    const pending = new Promise<void>(() => {});
    mocks.updateCompany.mockReturnValue(pending);
    render(<AttachmentRetentionCard />);

    await userEvent.click(screen.getByRole('checkbox', { name: /retain receipt files/i }));

    expect(mocks.updateCompany).toHaveBeenCalledWith({ retainAttachmentFiles: false });
    expect(screen.getByRole('checkbox', { name: /retain receipt files/i })).toBeDisabled();
  });

  it('rolls back an optimistic change when the update fails', async () => {
    mocks.updateCompany.mockRejectedValue(new Error('Could not save'));
    render(<AttachmentRetentionCard />);

    await userEvent.click(screen.getByRole('checkbox', { name: /retain receipt files/i }));

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /retain receipt files/i })).toBeChecked();
      expect(mocks.toast).toHaveBeenCalledWith('Could not save');
    });
  });

  it('is read-only for non-admin members', () => {
    mocks.role = 'categorizer';
    render(<AttachmentRetentionCard />);

    expect(screen.getByRole('checkbox', { name: /retain receipt files/i })).toBeDisabled();
    expect(screen.getByText(/company administrators/i)).toBeInTheDocument();
  });

  it('lets an instance admin save exact company overrides', async () => {
    render(<AttachmentRetentionCard />);
    await screen.findByRole('button', { name: /save storage policy/i });

    await userEvent.type(
      screen.getByRole('textbox', { name: /company quota override/i }),
      '2097152',
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: /retention override/i }),
      '30',
    );
    await userEvent.click(screen.getByRole('button', { name: /save storage policy/i }));

    await waitFor(() => {
      expect(mocks.updateCompany).toHaveBeenCalledWith({
        attachmentQuotaBytes: '2097152',
        attachmentRetentionDays: 30,
      });
    });
  });

  it('does not expose override controls to a company-only admin', async () => {
    mocks.instanceAdmin = false;
    render(<AttachmentRetentionCard />);
    await screen.findByText(/used by this company/i);

    expect(screen.queryByRole('button', { name: /save storage policy/i })).not.toBeInTheDocument();
  });
});
