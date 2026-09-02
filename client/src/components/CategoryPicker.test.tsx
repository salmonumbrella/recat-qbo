import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CategoryPicker from './CategoryPicker';

describe('CategoryPicker', () => {
  it('temporarily renders Queue legacy props until Queue adopts stable values', () => {
    render(
      <div className="rr">
        <CategoryPicker
          query="office"
          onQueryChange={vi.fn()}
          options={[{ group: 'Expenses', name: 'Office expense', sug: true }]}
          empty={false}
          activeIdx={0}
          onPick={vi.fn()}
          showBadges
          containerStyle={{ width: 300 }}
        />
      </div>,
    );

    expect(screen.getByRole('textbox')).toHaveValue('office');
    expect(screen.getByRole('button', { name: /office expense/i })).toBeInTheDocument();
  });

  it('searches grouped categories, marks the suggested option, and selects its stable value', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<div className="rr"><CategoryPicker label="Category for Northwind" value={null} onPick={onPick} showBadges options={[{ value: 'expense-office', group: 'Expenses', name: 'Office expense', sug: true }, { value: 'expense-travel', group: 'Expenses', name: 'Travel', sug: false }]} /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Category for Northwind' }));
    await user.type(screen.getByRole('textbox', { name: 'Category for Northwind' }), 'office');
    expect(screen.getByText('suggested')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith('expense-office');
  });

  it('keeps the split footer specialized and routes it without selecting a category', async () => {
    const onSplitFooter = vi.fn();
    const user = userEvent.setup();
    render(<div className="rr"><CategoryPicker label="Category" value={null} onPick={vi.fn()} onSplitFooter={onSplitFooter} showBadges={false} options={[]} /></div>);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(screen.getByRole('button', { name: /split into multiple categories/i }));
    expect(onSplitFooter).toHaveBeenCalledTimes(1);
  });
});
