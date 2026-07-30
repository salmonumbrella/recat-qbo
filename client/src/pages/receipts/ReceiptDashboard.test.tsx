import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  upload: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  receipts: {
    stats: mocks.stats,
    upload: mocks.upload,
  },
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({
    activeCompanyId: 'company-1',
    role: 'categorizer',
    toast: mocks.toast,
  }),
}));

import ReceiptDashboard from './ReceiptDashboard';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stats.mockResolvedValue({
    received: 3,
    needsReview: 1,
    queued: 1,
    processing: 0,
    failed: 0,
    totalByCurrency: [
      { currency: 'CAD', amount: '24.40' },
      { currency: 'USD', amount: '10.00' },
    ],
    totalByCategory: [{
      category: 'Synthetic category',
      currency: 'CAD',
      amount: '24.40',
    }],
    totalTaxByCurrency: [{ currency: 'CAD', amount: '2.40' }],
    processingCostUsd: '0.02',
    recentActivity: [],
  });
  mocks.upload.mockResolvedValue({ receipts: [] });
});

describe('ReceiptDashboard', () => {
  it('shows currency-grouped totals and uploads dropped files', async () => {
    render(<MemoryRouter><ReceiptDashboard /></MemoryRouter>);

    expect(await screen.findByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('CAD 24.40')).toBeInTheDocument();
    expect(screen.getByText('USD 10.00')).toBeInTheDocument();
    expect(screen.getByText('Synthetic category · CAD 24.40')).toBeInTheDocument();
    const file = new File(['x'], 'synthetic.png', { type: 'image/png' });
    fireEvent.drop(screen.getByLabelText(/drop receipt files/i), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith(
      'company-1',
      [expect.objectContaining({ name: 'synthetic.png' })],
      'WEB_UPLOAD',
    ));
  });
});
