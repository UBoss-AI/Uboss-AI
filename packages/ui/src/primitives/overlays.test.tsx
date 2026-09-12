import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog';
import { Drawer } from './Drawer';
import { Modal } from './Modal';
import { TabPanel, Tabs } from './Tabs';

describe('Modal', () => {
  it('renders nothing while closed', () => {
    render(
      <Modal open={false} onClose={() => {}} title="Hidden">
        <p>Body</p>
      </Modal>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders as a labelled modal dialog', () => {
    render(
      <Modal open onClose={() => {}} title="Node properties">
        <p>Body</p>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Node properties');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Closable">
        <p>Body</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on a backdrop click but not on a click inside the panel', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="Closable">
        <p>Inside body</p>
      </Modal>,
    );

    screen.getByText('Inside body').click();
    expect(onClose).not.toHaveBeenCalled();

    const overlay = container.querySelector('.uboss-overlay');
    if (overlay) {
      fireEvent.click(overlay);
    }
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('moves focus into the dialog when it opens', () => {
    render(
      <Modal open onClose={() => {}} title="Focus me">
        <button type="button">Inner action</button>
      </Modal>,
    );

    // Focus must land inside the dialog so a keyboard user is not left behind the overlay.
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });
});

/**
 * A dialog that owns its own open state and passes an inline close, which is how every caller in
 * the application writes it.
 */
function TypingHarness() {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState('');
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Type here">
      <button type="button">First focusable</button>
      <textarea
        aria-label="Reason"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </Modal>
  );
}

describe('Modal — focus while typing', () => {
  it('keeps focus where the person put it, character after character', async () => {
    /*
     * A regression test for a defect this suite did not catch.
     *
     * `useFocusTrap` listed `onClose` in its dependency array, and every caller passes an
     * inline arrow — so the effect re-ran on every render and re-focused the first focusable
     * element. Typing a sentence into any modal field produced exactly one character: the work
     * email on Invite User, the reason on Suspend, the correction on Report Issue.
     *
     * Nothing here is about focus *trapping*, which the tests above already cover. It is about the
     * trap staying out of the way once it has done its job.
     */
    render(<TypingHarness />);

    const box = screen.getByLabelText('Reason');
    await userEvent.type(box, 'Because the supplier changed their terms.');

    expect(box).toHaveValue('Because the supplier changed their terms.');
    expect(box).toHaveFocus();
  });

  it('still closes on Escape, using the latest handler rather than the first', async () => {
    // The other half of the fix: the handler reads a ref, so holding the effect to one run per
    // open does not freeze it against a stale close.
    render(<TypingHarness />);

    await userEvent.type(screen.getByLabelText('Reason'), 'x');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Drawer', () => {
  it('renders as a labelled dialog and closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Employee detail">
        <p>Panel body</p>
      </Drawer>,
    );

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Employee detail');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ConfirmDialog — dangerous action gate', () => {
  it('shows the impact preview before the action is taken', () => {
    render(
      <ConfirmDialog
        open
        onCancel={() => {}}
        onConfirm={() => {}}
        title="Approve & Assign"
        description="This will assign work to 4 people."
        impact={[
          { label: 'Employees affected', value: '4' },
          { label: 'AI steps', value: '2' },
        ]}
      />,
    );

    expect(screen.getByText('Impact preview')).toBeInTheDocument();
    expect(screen.getByText('Employees affected')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('confirms directly when no reason is required', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onCancel={() => {}}
        onConfirm={onConfirm}
        title="Proceed"
        description="Safe action."
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('refuses to confirm until a required reason is given, then passes it through', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onCancel={() => {}}
        onConfirm={onConfirm}
        title="Suspend company"
        description="This blocks all access."
        requireReason
        destructive
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText('A reason is required for this action.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: 'Non-payment escalation #INC-204' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith('Non-payment escalation #INC-204');
  });

  it('requires the exact confirmation phrase for a destructive action', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onCancel={() => {}}
        onConfirm={onConfirm}
        title="Delete workspace"
        description="This cannot be undone."
        confirmPhrase="SPM Medicare"
        destructive
      />,
    );

    fireEvent.change(screen.getByLabelText(/Type "SPM Medicare" to confirm/), {
      target: { value: 'spm medicare' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText('The text does not match.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Type "SPM Medicare" to confirm/), {
      target: { value: 'SPM Medicare' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('cancels without confirming', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onCancel={onCancel}
        onConfirm={onConfirm}
        title="Proceed"
        description="Safe action."
      />,
    );

    screen.getByRole('button', { name: 'Cancel' }).click();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('Tabs', () => {
  const items = [
    { id: 'overview', label: 'Overview' },
    { id: 'runs', label: 'Runs' },
    { id: 'audit', label: 'Audit' },
  ];

  it('follows the ARIA tabs pattern with a roving tabindex', () => {
    render(<Tabs label="Agent detail" items={items} activeId="overview" onChange={() => {}} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
  });

  it('moves between tabs with arrow keys', () => {
    const onChange = vi.fn();
    render(<Tabs label="Agent detail" items={items} activeId="overview" onChange={onChange} />);

    fireEvent.keyDown(screen.getAllByRole('tab')[0]!, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('runs');
  });

  it('wraps from the first tab to the last with ArrowLeft', () => {
    const onChange = vi.fn();
    render(<Tabs label="Agent detail" items={items} activeId="overview" onChange={onChange} />);

    fireEvent.keyDown(screen.getAllByRole('tab')[0]!, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('audit');
  });

  it('jumps to the ends with Home and End', () => {
    const onChange = vi.fn();
    render(<Tabs label="Agent detail" items={items} activeId="runs" onChange={onChange} />);

    const runsTab = screen.getByRole('tab', { name: 'Runs' });
    fireEvent.keyDown(runsTab, { key: 'End' });
    expect(onChange).toHaveBeenCalledWith('audit');

    fireEvent.keyDown(runsTab, { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith('overview');
  });

  it('skips disabled tabs when navigating', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        label="Agent detail"
        items={[items[0]!, { id: 'runs', label: 'Runs', disabled: true }, items[2]!]}
        activeId="overview"
        onChange={onChange}
      />,
    );

    fireEvent.keyDown(screen.getAllByRole('tab')[0]!, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('audit');
  });

  it('shows only the active panel', () => {
    render(
      <>
        <TabPanel id="overview" activeId="overview">
          <p>Overview content</p>
        </TabPanel>
        <TabPanel id="runs" activeId="overview">
          <p>Runs content</p>
        </TabPanel>
      </>,
    );

    expect(screen.getByText('Overview content')).toBeInTheDocument();
    expect(screen.queryByText('Runs content')).not.toBeInTheDocument();
  });
});
