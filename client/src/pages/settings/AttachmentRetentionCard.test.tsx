import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'admin',
  retain: true,
  updateCompany: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({
    role: mocks.role,
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
  mocks.updateCompany.mockResolvedValue(undefined);
});

describe('AttachmentRetentionCard', () => {
  it('defaults to retained and explains that changes affect future uploads only', () => {
    render(<AttachmentRetentionCard />);

    expect(screen.getByRole('checkbox', { name: /retain receipt files/i })).toBeChecked();
    expect(screen.getByText(/future uploads only/i)).toBeInTheDocument();
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
});
