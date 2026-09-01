import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ConfirmDialog from './ConfirmDialog';

function Harness({ busy = false, onCancel = vi.fn() }: { busy?: boolean; onCancel?: () => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Open confirmation</button>
    <ConfirmDialog
      open={open}
      title="Confirm classification"
      confirmLabel="Confirm"
      busy={busy}
      onConfirm={vi.fn()}
      onCancel={() => { onCancel(); setOpen(false); }}
    >Review the classification.</ConfirmDialog>
  </>;
}

describe('ConfirmDialog accessibility', () => {
  it('labels the modal, focuses it, traps focus, and restores the opener', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open confirmation' });
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Confirm classification' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(cancel).toHaveFocus();

    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.click(cancel);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('ignores Escape, backdrop, and cancellation while busy', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<Harness busy onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Open confirmation' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('confirm-dialog-backdrop'));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
