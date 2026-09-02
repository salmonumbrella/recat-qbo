import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CategoryPicker, { type CategoryOption } from './CategoryPicker';

// @ts-expect-error exported category options always carry a stable value
const MISSING_STABLE_CATEGORY_VALUE: CategoryOption = {
  group: 'Expenses',
  name: 'Office expense',
  sug: false,
};
void MISSING_STABLE_CATEGORY_VALUE;

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

  it('keeps Queue legacy keyboard-active categories in view', () => {
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      render(
        <div className="rr">
          <CategoryPicker
            query=""
            onQueryChange={vi.fn()}
            options={[
              { group: 'Expenses', name: 'Office expense', sug: false },
              { group: 'Expenses', name: 'Travel', sug: false },
            ]}
            empty={false}
            activeIdx={1}
            onPick={vi.fn()}
            showBadges={false}
            containerStyle={{ width: 300 }}
          />
        </div>,
      );

      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      if (previous) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previous);
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
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
