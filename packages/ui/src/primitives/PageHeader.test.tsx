import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PageNameShownAboveContext } from '../lib/page-name-context';
import { PageHeader } from './PageHeader';

/*
 * The screens stopped saying their own name twice.
 *
 * Inside an application shell the top bar names the section, so this component drops its trail,
 * its title and its description and keeps only the page's actions. Outside a shell — the internal
 * platform screens have none — it is unchanged, because there is nothing else naming the page.
 *
 * Both halves are tested. Only testing the suppressed case would leave "the heading disappears
 * everywhere" passing, and that is the mistake this arrangement exists to prevent.
 */

const insideShell = (node: React.ReactNode) =>
  render(
    <PageNameShownAboveContext.Provider value={true}>{node}</PageNameShownAboveContext.Provider>,
  );

describe('PageHeader — outside a shell, nothing changed', () => {
  it('renders the trail, the heading and the description', () => {
    render(
      <PageHeader
        title="Organization Hierarchy"
        description="Reporting structure and company identity."
        breadcrumbs={[{ label: 'Hierarchy' }]}
      />,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Organization Hierarchy');
    expect(screen.getByText('Reporting structure and company identity.')).toBeInTheDocument();
    expect(screen.getByText('Hierarchy')).toBeInTheDocument();
  });

  it('keeps its actions beside the heading', () => {
    render(
      <PageHeader title="Notifications" actions={<button type="button">Mark all read</button>} />,
    );

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeInTheDocument();
  });
});

describe('PageHeader — inside a shell, the text is not repeated', () => {
  it('renders no heading, no description and no trail', () => {
    insideShell(
      <PageHeader
        title="Organization Hierarchy"
        description="Reporting structure and company identity."
        breadcrumbs={[{ label: 'Hierarchy' }]}
      />,
    );

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText('Reporting structure and company identity.')).not.toBeInTheDocument();
    expect(screen.queryByText('Hierarchy')).not.toBeInTheDocument();
    expect(screen.queryByText('Organization Hierarchy')).not.toBeInTheDocument();
  });

  it('still renders the page actions, which are not duplicated anywhere', () => {
    insideShell(
      <PageHeader title="Notifications" actions={<button type="button">Mark all read</button>} />,
    );

    // The bar names the section; it does not carry the screen's controls. Losing these with the
    // title would have taken "Mark all read", "Add Employee" and every other page action with it.
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeInTheDocument();
  });

  it('renders nothing at all when there were no actions', () => {
    const { container } = insideShell(<PageHeader title="Dashboard" />);

    // Not an empty wrapper: that would keep the page-head margin and leave a gap above the first
    // card on every screen without actions, which is most of them.
    expect(container).toBeEmptyDOMElement();
  });
});
