import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { departmentColour, departmentSkin, OrgChart, type OrgChartNode } from './OrgChart';

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
        {
          kind: 'person',
          id: 'user-2',
          name: 'Rajiv Mehta',
          subtitle: 'Head of Operations',
          photoUrl: 'http://localhost:4000/photos/user-2/content',
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
   * The band is no longer the department's colour — it is that colour at 16% over the card, so
   * what the initials sit on is a pale tint in Light and a deep one in Dark. Two backgrounds, two
   * inks, and the component cannot tell which one it is drawing on: it hands both to CSS as custom
   * properties and CSS chooses. So this asserts the node carries both, and that they differ, which
   * is the thing a single hardcoded ink could never do.
   */
  it('hands the card an ink for each theme rather than one fixed ink', () => {
    const { container } = render(<OrgChart root={tree} />);

    const dept = container.querySelector('.uboss-org-node--dept') as SVGGElement;
    const light = dept.style.getPropertyValue('--uboss-org-ink-l');
    const dark = dept.style.getPropertyValue('--uboss-org-ink-d');

    expect(light).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(light).not.toBe(dark);

    // And the initials draw whichever one CSS resolved, rather than a colour of their own.
    expect(textNode(container, 'QA').getAttribute('fill')).toBe('var(--uboss-org-ink)');
  });

  /*
   * Measured from the helper the component draws with, not from a list of colours, so it covers
   * the stepping loop as well — the part that exists because a palette entry that is legible on
   * one theme's tint is not automatically legible on the other's.
   *
   * This checks both themes, which the previous version could not: it read the band and the ink
   * off the rendered attributes, and only one theme's values were ever there to read.
   */
  it('clears 4.5:1 on both themes, for every colour the palette can produce', () => {
    const lin = (channel: number): number =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    const luminance = (hex: string): number => {
      const value = hex.replace('#', '');
      const at = (offset: number) =>
        lin(Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
      return 0.2126 * at(0) + 0.7152 * at(2) + 0.0722 * at(4);
    };
    const ratio = (a: string, b: string): number => {
      const x = luminance(a);
      const y = luminance(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };

    // The five the client named, plus enough unnamed ones to reach every entry of the fallback
    // palette the hash picks from.
    const names = [
      'Executive',
      'Regulatory Affairs',
      'Exports & Tenders',
      'Quality Assurance',
      'Production',
      'Finance',
      'General',
      'Customer Operations',
      'Management',
      'Operations',
      'Legal',
      'People',
      'Supply Chain',
    ];

    let checked = 0;
    for (const name of names) {
      const skin = departmentSkin(departmentColour(name));
      for (const [theme, pair] of Object.entries(skin)) {
        expect(ratio(pair.ink, pair.band), `${name} initials, ${theme}`).toBeGreaterThanOrEqual(
          4.5,
        );
        checked += 1;
      }
    }

    // A loop over nothing passes, so say how many there were meant to be: two themes each.
    expect(checked).toBe(names.length * 2);
  });

  /*
   * The one assumption the ink maths makes, held still.
   *
   * `departmentSkin` composites the band over the surface a card is drawn on, and it has to know
   * what that surface is — so it carries #ffffff and #171821 as literals. Both were read off the
   * running page before they were written down. But a literal copied out of a stylesheet is a
   * silent coupling: change `--uboss-surface` in tokens.css and every contrast figure above goes
   * on passing while being measured against a background that is no longer there.
   *
   * So the copy is checked against the original. If this fails, the fix is to update the two
   * literals in `departmentSkin` — not to relax this.
   */
  it('composites the band over the surface the theme actually uses', () => {
    const tokens = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8');

    // Light is the first declaration; Dark restates it, which is why both copies are checked.
    const declarations = [...tokens.matchAll(/^ *--uboss-surface: *([^;]+);/gm)].map((match) =>
      (match[1] ?? '').trim().toLowerCase(),
    );

    expect(declarations.length).toBeGreaterThanOrEqual(2);
    for (const value of declarations) {
      expect(['#fff', '#ffffff', '#171821']).toContain(value);
    }
    // Both ends must actually be present, or one theme could have quietly become the other.
    expect(declarations.some((value) => value === '#fff' || value === '#ffffff')).toBe(true);
    expect(declarations).toContain('#171821');
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
      <OrgChart
        root={tree}
        onAddToDepartment={onAddToDepartment}
        onEditDepartment={onEditDepartment}
      />,
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
    render(<OrgChart root={tree} onSelectPerson={onSelectPerson} onEditPerson={onEditPerson} />);

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

describe('OrgChart — taking something away', () => {
  /*
   * There is no delete in this product, and the wording is the point. A department is archived so
   * that past employment keeps resolving to a department that exists; a person is offboarded so
   * that their work, approvals and audit trail keep an owner. A control labelled Delete would be
   * describing something the server will not do.
   */
  it('offers Archive on a department, and calls back with its id', () => {
    const onArchiveDepartment = vi.fn();
    render(<OrgChart root={tree} onArchiveDepartment={onArchiveDepartment} />);

    const action = screen.getByRole('button', { name: 'Archive the Production department' });
    fireEvent.click(action);

    expect(onArchiveDepartment).toHaveBeenCalledWith('dept-prod');
    expect(screen.queryByRole('button', { name: /Delete/i })).not.toBeInTheDocument();
  });

  /*
   * Offboarding is not on the node any more, and this is the check that it stays off.
   *
   * It was never done here — the handler navigated to Settings → Users & Access — but it sat as a
   * third disc in a hover cluster, 6px from Edit, which is the arrangement that puts a
   * consequential act one slip away from an ordinary one. It lives on the person's own page now,
   * where there is room to say what it does before somebody does it.
   *
   * A person keeps two actions, both of which add: a direct report, and an edit.
   */
  it('offers nothing that takes a person away, whatever the caller passes', () => {
    const { container } = render(
      <OrgChart
        root={tree}
        onAddReport={vi.fn()}
        onEditPerson={vi.fn()}
        onSelectPerson={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Offboard/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove|Delete/i })).not.toBeInTheDocument();

    // Two, not three: the person's card has no third slot to mis-click into.
    const person = container.querySelector(
      '.uboss-org-node:not(.uboss-org-node--dept):not(.uboss-org-node--company)',
    );
    expect(person?.querySelectorAll('.uboss-org-action')).toHaveLength(2);
  });

  it('shows neither when the caller did not pass the handler', () => {
    render(<OrgChart root={tree} onEditDepartment={vi.fn()} onEditPerson={vi.fn()} />);

    // A control that cannot act should not be on the node at all, disabled or otherwise.
    expect(screen.queryByRole('button', { name: /Archive/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Offboard/i })).not.toBeInTheDocument();
  });

  /*
   * The gap is the safeguard, so it is the thing to assert. Colour is not: the archive disc is
   * grey until the pointer is on it, which is deliberate, and a test that looked for red would be
   * asserting the arrangement this change was made to get rid of.
   */
  it('puts more air before the archive action than between the two that build', () => {
    const { container } = render(
      <OrgChart
        root={tree}
        onAddToDepartment={vi.fn()}
        onEditDepartment={vi.fn()}
        onArchiveDepartment={vi.fn()}
      />,
    );

    const dept = container.querySelector('.uboss-org-node--dept') as SVGGElement;
    const centres = [...dept.querySelectorAll('.uboss-org-action circle')]
      .map((circle) => Number(circle.getAttribute('cx')))
      .sort((a, b) => a - b);

    expect(centres).toHaveLength(3);
    const buildGap = (centres[1] as number) - (centres[0] as number);
    const archiveGap = (centres[2] as number) - (centres[1] as number);
    expect(archiveGap).toBeGreaterThan(buildGap);
  });

  it('keeps every name inside the card once a third action is there', () => {
    const { container } = render(
      <OrgChart
        root={tree}
        onAddToDepartment={vi.fn()}
        onEditDepartment={vi.fn()}
        onArchiveDepartment={vi.fn()}
      />,
    );

    // "Quality Assurance" is 17 characters and the longest name in this fixture; the lane grows
    // with the number of actions, so this is the check that the card grew with it.
    const names = [...container.querySelectorAll('text')].map((node) => node.textContent ?? '');
    expect(names).toContain('Quality Assurance');
    expect(names.some((name) => name.endsWith('…'))).toBe(false);
  });
});

describe('OrgChart — a person’s avatar', () => {
  it('draws the photograph when there is one', () => {
    const { container } = render(<OrgChart root={tree} />);

    const images = [...container.querySelectorAll('image')];
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute('href')).toBe('http://localhost:4000/photos/user-2/content');
    // Fill the disc and crop, rather than squashing a portrait into a square.
    expect(images[0]?.getAttribute('preserveAspectRatio')).toBe('xMidYMid slice');
  });

  it('draws a silhouette, and no image, for somebody without one', () => {
    const only = {
      ...tree,
      children: [{ ...tree.children[0]!, children: [tree.children[0]!.children[0]!] }],
    };
    const { container } = render(<OrgChart root={only} />);

    expect(container.querySelectorAll('image')).toHaveLength(0);
    // The disc plus a head and shoulders: the person node contributes three circles beyond the
    // ring, and a department contributes none.
    expect(container.querySelectorAll('circle').length).toBeGreaterThanOrEqual(4);
  });

  /*
   * The silhouette is drawn for everybody, including people who have a photo, and the photo goes
   * on top. So a photo that 404s, or has not cleared its scan, or is blocked by the browser leaves
   * a sensible avatar behind instead of a broken-image glyph — and no error handling is needed to
   * achieve it. This is the assertion that keeps somebody from "tidying up" that duplication.
   */
  it('keeps the silhouette underneath the photograph', () => {
    const { container } = render(<OrgChart root={tree} />);

    const withPhoto = [...container.querySelectorAll('g[role="treeitem"]')].find((group) =>
      (group.getAttribute('aria-label') ?? '').startsWith('Rajiv Mehta'),
    );
    expect(withPhoto).toBeDefined();
    expect(withPhoto?.querySelector('image')).not.toBeNull();
    // Head, shoulders, disc and ring are all still there behind it.
    expect(withPhoto?.querySelectorAll('circle').length).toBeGreaterThanOrEqual(4);
  });

  it('scopes the clip path per chart, so two charts cannot share one', () => {
    const { container: first } = render(<OrgChart root={tree} />);
    const { container: second } = render(<OrgChart root={tree} />);

    const idOf = (root: HTMLElement) => root.querySelector('clipPath')?.getAttribute('id') ?? '';
    expect(idOf(first)).not.toBe('');
    expect(idOf(first)).not.toBe(idOf(second));
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

/*
 * The frame.
 *
 * jsdom has no layout, so zoom, Fit and full screen are proved in a real browser rather than here
 * — apps/web/tmp/org-frame.mjs measures the scale actually applied, that Fit puts the whole
 * drawing inside the frame, and that a drag pans while a press still opens a card.
 *
 * What is held here is what a browser proof is a clumsy way to hold: that the frame is the
 * caller's decision rather than the chart's, and that the controls a keyboard has to reach are
 * named. Both are the kind of thing that breaks silently — a chart that stops offering zoom, or a
 * button whose label was only ever a tooltip.
 */
describe('OrgChart — the frame', () => {
  it('renders no frame and no controls unless the caller asks for them', () => {
    const { container } = render(<OrgChart root={tree} />);
    expect(container.querySelector('.uboss-org-tools')).toBeNull();
    expect(container.querySelector('.uboss-org-frame')).toBeNull();
    // The chart itself is untouched: it is still a chart in the flow of the page.
    expect(container.querySelector('.uboss-org svg')).not.toBeNull();
  });

  it('gives the frame five named controls, so none of them is a tooltip only', () => {
    render(<OrgChart root={tree} controls />);
    for (const label of ['Zoom out', 'Zoom in', 'Fit the whole chart', 'Full screen']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    // The readout says what it is and what pressing it does, because its own text says neither.
    expect(screen.getByLabelText(/Zoom is 100 per cent\. Reset to 100 per cent/)).toBeTruthy();
  });

  it('opens at 100%, the size the cards were drawn to be read at', () => {
    const { container } = render(<OrgChart root={tree} controls />);
    expect(container.querySelector('.uboss-org-zoom')?.textContent).toBe('100%');
  });

  it('cannot zoom out below the readable floor by pressing minus', () => {
    const { container } = render(<OrgChart root={tree} controls />);
    const out = screen.getByLabelText('Zoom out');
    for (let press = 0; press < 12; press += 1) fireEvent.click(out);
    expect(container.querySelector('.uboss-org-zoom')?.textContent).toBe('40%');
    expect((out as HTMLButtonElement).disabled).toBe(true);
  });

  it('cannot zoom in past the ceiling either', () => {
    const { container } = render(<OrgChart root={tree} controls />);
    const into = screen.getByLabelText('Zoom in');
    for (let press = 0; press < 12; press += 1) fireEvent.click(into);
    expect(container.querySelector('.uboss-org-zoom')?.textContent).toBe('200%');
    expect((into as HTMLButtonElement).disabled).toBe(true);
  });

  it('resets when the readout is pressed', () => {
    const { container } = render(<OrgChart root={tree} controls />);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(container.querySelector('.uboss-org-zoom')?.textContent).not.toBe('100%');
    fireEvent.click(container.querySelector('.uboss-org-zoom') as HTMLElement);
    expect(container.querySelector('.uboss-org-zoom')?.textContent).toBe('100%');
  });

  /*
   * Zoom and pan are the only way to reach part of a chart wider than the window, so a reader who
   * cannot use a pointer would otherwise see one corner of their own company and no way past it.
   */
  it('zooms and pans from the keyboard, and says so', () => {
    const { container } = render(<OrgChart root={tree} controls />);
    const frame = container.querySelector('.uboss-org-frame') as HTMLElement;
    expect(frame.getAttribute('tabindex')).toBe('0');
    expect(frame.getAttribute('aria-label')).toContain('Plus and minus zoom');

    fireEvent.keyDown(frame, { key: '+' });
    expect(container.querySelector('.uboss-org-zoom')?.textContent).toBe('120%');
    fireEvent.keyDown(frame, { key: '0' });
    expect(container.querySelector('.uboss-org-zoom')?.textContent).toBe('100%');

    const stage = container.querySelector('.uboss-org-stage') as HTMLElement;
    fireEvent.keyDown(frame, { key: 'ArrowRight' });
    expect(stage.style.transform).toContain('-60px');
  });

  it('presses a card rather than panning when the pointer did not move', () => {
    const onSelectPerson = vi.fn();
    const { container } = render(<OrgChart root={tree} controls onSelectPerson={onSelectPerson} />);
    const frame = container.querySelector('.uboss-org-frame') as HTMLElement;
    const card = screen.getByLabelText('Rajiv Mehta. Head of Operations');

    fireEvent.pointerDown(frame, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(frame, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.click(card);

    expect(onSelectPerson).toHaveBeenCalledWith('user-2');
  });
  /*
   * A new company's first screen.
   *
   * The empty message used to be returned **instead of** the chart, so a company with no
   * departments — which is every company on its first day — showed a sentence where its own card
   * should have been. The administrator who had just been given the workspace opened Hierarchy
   * and found it blank. The card is what says the workspace is theirs; the message is a hint
   * about what to do next, and a hint does not replace the thing it is about.
   */
  describe('a company with nothing in it yet', () => {
    const brandNew: OrgChartNode = {
      kind: 'company',
      id: 'company-1',
      name: 'SPM Medicare',
      subtitle: 'Company · 0 departments',
      children: [],
    };

    it('still draws the company card, with the hint underneath', () => {
      const { container } = render(
        <OrgChart root={brandNew} controls emptyMessage="No employees recorded yet." />,
      );

      expect(screen.getByLabelText('SPM Medicare. Company · 0 departments')).toBeTruthy();
      expect(container.querySelector('.uboss-org-empty')?.textContent).toBe(
        'No employees recorded yet.',
      );
    });

    it('draws it without the frame too', () => {
      render(<OrgChart root={brandNew} emptyMessage="No employees recorded yet." />);
      expect(screen.getByLabelText('SPM Medicare. Company · 0 departments')).toBeTruthy();
    });

    it('draws the departments when they exist but hold nobody', () => {
      const departmentsOnly: OrgChartNode = {
        ...brandNew,
        subtitle: 'Company · 1 department',
        children: [
          {
            kind: 'department',
            id: 'dept-ops',
            name: 'Operations',
            subtitle: 'Department · 0 people',
            children: [],
          },
        ],
      };

      render(
        <OrgChart root={departmentsOnly} controls emptyMessage="No employees recorded yet." />,
      );

      expect(screen.getByLabelText('SPM Medicare. Company · 1 department')).toBeTruthy();
      expect(screen.getByLabelText('Operations. Department · 0 people')).toBeTruthy();
    });
  });
});

/*
 * The layout itself, which until a real company arrived had only ever been looked at.
 *
 * Read off the rendered SVG rather than from the layout function, because the layout function is
 * not exported and the thing that matters is where a card actually lands.
 */
describe('OrgChart — a manager with more reports than fit across', () => {
  const reports = (count: number, from = 1): OrgChartNode[] =>
    Array.from({ length: count }, (_, index) => ({
      kind: 'person' as const,
      id: `report-${from + index}`,
      name: `Report ${from + index}`,
      subtitle: 'Operator',
      children: [],
    }));

  const underOneManager = (count: number): OrgChartNode => ({
    kind: 'company',
    id: 'company-1',
    name: 'SPM Medicare',
    subtitle: `Company · ${count} people`,
    children: [
      {
        kind: 'person',
        id: 'manager-1',
        name: 'Karan Singh',
        subtitle: 'Production Head',
        children: reports(count),
      },
    ],
  });

  /**
   * Where each card sits, by the name on it.
   *
   * Taken from the name's own `<text>`, because a card is drawn from absolute coordinates rather
   * than moved by a transform. Every person's card puts that text at the same offset inside it, so
   * comparing one person's to another's compares the cards.
   */
  const cards = (container: HTMLElement): Map<string, { x: number; y: number }> => {
    const found = new Map<string, { x: number; y: number }>();
    for (const group of container.querySelectorAll('g[role="treeitem"][aria-label]')) {
      const label = (group.getAttribute('aria-label') ?? '').split('.')[0]!.trim();
      const text = group.querySelector('text');
      if (text) {
        found.set(label, {
          x: Number(text.getAttribute('x')),
          y: Number(text.getAttribute('y')),
        });
      }
    }
    return found;
  };

  const chartWidth = (container: HTMLElement): number =>
    Number(container.querySelector('svg')!.getAttribute('width'));

  it('still spreads three reports across, because a row of three reads as a tree', () => {
    const { container } = render(<OrgChart root={underOneManager(3)} />);
    const placed = cards(container);

    const ys = [1, 2, 3].map((n) => placed.get(`Report ${n}`)!.y);
    expect(new Set(ys).size).toBe(1);
  });

  it('hangs four reports down one column instead of across', () => {
    const { container } = render(<OrgChart root={underOneManager(4)} />);
    const placed = cards(container);

    const xs = [1, 2, 3, 4].map((n) => placed.get(`Report ${n}`)!.x);
    const ys = [1, 2, 3, 4].map((n) => placed.get(`Report ${n}`)!.y);

    expect(new Set(xs).size).toBe(1);
    expect(new Set(ys).size).toBe(4);
    // In the order they were given, which is the order the list was read in.
    expect([...ys]).toEqual([...ys].sort((a, b) => a - b));
  });

  it('wraps a large block into columns rather than one very tall one', () => {
    const { container } = render(<OrgChart root={underOneManager(49)} />);
    // A company this size arrives folded, so the block has to be asked for before it can be
    // measured — see the fold tests below.
    fireEvent.click(screen.getByLabelText('Show the 49 under Karan Singh'));
    const placed = cards(container);

    const all = Array.from({ length: 49 }, (_, index) => placed.get(`Report ${index + 1}`)!);
    const columns = new Set(all.map((card) => card.x));
    const rows = new Set(all.map((card) => card.y));

    expect(columns.size).toBe(5);
    expect(rows.size).toBe(10);
  });

  it('keeps forty-nine reports inside a chart a screen can fit', () => {
    const { container } = render(<OrgChart root={underOneManager(49)} />);
    fireEvent.click(screen.getByLabelText('Show the 49 under Karan Singh'));

    // Side by side these were 49 columns — over 18,000px, which fitted at eight percent and
    // turned every name into a smear. The block is a fraction of that, open.
    expect(chartWidth(container)).toBeLessThan(2400);
  });

  describe('and the company that arrives folded', () => {
    it('draws a small company whole, with nothing to unfold', () => {
      const { container } = render(<OrgChart root={underOneManager(6)} />);

      // The company, the manager and all six.
      expect(cards(container).size).toBe(8);
      // The manager still offers to put them away; nothing is folded to begin with.
      expect(screen.getByLabelText('Hide the 6 under Karan Singh')).toBeTruthy();
    });

    it('opens a large company at its first level instead of at eight per cent', () => {
      const { container } = render(<OrgChart root={underOneManager(49)} />);

      // The manager's card is there and says how many are behind it; the forty-nine are not
      // drawn until somebody asks, which is what keeps the first screen readable.
      expect(cards(container).has('Karan Singh')).toBe(true);
      expect(cards(container).has('Report 1')).toBe(false);
      expect(screen.getByLabelText('Show the 49 under Karan Singh')).toBeTruthy();
    });

    it('opens and closes on the toggle, and says which it is doing', () => {
      const { container } = render(<OrgChart root={underOneManager(49)} />);

      fireEvent.click(screen.getByLabelText('Show the 49 under Karan Singh'));
      expect(cards(container).has('Report 1')).toBe(true);

      fireEvent.click(screen.getByLabelText('Hide the 49 under Karan Singh'));
      expect(cards(container).has('Report 1')).toBe(false);
    });

    it('opens from the keyboard, since the chart is reached by one', () => {
      const { container } = render(<OrgChart root={underOneManager(49)} />);

      fireEvent.keyDown(screen.getByLabelText('Show the 49 under Karan Singh'), { key: 'Enter' });
      expect(cards(container).has('Report 1')).toBe(true);
    });

    it('tells a screen reader which cards have something behind them', () => {
      const { container } = render(<OrgChart root={underOneManager(49)} />);

      const manager = [...container.querySelectorAll('g[role="treeitem"]')].find((group) =>
        (group.getAttribute('aria-label') ?? '').startsWith('Karan Singh'),
      );
      expect(manager!.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(screen.getByLabelText('Show the 49 under Karan Singh'));
      expect(
        [...container.querySelectorAll('g[role="treeitem"]')]
          .find((group) => (group.getAttribute('aria-label') ?? '').startsWith('Karan Singh'))!
          .getAttribute('aria-expanded'),
      ).toBe('true');
    });

    it('leaves a leaf without the attribute, having nothing to open', () => {
      const { container } = render(<OrgChart root={underOneManager(6)} />);

      const leaf = [...container.querySelectorAll('g[role="treeitem"]')].find((group) =>
        (group.getAttribute('aria-label') ?? '').startsWith('Report 1'),
      );
      expect(leaf!.hasAttribute('aria-expanded')).toBe(false);
    });
  });

  it('leaves a branch its own width while the leaves beside it stack', () => {
    const mixed: OrgChartNode = {
      kind: 'company',
      id: 'company-1',
      name: 'SPM Medicare',
      subtitle: 'Company · 9 people',
      children: [
        {
          kind: 'person',
          id: 'manager-1',
          name: 'Karan Singh',
          subtitle: 'Production Head',
          children: [
            ...reports(6),
            {
              kind: 'person',
              id: 'supervisor-1',
              name: 'Lokesh Kumar',
              subtitle: 'Supervisor',
              children: reports(2, 7),
            },
          ],
        },
      ],
    };

    const { container } = render(<OrgChart root={mixed} />);
    const placed = cards(container);

    // The six stack; the supervisor keeps an ordinary subtree beside them, with their own two
    // spread across underneath.
    expect(new Set([1, 2, 3, 4, 5, 6].map((n) => placed.get(`Report ${n}`)!.x)).size).toBe(2);
    expect(placed.get('Report 7')!.y).toBe(placed.get('Report 8')!.y);
    expect(placed.get('Lokesh Kumar')!.y).toBeLessThan(placed.get('Report 7')!.y);
  });
});
