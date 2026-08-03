import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  receipts: {
    settings: {
      get: mocks.get,
      patch: mocks.patch,
    },
  },
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({ toast: mocks.toast }),
}));

import ReceiptProcessingCard from './ReceiptProcessingCard';

const settings = {
  enabled: true,
  provider: 'openrouter',
  model: 'openai/gpt-4o-mini',
  confidenceThreshold: 0.8,
  autoMatchThreshold: 85,
  autoMatchMargin: 15,
  maxPages: 20,
  configVersion: 'a'.repeat(64),
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(settings);
  mocks.patch.mockImplementation(async (_companyId, patch) => ({
    ...settings,
    ...patch,
  }));
});

describe('ReceiptProcessingCard', () => {
  it('discloses external data egress before opt-in', async () => {
    mocks.get.mockResolvedValue({ ...settings, enabled: false });
    render(<ReceiptProcessingCard companyId="company-1" />);

    const checkbox = await screen.findByRole('checkbox', {
      name: 'Enable receipt processing',
    });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAccessibleDescription(
      /receipt files and extracted text are sent to OpenRouter using openai\/gpt-4o-mini/i,
    );
    expect(screen.getByLabelText('Receipt provider')).toBeEnabled();
    expect(screen.getByLabelText('Vision model')).toBeEnabled();
  });

  it('edits thresholds without rendering provider secrets', async () => {
    render(<ReceiptProcessingCard companyId="company-1" />);

    expect(await screen.findByDisplayValue('openai/gpt-4o-mini'))
      .toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
    const threshold = screen.getByLabelText('Auto-match threshold');
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '90');
    fireEvent.blur(threshold);

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith(
      'company-1',
      { autoMatchThreshold: 90 },
    ));
  });

  it('restores empty model and numeric drafts without saving zero', async () => {
    render(<ReceiptProcessingCard companyId="company-1" />);
    const model = await screen.findByLabelText('Vision model');
    await userEvent.clear(model);
    fireEvent.blur(model);
    expect(model).toHaveValue('openai/gpt-4o-mini');

    const margin = screen.getByLabelText('Auto-match margin');
    await userEvent.clear(margin);
    fireEvent.blur(margin);
    expect(margin).toHaveValue(15);
    expect(mocks.patch).not.toHaveBeenCalledWith(
      'company-1',
      { autoMatchMargin: 0 },
    );
  });
});
