import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { OrgChart, type OrgChartNode } from './OrgChart';

/*
 * The chart had no tests, and two of the things it got wrong were the kind only a test holds
 * still: text drawn in a colour that cannot be read on the surface under it, and actions that are
 * hidden by CSS and therefore easy to hide from the keyboard as well.
 */

/** Two departments chosen for their colours: one light green, one mid violet. */
const tree: OrgChartNode = {
  kind: 'company',
  id: 'company-1',
  name: 'Aarohan Healthcare',
  subtitle: 'Company · 2 departments',
  children: [
    {
      kind: 'department',
      id: 'dept-qa',
      name: 'Quality Assurance',
      subtitle: 'Department · 1 person',
      children: [
        {
          kind: 'person',
          id: 'user-1',
          name: 'Kavya Nair',
          subtitle: 'Operations Associate',
          children: [],
        },
      ],
    },
    {
      kind: 'department',
      id: 'dept-prod',
      name: 'Production',
      subtitle: 'Department · 0 people',
      children: [],
    },
  ],
};

/** The `<text>` whose content is exactly this, anywhere in the chart. */
const textNode = (container: HTMLElement, content: string): SVGTextElement => {
  const found = [...container.querySelectorAll('text')].find(
    (node) => (node.textContent ?? '').trim() === content,
  );
  if (found === undefined) throw new Error(`no text node reads "${content}"`);
  return found as unknown as SVGTextElement;
};

describe('OrgChart — text on a surface that does not follow the theme', () => {
  /*
   * The reported bug. The company card is navy in both themes, and its name was drawn in
   * `var(--uboss-surface)` — #fff in Light, #171821 in Dark — which measured 1.12:1 on the dark
   * navy. A token here is the defect, whatever its current value, so that is what is asserted.
   */
  it('draws the company name in a fixed light ink, not a theme token', () => {
    const { container } = render(<OrgChart root={tree} />);

    const fill = textNode(container, 'Aarohan Healthcare').getAttribute('fill');
    expect(fill).toBe('#f8fafc');
    expect(fill).not.toContain('var(');
  });

  it('draws the company subtitle in a fixed ink too', () => {
    const { container } = render(<OrgChart root={tree} />);

    expect(textNode(container, 'Company · 2 departments').getAttribute('fill')).not.toContain(
      'var(',
    );
  });

  /*
   * A department's colour is its identity and does not change with the theme, so the initials on
   * it must not either — and a single fixed choice cannot serve the whole palette. Light ink on
   * #4B9C2E measured 3.45:1; dark ink on #7A5AF8 is no better. The two cases below are the two
   * ends of that, and they must come out differently.
   */
  it('puts dark ink on a light department colour and light ink on a dark one', () => {
    const { container } = render(<OrgChart root={tree} />);

    // Quality Assurance is #4B9C2E, Production is #7A5AF8.
    expect(textNode(container, 'QA').getAttribute('fill')).toBe('#0b1220');
    expect(textNode(container, 'PR').getAttribute('fill')).toBe('#f8fafc');
  });

  /*
   * Read off the render rather than from a list of colours, so this covers whatever the component
   * actually drew — including the deepening step, which exists because one palette entry could not
   * carry a label at any ink. A hard-coded pair would have gone on passing after that broke.
   */
  it('clears 4.5:1 for every initial it draws, whatever the colour', () => {
    const { container } = render(<OrgChart root={tree} />);

    const lin = (channel: number): number =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    const luminance = (hex: string): number => {
      const value = hex.replace('#', '');
      const at = (offset: number) => lin(Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
      return 0.2126 * at(0) + 0.7152 * at(2) + 0.0722 * at(4);
    };

    let checked = 0;
    for (const item of container.querySelectorAll('g[role="treeitem"]')) {
      // The band is the card rect; the initials are the first text in the group.
      const band = item.querySelector('.uboss-org-card')?.getAttribute('fill') ?? '';
      const ink = item.querySelector('text')?.getAttribute('fill') ?? '';
      // The company band is a gradient reference, and its inks are asserted above.
      if (!band.startsWith('#') || !ink.startsWith('#')) continue;

      const a = luminance(ink);
      const b = luminance(band);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      expect(ratio, `${item.querySelector('text')?.textContent} on ${band}`).toBeGreaterThanOrEqual(
        4.5,
      );
      checked += 1;
    }

    // A loop over nothing passes, so say how many there were meant to be.
    expect(checked).toBe(3);
  });
});

describe('OrgChart — node actions', () => {
  it('renders nothing on a node whose handlers were not passed', () => {
    render(<OrgChart root={tree} />);

    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add/ })).not.toBeInTheDocument();
  });

  it('gives a department both an add and an edit action', () => {
    const onAddToDepartment = vi.fn();
    const onEditDepartment = vi.fn();
    render(
      <OrgChart root={tree} onAddToDepartment={onAddToDepartment} onEditDepartment={onEditDepartment} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add somebody to Production' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Production department' }));

    expect(onAddToDepartment).toHaveBeenCalledWith('dept-prod');
    expect(onEditDepartment).toHaveBeenCalledWith('dept-prod');
  });

  it('gives a person an add-report and an edit action', () => {
    const onAddReport = vi.fn();
    const onEditPerson = vi.fn();
    render(<OrgChart root={tree} onAddReport={onAddReport} onEditPerson={onEditPerson} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add a direct report to Kavya Nair' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Kavya Nair' }));

    expect(onAddReport).toHaveBeenCalledWith('user-1');
    expect(onEditPerson).toHaveBeenCalledWith('user-1');
  });

  /*
   * The node itself navigates to the person, so an action inside it has to stop the click from
   * reaching the node. Without this, pressing Edit would open the form and navigate away from it.
   */
  it('does not select the person when one of their actions is pressed', () => {
    const onSelectPerson = vi.fn();
    const onEditPerson = vi.fn();
    render(
      <OrgChart root={tree} onSelectPerson={onSelectPerson} onEditPerson={onEditPerson} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit Kavya Nair' }));

    expect(onEditPerson).toHaveBeenCalledWith('user-1');
    expect(onSelectPerson).not.toHaveBeenCalled();
  });

  it('activates an action from the keyboard, since hover is not available to one', () => {
    const onEditDepartment = vi.fn();
    render(<OrgChart root={tree} onEditDepartment={onEditDepartment} />);

    const action = screen.getByRole('button', { name: 'Edit the Production department' });
    expect(action).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(action, { key: 'Enter' });
    fireEvent.keyDown(action, { key: ' ' });

    expect(onEditDepartment).toHaveBeenCalledTimes(2);
  });
});

/*
 * The reveal itself is CSS, which jsdom will not compute for an SVG group, so these read the
 * stylesheet. That is worth doing for one specific reason: "hidden until hover" is one rule away
 * from "unreachable without a mouse", and one more away from leaving an invisible button that
 * still accepts clicks over every card.
 */
describe('OrgChart — the hover-only reveal, as declared', () => {
  const css = readFileSync(join(process.cwd(), 'src/styles/components.css'), 'utf8');

  /** The body of the first rule whose selector list contains this selector. */
  const ruleFor = (selector: string): string => {
    const index = css.indexOf(selector);
    if (index < 0) throw new Error(`no rule mentions ${selector}`);
    const open = css.indexOf('{', index);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
  };

  it('starts hidden, and takes no pointer while it is', () => {
    const rule = ruleFor('.uboss-org-actions {');
    expect(rule).toContain('opacity: 0');
    // A group at zero opacity still accepts a click. One of these opens a form.
    expect(rule).toContain('pointer-events: none');
  });

  it('reveals on focus as well as hover, so a keyboard can reach it', () => {
    expect(css).toContain('.uboss-org-node:focus-within .uboss-org-actions');
    const rule = ruleFor('.uboss-org-node:hover .uboss-org-actions,');
    expect(rule).toContain('opacity: 1');
    expect(rule).toContain('pointer-events: auto');
  });

  it('carries the dark glow in both routes to the theme', () => {
    // tokens.css keeps two copies of the dark theme and one of them is always the one somebody
    // forgets, so the count is the assertion.
    const matches = css.match(/drop-shadow\(0 0 12px rgba\(167, 139, 250, 0\.55\)\)/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it('declares the same shape of filter list at rest and on hover, so the glow eases in', () => {
    // `filter` interpolates only between lists of matching length and order. Without the resting
    // zero-blur shadow the hover would snap from one function to two.
    expect(ruleFor('.uboss-org-node .uboss-org-card {')).toContain('drop-shadow(0 0 0');
  });

  it('drops the movement under reduced motion without dropping the reveal', () => {
    const reduced = css.slice(css.indexOf('.uboss-org-node,'));
    expect(reduced.slice(0, 400)).toContain('transition: none');
    // The lift goes; the border and the glow still say which card is under the pointer.
    expect(reduced.slice(0, 700)).toContain('transform: none');
  });
});
