import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import HoverButton from './HoverButton';

it('applies hover styles only while the button is available', () => {
  render(
    <>
      <HoverButton
        style={{ background: 'var(--card)' }}
        hoverStyle={{ background: 'var(--hl)' }}
      >
        Enabled
      </HoverButton>
      <HoverButton
        disabled
        style={{ background: 'var(--card)' }}
        hoverStyle={{ background: 'var(--hl)' }}
      >
        Disabled
      </HoverButton>
      <HoverButton
        aria-disabled="true"
        style={{ background: 'var(--card)' }}
        hoverStyle={{ background: 'var(--hl)' }}
      >
        ARIA disabled
      </HoverButton>
    </>,
  );

  const enabled = screen.getByRole('button', { name: 'Enabled' });
  const disabled = screen.getByRole('button', { name: 'Disabled' });
  const ariaDisabled = screen.getByRole('button', { name: 'ARIA disabled' });

  fireEvent.mouseEnter(enabled);
  fireEvent.mouseEnter(disabled);
  fireEvent.mouseEnter(ariaDisabled);

  expect(enabled).toHaveStyle({ background: 'var(--hl)' });
  expect(disabled).toHaveStyle({ background: 'var(--card)' });
  expect(ariaDisabled).toHaveStyle({ background: 'var(--card)' });
});
