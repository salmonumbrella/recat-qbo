import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  mcpTokens: {
    list: mocks.list,
    create: mocks.create,
    revoke: mocks.revoke,
  },
}));

import McpTokensCard from './McpTokensCard';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const tokenRow = {
  id: '20000000-0000-4000-8000-000000000001',
  prefix: 'rct_example',
  label: 'Automation',
  status: 'active' as const,
  createdAt: '2026-07-28T12:00:00.000Z',
  expiresAt: '2026-10-26T12:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ items: [tokenRow], nextCursor: null });
  mocks.create.mockResolvedValue({
    token: 'rct_one_time_plaintext',
    mcpToken: tokenRow,
  });
  mocks.revoke.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.writeText.mockResolvedValue(undefined) },
  });
});

describe('McpTokensCard', () => {
  it('lists safe token metadata without a plaintext field', async () => {
    render(<McpTokensCard />);

    expect(await screen.findByText('Automation')).toBeInTheDocument();
    expect(screen.getByText(/rct_example…/)).toBeInTheDocument();
    expect(screen.getByText(/active/i)).toBeInTheDocument();
    expect(screen.queryByText('rct_one_time_plaintext')).not.toBeInTheDocument();
  });

  it('uses a 90-day default and keeps new plaintext only until dismissal', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
    const { unmount } = render(<McpTokensCard />);
    await screen.findByText('Automation');

    await user.clear(screen.getByLabelText(/token label/i));
    await user.type(screen.getByLabelText(/token label/i), 'Desktop agent');
    await user.click(screen.getByRole('button', { name: /create token/i }));

    expect(mocks.create).toHaveBeenCalledWith({ label: 'Desktop agent', expiresInDays: 90 });
    expect(await screen.findByText('rct_one_time_plaintext')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /copy token/i }));
    expect(mocks.writeText).toHaveBeenCalledWith('rct_one_time_plaintext');
    await user.click(screen.getByRole('button', { name: /dismiss token/i }));
    expect(screen.queryByText('rct_one_time_plaintext')).not.toBeInTheDocument();

    unmount();
    render(<McpTokensCard />);
    await screen.findByText('Automation');
    expect(screen.queryByText('rct_one_time_plaintext')).not.toBeInTheDocument();
  });

  it('revokes by ID then reloads the owner list', async () => {
    const user = userEvent.setup();
    render(<McpTokensCard />);
    await screen.findByText('Automation');

    await user.click(screen.getByRole('button', { name: /revoke automation/i }));

    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith(tokenRow.id));
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('clears one-time plaintext when unmounted without dismissal', async () => {
    const user = userEvent.setup();
    const mounted = render(<McpTokensCard />);
    await screen.findByText('Automation');

    await user.type(screen.getByLabelText(/token label/i), 'Short-lived agent');
    await user.click(screen.getByRole('button', { name: /create token/i }));
    expect(await screen.findByText('rct_one_time_plaintext')).toBeInTheDocument();

    mounted.unmount();
    render(<McpTokensCard />);
    await screen.findByText('Automation');
    expect(screen.queryByText('rct_one_time_plaintext')).not.toBeInTheDocument();
  });

  it('does not allow a second create to replace undisclosed plaintext', async () => {
    const user = userEvent.setup();
    render(<McpTokensCard />);
    await screen.findByText('Automation');

    await user.type(screen.getByLabelText(/token label/i), 'First agent');
    await user.click(screen.getByRole('button', { name: /create token/i }));
    expect(await screen.findByText('rct_one_time_plaintext')).toBeInTheDocument();

    const labelInput = screen.getByLabelText(/token label/i);
    expect(labelInput).toBeDisabled();
    await user.type(labelInput, 'Second agent');
    const createButton = screen.getByRole('button', { name: /create token/i });
    expect(createButton).toBeDisabled();
    await user.click(createButton);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(screen.getByText('rct_one_time_plaintext')).toBeInTheDocument();
  });

  it('shows a visible error when clipboard copying fails', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.writeText.mockRejectedValue(new Error('clipboard denied')) },
    });
    render(<McpTokensCard />);
    await screen.findByText('Automation');

    await user.type(screen.getByLabelText(/token label/i), 'Copy failure agent');
    await user.click(screen.getByRole('button', { name: /create token/i }));
    await user.click(await screen.findByRole('button', { name: /copy token/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not copy/i);
  });

  it('does not let a stale initial list overwrite newly created token metadata', async () => {
    const initial = deferred<{
      items: typeof tokenRow[];
      nextCursor: string | null;
    }>();
    mocks.list.mockReturnValueOnce(initial.promise);
    mocks.create.mockResolvedValueOnce({
      token: 'rct_new_plaintext',
      mcpToken: {
        ...tokenRow,
        id: '20000000-0000-4000-8000-000000000009',
        label: 'New agent',
        prefix: 'rct_new_safe',
      },
    });
    const user = userEvent.setup();
    render(<McpTokensCard />);

    await user.type(screen.getByLabelText(/token label/i), 'New agent');
    await user.click(screen.getByRole('button', { name: /create token/i }));
    expect(await screen.findByText('New agent')).toBeInTheDocument();
    expect(screen.getByText('rct_new_plaintext')).toBeInTheDocument();

    await act(async () => {
      initial.resolve({ items: [tokenRow], nextCursor: null });
      await initial.promise;
    });

    expect(screen.getByText('New agent')).toBeInTheDocument();
    expect(screen.queryByText('Automation')).not.toBeInTheDocument();
  });

  it('ignores an async create completion after unmount', async () => {
    const createRequest = deferred<{
      token: string;
      mcpToken: typeof tokenRow;
    }>();
    mocks.create.mockReturnValueOnce(createRequest.promise);
    const user = userEvent.setup();
    const mounted = render(<McpTokensCard />);
    await screen.findByText('Automation');
    await user.type(screen.getByLabelText(/token label/i), 'Unmounted agent');
    await user.click(screen.getByRole('button', { name: /create token/i }));

    mounted.unmount();
    await act(async () => {
      createRequest.resolve({
        token: 'rct_after_unmount',
        mcpToken: tokenRow,
      });
      await createRequest.promise;
    });

    render(<McpTokensCard />);
    await screen.findByText('Automation');
    expect(screen.queryByText('rct_after_unmount')).not.toBeInTheDocument();
  });

  it('clears a superseded load-more state after revoke refresh and ignores the stale page', async () => {
    const stalePage = deferred<{
      items: typeof tokenRow[];
      nextCursor: string | null;
    }>();
    const refreshedToken = {
      ...tokenRow,
      id: '20000000-0000-4000-8000-000000000008',
      label: 'Refreshed token',
    };
    const staleToken = {
      ...tokenRow,
      id: '20000000-0000-4000-8000-000000000007',
      label: 'Stale token',
    };
    mocks.list
      .mockResolvedValueOnce({ items: [tokenRow], nextCursor: 'older-page' })
      .mockReturnValueOnce(stalePage.promise)
      .mockResolvedValueOnce({ items: [refreshedToken], nextCursor: 'fresh-page' });
    const user = userEvent.setup();
    render(<McpTokensCard />);
    await screen.findByText('Automation');

    await user.click(screen.getByRole('button', { name: /load more/i }));
    expect(screen.getByRole('button', { name: /loading/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /revoke automation/i }));

    expect(await screen.findByText('Refreshed token')).toBeInTheDocument();
    const refreshedLoadMore = screen.getByRole('button', { name: /load more/i });
    expect(refreshedLoadMore).toBeEnabled();

    await act(async () => {
      stalePage.resolve({ items: [staleToken], nextCursor: null });
      await stalePage.promise;
    });

    expect(screen.getByText('Refreshed token')).toBeInTheDocument();
    expect(screen.queryByText('Stale token')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load more/i })).toBeEnabled();
  });
});
