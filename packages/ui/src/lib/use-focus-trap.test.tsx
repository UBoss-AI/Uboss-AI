import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Modal } from '../primitives/Modal';

/**
 * Where a dialog puts the cursor when it opens.
 *
 * Found on a real screen: "Add a column" opened with the cursor on its close button, so somebody
 * who opened it with the keyboard and started typing typed into nothing. The trap focuses the
 * first focusable element in DOM order, and in every dialog in this product that is the dismiss
 * control — which makes it the one element it should almost never be.
 */
describe('useFocusTrap — the first thing focused', () => {
  it('focuses the control the dialog is about when one is marked', () => {
    render(
      <Modal open onClose={() => {}} title="Add a column">
        <input aria-label="Column name" data-autofocus />
        <input aria-label="Something else" />
      </Modal>,
    );

    expect(document.activeElement).toBe(screen.getByLabelText('Column name'));
  });

  it('still falls back to the first focusable thing when nothing is marked', () => {
    // Unchanged behaviour, so no dialog written before this moves.
    render(
      <Modal open onClose={() => {}} title="Plain">
        <input aria-label="A field" />
      </Modal>,
    );

    // The close button, which is what the trap has always chosen.
    expect((document.activeElement as HTMLElement).tagName).toBe('BUTTON');
  });

  it('prefers the marked control over one that comes before it', () => {
    render(
      <Modal open onClose={() => {}} title="Order">
        <button type="button">Before</button>
        <input aria-label="The point of this dialog" data-autofocus />
      </Modal>,
    );

    expect(document.activeElement).toBe(screen.getByLabelText('The point of this dialog'));
  });
});
