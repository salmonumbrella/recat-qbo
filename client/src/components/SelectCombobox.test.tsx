import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Combobox, Select, type ControlOption } from './SelectCombobox';

const OPTIONS: ControlOption[] = [
  { value: 'all', label: 'All accounts', searchText: 'all every' },
  { value: 'bank', label: 'Operating bank', searchText: 'checking operating' },
  { value: 'archive', label: 'Archived account', disabled: true },
];

async function waitForAnimationFrames(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

describe('Select', () => {
  it('opens a labelled listbox, selects with the keyboard, and restores focus after Escape', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<div className="rr"><Select label="Account filter" value="all" options={OPTIONS} onValueChange={onValueChange} /></div>);

    const trigger = screen.getByRole('combobox', { name: 'Account filter' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox', { name: 'Account filter' })).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('bank');

    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('uses type-ahead, never selects disabled options, and exposes the selected option', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<div className="rr"><Select label="Account filter" value="all" options={OPTIONS} onValueChange={onValueChange} /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Account filter' }));
    expect(screen.getByRole('option', { name: 'Archived account' })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('oper{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('bank');
  });
});

describe('Combobox', () => {
  it('focuses its search input, filters options, renders an explicit empty state, and clears only when allowed', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<div className="rr"><Combobox label="Category" value="bank" options={OPTIONS} onValueChange={onValueChange} allowClear searchPlaceholder="Search categories" emptyText="No matching categories" /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    const input = screen.getByRole('textbox', { name: 'Category' });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, 'missing');
    expect(screen.getByText('No matching categories')).toBeInTheDocument();
    await user.clear(input);
    await user.click(screen.getByRole('option', { name: 'Clear selection' }));
    expect(onValueChange).toHaveBeenCalledWith(null);
  });

  it('renders custom option presentation and footer inside the portalled menu', async () => {
    const user = userEvent.setup();
    render(<div className="rr"><Combobox label="Category" value="all" options={OPTIONS} onValueChange={vi.fn()} renderOption={(option) => <><span>{option.label}</span>{option.value === 'bank' && <em>suggested</em>}</>} footer={<button type="button">Split into multiple categories</button>} /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    expect(screen.getByText('suggested')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Split into multiple categories' })).toBeInTheDocument();
  });

  it('does not restore a dismissed control focus over a newly opened control or unrelated field', async () => {
    const user = userEvent.setup();
    render(
      <div className="rr">
        <Combobox label="First category" value="all" options={OPTIONS} onValueChange={vi.fn()} />
        <Combobox label="Second category" value="all" options={OPTIONS} onValueChange={vi.fn()} />
        <input aria-label="Unrelated field" />
      </div>,
    );

    await user.click(screen.getByRole('combobox', { name: 'First category' }));
    expect(screen.getByRole('textbox', { name: 'First category' })).toHaveFocus();

    const secondTrigger = screen.getByRole('combobox', { name: 'Second category' });
    await user.click(secondTrigger);
    const secondInput = screen.getByRole('textbox', { name: 'Second category' });
    await waitForAnimationFrames();
    expect(secondTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(secondInput).toHaveFocus();

    const unrelatedField = screen.getByRole('textbox', { name: 'Unrelated field' });
    await user.click(unrelatedField);
    await waitForAnimationFrames();
    expect(unrelatedField).toHaveFocus();
  });

  it('keeps the active listbox option programmatically associated with its focused search input', async () => {
    const user = userEvent.setup();
    render(<div className="rr"><Combobox label="Category" value="all" options={OPTIONS} onValueChange={vi.fn()} /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    const input = screen.getByRole('textbox', { name: 'Category' });
    await user.keyboard('{ArrowDown}');

    const listbox = screen.getByRole('listbox', { name: 'Category' });
    const activeOptionId = input.getAttribute('aria-activedescendant');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    expect(activeOptionId).not.toBeNull();
    expect(document.getElementById(activeOptionId!)).toHaveAttribute('role', 'option');
  });
});
