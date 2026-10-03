import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PageHeader } from '../primitives/PageHeader';
import { COMPANY_NAV, MASTER_NAV, SETTINGS_SECTIONS } from '../navigation/navigation-model';
import { AppShell } from './AppShell';
import { LoginPresentation, NoPublicSignupNotice } from './LoginPresentation';
import { SettingsShell } from './SettingsShell';
import { TopBar } from './TopBar';

const user = { name: 'Priya Nair', role: 'Company Admin' };

describe('TopBar — the workspace header', () => {
  /*
   * This used to assert 'UBOSS AI AMS | {Active Workspace Name}', which was a locked rule from
   * the approved reference. The client replaced the product name in this slot with the name of
   * the section, because every screen was saying its own name twice — here, and again in the
   * heading directly below it. The workspace name is unchanged, and the product name still
   * appears in the sidebar's header, which a test further down this file covers.
   */
  it('shows {Section} | {Active Workspace Name} on company screens', () => {
    const { container } = render(
      <TopBar variant="company" sectionName="Hierarchy" workspaceName="SPM Medicare" />,
    );

    const mark = container.querySelector('.uboss-ws-mark');
    expect(mark).toBeInTheDocument();
    // Visible spacing around the pipe comes from the flex gap, so assert the format and order
    // rather than literal whitespace in textContent.
    expect(mark?.textContent?.trim()).toMatch(/^Hierarchy\s*\|\s*SPM Medicare$/);
    expect(mark?.textContent).not.toContain('UBOSS AI AMS');
  });

  it('makes the section name the page heading, because the page no longer has one', () => {
    render(<TopBar variant="company" sectionName="Agent Builder" workspaceName="SPM Medicare" />);

    // Exactly one, and it is the section. Moving the name up into the bar would otherwise leave
    // every screen in the product with no top-level heading at all.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Agent Builder');
  });

  it('shows the workspace alone, with no stray pipe, when the section is unknown', () => {
    const { container } = render(<TopBar variant="company" workspaceName="SPM Medicare" />);

    // A real state: an active key that matches no navigation item. The bar must not render a
    // dangling separator, and the screen keeps its own heading — see the PageHeader tests.
    const mark = container.querySelector('.uboss-ws-mark');
    expect(mark?.textContent?.trim()).toBe('SPM Medicare');
    expect(container.querySelector('.uboss-ws-mark-pipe')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('resolves the workspace name from context rather than hard-coding it', () => {
    const { container } = render(<TopBar variant="company" workspaceName="Northwind Devices" />);

    expect(container.querySelector('.uboss-ws-mark-name')).toHaveTextContent('Northwind Devices');
    expect(screen.queryByText('SPM Medicare')).not.toBeInTheDocument();
  });

  it('shows the platform identity on the Master Console, not a tenant name', () => {
    render(<TopBar variant="master" />);

    expect(screen.getByText('UBoss Master Console')).toBeInTheDocument();
    expect(screen.queryByText(/UBOSS AI AMS/)).not.toBeInTheDocument();
  });

  it('names the section on the Master Console too, in place of the console label', () => {
    render(<TopBar variant="master" sectionName="Companies" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Companies');
    // The console's own name is in its sidebar. Repeating it here would be exactly the
    // duplication the company bar has just stopped doing.
    expect(screen.queryByText('UBoss Master Console')).not.toBeInTheDocument();
  });

  it('offers a sign-out control and the signed-in avatar, as the reference does', () => {
    const onSignOut = vi.fn();
    render(
      <TopBar
        variant="company"
        workspaceName="SPM Medicare"
        user={{ name: 'Priya Nair', role: 'Company Admin' }}
        onSignOut={onSignOut}
      />,
    );

    // The avatar is the account control, announced as the person and as a menu.
    const trigger = screen.getByRole('button', { name: /Priya Nair — account menu/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('PN')).toBeInTheDocument();

    // Sign out is not on the bar. It used to be a key icon next to the notification bell.
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('menuitem', { name: /Sign out/ }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('omits the account menu entirely when there is nobody signed in', () => {
    render(<TopBar variant="company" workspaceName="SPM Medicare" />);

    expect(screen.queryByRole('button', { name: /account menu/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Sign out/ })).not.toBeInTheDocument();
  });

  it('offers only what the host supplies, with sign out separated and last', () => {
    render(
      <TopBar
        variant="company"
        workspaceName="SPM Medicare"
        user={{ name: 'Priya Nair', role: 'Company Admin' }}
        scopeLabel="Company Admin · Whole company"
        accountMenu={[
          { key: 'settings', label: 'Settings', onSelect: () => {} },
          { key: 'appearance', label: 'Appearance', onSelect: () => {} },
        ]}
        onSignOut={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /account menu/ }));

    // Exactly what was passed, plus sign out — nothing invented in the component.
    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim());
    expect(labels).toEqual(['Settings', 'Appearance', 'Sign out']);

    // Sign out last, and below the rule that separates it.
    const signOut = screen.getByRole('menuitem', { name: /Sign out/ });
    expect(signOut.parentElement).toHaveClass('uboss-account-separated');

    // The menu states who is about to act, in the menu itself. The scope also appears on the
    // bar's pill, so the assertion is scoped rather than global — and the workspace is not
    // repeated here at all, because the header beside it already names it.
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Priya Nair')).toBeInTheDocument();
    expect(within(menu).getByText('Company Admin · Whole company')).toBeInTheDocument();
    expect(within(menu).queryByText('SPM Medicare')).not.toBeInTheDocument();
  });

  it('closes on Escape and gives focus back to the avatar', () => {
    render(
      <TopBar
        variant="company"
        workspaceName="SPM Medicare"
        user={{ name: 'Priya Nair', role: 'Company Admin' }}
        onSignOut={() => {}}
      />,
    );

    const trigger = screen.getByRole('button', { name: /account menu/ });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // Returning focus is the half that is usually forgotten: without it the keyboard lands back
    // at the top of the document.
    expect(trigger).toHaveFocus();
  });

  it('walks the items with the arrow keys', () => {
    render(
      <TopBar
        variant="company"
        workspaceName="SPM Medicare"
        user={{ name: 'Priya Nair', role: 'Company Admin' }}
        accountMenu={[
          { key: 'a', label: 'Settings', onSelect: () => {} },
          { key: 'b', label: 'Appearance', onSelect: () => {} },
        ]}
        onSignOut={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /account menu/ }));

    // Opening focuses the first item, as a menu is expected to.
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();

    fireEvent.keyDown(items[1]!, { key: 'End' });
    expect(items[items.length - 1]).toHaveFocus();

    fireEvent.keyDown(items[items.length - 1]!, { key: 'ArrowDown' });
    expect(items[0]).toHaveFocus();
  });

  it('renders the role and scope pill when supplied', () => {
    render(
      <TopBar
        variant="company"
        workspaceName="SPM Medicare"
        scopeLabel="Manager · Team / subtree"
      />,
    );

    expect(screen.getByText(/Manager · Team \/ subtree/)).toBeInTheDocument();
  });
});

describe('AppShell — the section names itself once', () => {
  /*
   * The bar takes the name from the navigation item matching `activeKey`, which is the same thing
   * that highlights the sidebar. One source, so the bar and the sidebar cannot come to disagree,
   * and the name is the short one a person recognises: the sidebar says "Hierarchy" where the
   * screen's own heading used to say "Organization Hierarchy".
   */
  it('takes the top bar heading from the active navigation item', () => {
    render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        activeKey="agent-builder"
        user={user}
      >
        <p>Builder content</p>
      </AppShell>,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Agent Builder');
  });

  it('suppresses the page heading below it, leaving exactly one name on the screen', () => {
    render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        activeKey="hierarchy"
        user={user}
      >
        <PageHeader
          title="Organization Hierarchy"
          description="Reporting structure and company identity."
          breadcrumbs={[{ label: 'Hierarchy' }]}
        />
        <p>Tree</p>
      </AppShell>,
    );

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Hierarchy');
    expect(screen.queryByText('Organization Hierarchy')).not.toBeInTheDocument();
    expect(screen.queryByText('Reporting structure and company identity.')).not.toBeInTheDocument();
  });

  it('lets a screen that is not a navigation entry name itself', () => {
    render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        // Notifications is reached from the bell and borrows Dashboard's key for the sidebar.
        activeKey="dashboard"
        sectionLabel="Notifications"
        user={user}
      >
        <p>Notifications content</p>
      </AppShell>,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Notifications');
  });

  it('leaves the page its own heading when the section cannot be worked out', () => {
    render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        activeKey="a-key-that-no-longer-exists"
        user={user}
      >
        <PageHeader title="Something" breadcrumbs={[{ label: 'Somewhere' }]} />
      </AppShell>,
    );

    // Nothing is nameless. The bar has no name to show, so the screen keeps the one it has.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Something');
  });
});

describe('AppShell', () => {
  it('renders the Company Workspace shell with the locked header and its navigation', () => {
    render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        activeKey="dashboard"
        onNavigate={() => {}}
        user={user}
      >
        <p>Dashboard content</p>
      </AppShell>,
    );

    /*
     * Once, in the top bar — not twice.
     *
     * The sidebar brand sub-line used to repeat the workspace name, which put the customer's name
     * under the product's own and made the brand block look like it belonged to them. It now says
     * what the product is. The workspace is still named, where it is named alongside the section
     * and the person's scope, and this asserts it is still named exactly once.
     */
    expect(screen.getAllByText('SPM Medicare')).toHaveLength(1);
    expect(screen.getByText('powered by UBoss AI')).toBeInTheDocument();
    expect(screen.getByText('Dashboard content')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  });

  it('marks the active navigation item with aria-current', () => {
    render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        activeKey="objective"
        onNavigate={() => {}}
        user={user}
      >
        <p>Content</p>
      </AppShell>,
    );

    // A navigation item is a link, not a button: it must be openable in a new tab, and it must
    // keep working when no host wires a click handler — which is how the whole sidebar came to do
    // nothing at all.
    const active = screen.getByRole('link', { name: /Objective Optimization/ });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).toHaveAttribute('href', '/objective');
  });

  it('reports the selected navigation key', () => {
    const onNavigate = vi.fn();
    render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        activeKey="dashboard"
        onNavigate={onNavigate}
        user={user}
      >
        <p>Content</p>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole('link', { name: /Engine Agents/ }));
    // The href travels with the key so a router host can take the transition over.
    expect(onNavigate).toHaveBeenCalledWith('agents', '/agents', expect.anything());
  });

  it('signs out from the sidebar footer and the top bar', () => {
    const onSignOut = vi.fn();
    render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        activeKey="dashboard"
        onNavigate={() => {}}
        user={user}
        onSignOut={onSignOut}
      >
        <p>Content</p>
      </AppShell>,
    );

    // The reference exposes sign-out in both places, so both must be wired: the sidebar footer
    // shows it directly, and the top bar carries it inside the account menu.
    fireEvent.click(screen.getByRole('button', { name: /^Sign out$/ }));
    expect(onSignOut).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /account menu/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Sign out/ }));
    expect(onSignOut).toHaveBeenCalledTimes(2);
  });

  it('keeps the role visible in the scope pill once the footer shows Sign out instead', () => {
    render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        activeKey="dashboard"
        onNavigate={() => {}}
        user={user}
        onSignOut={() => {}}
      >
        <p>Content</p>
      </AppShell>,
    );

    expect(screen.getByText(/Company Admin/)).toBeInTheDocument();
  });

  it('shows the role in the sidebar footer when there is nothing to sign out of', () => {
    const { container } = render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        activeKey="dashboard"
        onNavigate={() => {}}
        user={user}
      >
        <p>Content</p>
      </AppShell>,
    );

    expect(container.querySelector('.uboss-side-foot-role')).toHaveTextContent('Company Admin');
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('renders the Master Console shell with its dark variant', () => {
    const { container } = render(
      <AppShell
        variant="master"
        groups={MASTER_NAV}
        activeKey="dashboard"
        onNavigate={() => {}}
        user={{ name: 'Dibyanshu Patra', role: 'Platform Admin' }}
      >
        <p>Platform content</p>
      </AppShell>,
    );

    expect(container.querySelector('.uboss-shell--master')).toBeInTheDocument();
    /*
     * The bar names the section, here too. It used to read 'UBoss Master Console' and that moved
     * for the same reason the company bar's product name did: the page heading below it said the
     * same thing, and suppressing that heading while the bar showed a fixed label would have left
     * master screens with no name for the screen at all.
     *
     * The console's identity is not lost — the sidebar's brand is 'UBoss' over 'Master Console',
     * which the assertion below reads from the navigation landmark.
     */
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Dashboard');
    const sidebar = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(sidebar).getByText('Master Console')).toBeInTheDocument();
  });

  it('collapses and expands the sidebar', () => {
    const { container } = render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        activeKey="dashboard"
        onNavigate={() => {}}
        user={user}
      >
        <p>Content</p>
      </AppShell>,
    );

    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(container.querySelector('.uboss-shell--collapsed')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(container.querySelector('.uboss-shell--collapsed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();

    // The sidebar was a one-way door: it collapsed and could not be expanded again. The cause was
    // layout — collapsed, the brand kept the fixed height it uses to line up with the top bar, so
    // the toggle overflowed its box and the scroll area below painted over it. jsdom has no layout
    // and the repository has no Playwright suite in `verify`, so this asserts the half that IS
    // testable here: pressing the control a second time genuinely returns to the expanded state.
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(container.querySelector('.uboss-shell--collapsed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
  });
});

describe('Company navigation model', () => {
  // Users & Access and Roles & Permissions used to sit in the sidebar as well as in Settings, so
  // an admin met each destination twice. The client asked for the sidebar copies to go. What the
  // original tests were really defending was that neither screen becomes reachable by URL alone,
  // so that is asserted directly against Settings rather than against the sidebar.
  it('does not repeat Roles & Permissions in the sidebar, because Settings owns it', () => {
    const keys = COMPANY_NAV.flatMap((group) => group.items.map((item) => item.key));
    expect(keys).not.toContain('roles');
    expect(SETTINGS_SECTIONS.map((section) => section.key)).toContain('roles');
  });

  it('keeps Users & Access in Settings, where a company manages who may enter it', () => {
    /*
     * Inviting somebody is a Settings act, the way it is in every product a company already
     * uses: you open Settings and manage who is in the workspace.
     *
     * What was wrong before was not the location. It was that the section held one sentence and
     * a button reading *Open Users & Access* — three clicks to reach the invite form, two of
     * them spent reading about where it was. Selecting the section now opens the screen.
     */
    const keys = COMPANY_NAV.flatMap((group) => group.items.map((item) => item.key));
    expect(keys).not.toContain('users');
    expect(SETTINGS_SECTIONS.map((section) => section.key)).toContain('users');
  });

  /*
   * UBoss Profile Search moved into Settings, and the pair is what this asserts.
   *
   * It used to be the counterpart of the rule above — the one sidebar item Settings did not carry,
   * kept there because dropping it would have orphaned the screen. The client asked for it to live
   * in Settings, so the section now exists and the sidebar entry is gone.
   *
   * Both halves are checked together on purpose. Removing the item without adding the section is
   * exactly the mistake the old comment was guarding against: a screen the product still routes to
   * and no longer links to from anywhere.
   */
  it('reaches UBoss Profile Search through Settings and not through the sidebar', () => {
    const keys = COMPANY_NAV.flatMap((group) => group.items.map((item) => item.key));
    expect(keys).not.toContain('profile-search');
    expect(SETTINGS_SECTIONS.map((section) => section.key)).toContain('uboss');
  });

  it('uses the canonical Engine Agent and Executor Agent labels', () => {
    const labels = COMPANY_NAV.flatMap((group) => group.items.map((item) => item.label));
    expect(labels).toContain('Engine Agents');
    expect(labels).toContain('Executor Agent');
  });

  it('does not offer a Templates Library anywhere', () => {
    const allLabels = [...COMPANY_NAV, ...MASTER_NAV]
      .flatMap((group) => group.items.map((item) => item.label))
      .concat(SETTINGS_SECTIONS.map((section) => section.label))
      .join(' ')
      .toLowerCase();

    expect(allLabels).not.toContain('template');
  });
});

describe('SettingsShell', () => {
  it('renders left navigation for every settings section that holds a setting', () => {
    render(
      <SettingsShell sections={SETTINGS_SECTIONS} activeKey="general" onSelect={() => {}}>
        <p>Detail panel</p>
      </SettingsShell>,
    );

    /*
     * One button per section, whatever the list holds.
     *
     * It was nineteen, and nine of those nineteen were either a signpost to a screen somewhere
     * else or a paragraph with nothing to change. Pinning the number again would only mean the
     * next person to delete filler has to update a test to be allowed to; what the shell owes
     * is a button for each section it was given.
     */
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav.querySelectorAll('button')).toHaveLength(SETTINGS_SECTIONS.length);
    expect(SETTINGS_SECTIONS.length).toBeGreaterThan(0);
    expect(screen.getByText('Detail panel')).toBeInTheDocument();
  });

  it('filters the section list by name', () => {
    render(
      <SettingsShell sections={SETTINGS_SECTIONS} activeKey="general" onSelect={() => {}}>
        <p>Detail panel</p>
      </SettingsShell>,
    );

    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'notif' } });

    expect(screen.getByRole('button', { name: 'Notifications & Escalations' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Billing' })).not.toBeInTheDocument();
  });

  // The categories people hunt for are not named after the words they search. Matching the
  // description too is what makes the box worth having.
  it('filters on the description as well, so a word not in the title still finds it', () => {
    render(
      <SettingsShell sections={SETTINGS_SECTIONS} activeKey="general" onSelect={() => {}}>
        <p>Detail panel</p>
      </SettingsShell>,
    );

    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'budget' } });

    expect(screen.getByRole('button', { name: 'Tokens & Usage' })).toBeInTheDocument();
  });

  it('says so when nothing matches, rather than showing an empty column', () => {
    render(
      <SettingsShell sections={SETTINGS_SECTIONS} activeKey="general" onSelect={() => {}}>
        <p>Detail panel</p>
      </SettingsShell>,
    );

    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'zzzzz' } });

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav.querySelectorAll('.uboss-settings-nav-item')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('No settings match');
  });

  // Searching filters what the caller already passed. It must never be able to surface a section
  // the server withheld from this person.
  it('cannot reveal a section that was not passed in', () => {
    const permitted = SETTINGS_SECTIONS.filter((section) => section.key === 'general');

    render(
      <SettingsShell sections={permitted} activeKey="general" onSelect={() => {}}>
        <p>Detail panel</p>
      </SettingsShell>,
    );

    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'billing' } });

    expect(screen.queryByRole('button', { name: 'Billing' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('No settings match');
  });

  it('marks the active section', () => {
    render(
      <SettingsShell sections={SETTINGS_SECTIONS} activeKey="security" onSelect={() => {}}>
        <p>Detail</p>
      </SettingsShell>,
    );

    expect(screen.getByRole('button', { name: 'Security' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('uses personal labels for non-admin roles', () => {
    render(
      <SettingsShell
        sections={SETTINGS_SECTIONS}
        activeKey="general"
        onSelect={() => {}}
        personalLabels
      >
        <p>Detail</p>
      </SettingsShell>,
    );

    /*
     * "How this company works", not "My Profile".
     *
     * The category holds the company's timezone, working week and holidays — useful to somebody
     * who does not administer, because their deadlines are computed in them, and not in any
     * sense their profile. The label promised a page about them and delivered a page about the
     * company.
     */
    expect(screen.getByRole('button', { name: 'How this company works' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Login & Security' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
  });

  it('renders only the sections it is given, so scope stays a server decision', () => {
    const guestScope = SETTINGS_SECTIONS.filter((section) =>
      ['general', 'security', 'notifications'].includes(section.key),
    );

    render(
      <SettingsShell sections={guestScope} activeKey="general" onSelect={() => {}}>
        <p>Detail</p>
      </SettingsShell>,
    );

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav.querySelectorAll('button')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Billing' })).not.toBeInTheDocument();
  });
});

describe('LoginPresentation', () => {
  it('shows all six locked sections in order', () => {
    render(<LoginPresentation />);

    for (const title of ['MAP', 'Optimize', 'Build', 'Operate', 'Govern', 'Manage Task']) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it('uses the client-approved copy from the effective login definition', () => {
    render(<LoginPresentation />);

    // These are the strings the reference actually renders. The reference defines its login
    // twice and the LATER definition wins; an earlier version of this suite asserted the
    // superseded wording.
    expect(screen.getByText('Departments and people')).toBeInTheDocument();
    expect(screen.getByText('Objectives and their plans')).toBeInTheDocument();
    expect(screen.getByText('Agents built and released')).toBeInTheDocument();
    expect(screen.getByText('Approved versions, running')).toBeInTheDocument();
    expect(screen.getByText('Approvals and audit trail')).toBeInTheDocument();
    expect(screen.getByText('What is waiting on you')).toBeInTheDocument();
  });

  it('renders the radial mind-map exactly as the reference does', () => {
    const { container } = render(<LoginPresentation />);

    // Four concentric rings, six connectors, a central UB node and three cards per side.
    expect(container.querySelectorAll('.uboss-mm-rings span')).toHaveLength(4);
    expect(container.querySelectorAll('.uboss-mm-links path')).toHaveLength(6);
    expect(container.querySelector('.uboss-mm-center')).toHaveTextContent('UB');
    expect(container.querySelectorAll('.uboss-mmc--left')).toHaveLength(3);
    expect(container.querySelectorAll('.uboss-mmc--right')).toHaveLength(3);
  });

  it('renders the assurance strip', () => {
    render(<LoginPresentation />);

    expect(screen.getByText('Tenant-isolated')).toBeInTheDocument();
    expect(screen.getByText('Human governed')).toBeInTheDocument();
    expect(screen.getByText('Fully audited')).toBeInTheDocument();
  });

  it('offers no public company signup affordance', () => {
    render(
      <LoginPresentation>
        <p>Sign-in form</p>
      </LoginPresentation>,
    );

    // Locked rule: no public company signup. Nothing may invite self-registration.
    expect(screen.queryByText(/sign ?up/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/create (an )?account/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/register/i)).not.toBeInTheDocument();
  });

  it('states that somebody invites you, rather than denying a signup that now exists', () => {
    render(<NoPublicSignupNotice />);

    /*
     * This said "No public signup" until self-serve registration shipped, at which point it
     * became a claim the product had outgrown: a company can now set itself up at `/start`.
     *
     * The claim worth keeping is the one that did not change — you do not add yourself to a
     * company that already exists — and that is what is asserted. A company starting its own
     * workspace is a different door, and the notice no longer denies it.
     */
    expect(screen.getByText(/cannot add yourself to a company/i)).toBeInTheDocument();
    expect(screen.getByText(/invites you/i)).toBeInTheDocument();
    expect(screen.queryByText(/No public signup/i)).not.toBeInTheDocument();
  });

  /*
   * This notice appears on the login, activation and access-help screens — all of them customer
   * facing. It used to say "Tenants are provisioned from the UBoss Master Console", which is true
   * and is written for us: a customer has no word for a tenant and has never seen the Master
   * Console. Teaching them that UBoss has an inside is not a prerequisite for understanding that
   * they cannot sign themselves up.
   */
  it('says it in the customer\u2019s vocabulary, not UBoss\u2019s', () => {
    const { container } = render(<NoPublicSignupNotice />);
    const said = container.textContent ?? '';

    expect(said).not.toMatch(/Tenant/i);
    expect(said).not.toMatch(/Master Console/i);
    expect(said).not.toMatch(/Platform/i);
  });
});

describe('TopBar — the notification bell (Prompt 15)', () => {
  it('renders the unread count as a badge, never concatenated into the label', () => {
    const { container } = render(
      <TopBar variant="company" workspaceName="SPM Medicare" unreadNotifications={4} />,
    );

    // The locked rule: counts are badges. "Notifications 4" as a label is the defect this guards.
    const badge = container.querySelector('.uboss-icon-btn-count');
    expect(badge).toHaveTextContent('4');

    const bell = screen.getByRole('button', { name: /notifications/i });
    expect(bell.getAttribute('aria-label')).toBe('Notifications: 4 unread');
    expect(bell.textContent).not.toContain('Notifications 4');
  });

  it('caps the badge rather than letting a four-digit number break the bar', () => {
    const { container } = render(
      <TopBar variant="company" workspaceName="SPM Medicare" unreadNotifications={1204} />,
    );
    expect(container.querySelector('.uboss-icon-btn-count')).toHaveTextContent('99+');
    // The real number still reaches a screen reader.
    expect(screen.getByRole('button', { name: /1204 unread/ })).toBeInTheDocument();
  });

  it('turns the badge urgent while something needs acknowledging', () => {
    const { container } = render(
      <TopBar
        variant="company"
        workspaceName="SPM Medicare"
        unreadNotifications={2}
        awaitingAcknowledgement={1}
      />,
    );
    expect(container.querySelector('.uboss-icon-btn-count--urgent')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /2 unread, 1 needing acknowledgement/ }),
    ).toBeInTheDocument();
  });

  it('still marks the bell when nothing is unread but something needs acknowledging', () => {
    // A critical alert is not cleared by being read, so an unread count of zero can still mean
    // somebody must act. A "0" badge would say the opposite.
    const { container } = render(
      <TopBar
        variant="company"
        workspaceName="SPM Medicare"
        unreadNotifications={0}
        awaitingAcknowledgement={3}
      />,
    );
    expect(container.querySelector('.uboss-icon-btn-count')).not.toBeInTheDocument();
    expect(container.querySelector('.uboss-icon-btn-dot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3 needing acknowledgement/ })).toBeInTheDocument();
  });

  it('shows no marker at all when there is nothing waiting', () => {
    const { container } = render(<TopBar variant="company" workspaceName="SPM Medicare" />);

    expect(container.querySelector('.uboss-icon-btn-count')).not.toBeInTheDocument();
    expect(container.querySelector('.uboss-icon-btn-dot')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('passes the counts through the AppShell to the bell', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <AppShell
        variant="company"
        workspaceName="SPM Medicare"
        groups={COMPANY_NAV}
        activeKey="dashboard"
        onNavigate={() => undefined}
        user={user}
        unreadNotifications={7}
        awaitingAcknowledgement={2}
        onOpenNotifications={onOpen}
      >
        <div />
      </AppShell>,
    );

    expect(container.querySelector('.uboss-icon-btn-count')).toHaveTextContent('7');
    fireEvent.click(screen.getByRole('button', { name: /7 unread/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('TopBar — search', () => {
  it('offers no search field at all when no host runs a search', () => {
    render(<TopBar variant="company" workspaceName="SPM Medicare" />);

    /*
     * It was disabled, and before that it accepted text and discarded it.
     *
     * Disabled was an improvement on lying, and still wrong: nothing in the product supplies a
     * search, so every screen carried a wide, permanently dead box in the most valuable strip of
     * the window. A control that never works teaches people to stop reading controls. The prop
     * remains, and the field returns the day something passes it.
     */
    expect(screen.queryByLabelText(/Search people, objectives, agents/)).toBeNull();
  });

  it('runs the search on Enter when a host supplies one', () => {
    const onSearch = vi.fn();
    render(<TopBar variant="company" workspaceName="SPM Medicare" onSearch={onSearch} />);

    const field = screen.getByLabelText(/Search people, objectives, agents/);
    expect(field).toBeEnabled();

    fireEvent.change(field, { target: { value: '  Priya  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    // Trimmed, because a trailing space is a typo rather than a query.
    expect(onSearch).toHaveBeenCalledWith('Priya');
  });
});

describe('LoginPresentation — two front doors, one visual system', () => {
  /*
   * The two pages are opened by different people for different reasons, and the cost of confusing
   * them is not symmetrical: a customer who wanders into the platform console should meet a wall,
   * while a UBoss engineer on the customer login only loses a minute. So the difference has to be
   * structural — a different composition, not a different heading on the same one.
   */
  it('gives the customer the product identity and the capability map', () => {
    const { container } = render(
      <LoginPresentation>
        <p>form</p>
      </LoginPresentation>,
    );

    expect(container.querySelector('.uboss-mindmap')).not.toBeNull();
    expect(screen.getByText('Chief Agent')).toBeInTheDocument();
    // The six locked sections stay until the client approves a different grouping.
    for (const capability of ['MAP', 'Optimize', 'Build', 'Operate', 'Govern', 'Manage Task']) {
      expect(screen.getByText(capability)).toBeInTheDocument();
    }
  });

  it('never mentions the inside of UBoss on the customer door', () => {
    const { container } = render(
      <LoginPresentation>
        <p>form</p>
      </LoginPresentation>,
    );
    const said = container.textContent ?? '';

    // A customer should not have to learn that UBoss has a platform plane in order to sign in.
    for (const word of [
      'Master Console',
      'Platform & Development',
      'Internal',
      'DevOps',
      'Environment',
    ]) {
      expect(said).not.toContain(word);
    }
  });

  it('gives the platform door its own identity and boundary', () => {
    render(
      <LoginPresentation variant="platform">
        <p>form</p>
      </LoginPresentation>,
    );

    expect(screen.getByText('UBoss AI')).toBeInTheDocument();
    expect(screen.getByText(/Platform & Development Console/)).toBeInTheDocument();
    expect(screen.getByText(/Authorized internal access only/)).toBeInTheDocument();
  });

  it('composes the platform door differently rather than rewording the customer one', () => {
    const { container } = render(
      <LoginPresentation variant="platform">
        <p>form</p>
      </LoginPresentation>,
    );

    // Legible as a different place before anything on it has been read.
    expect(container.querySelector('.uboss-login--platform')).not.toBeNull();
    expect(container.querySelector('.uboss-mindmap')).toBeNull();
    expect(container.querySelectorAll('.uboss-plat-words li')).toHaveLength(4);
  });

  it('never offers a company workspace on the platform door', () => {
    const { container } = render(
      <LoginPresentation variant="platform">
        <p>form</p>
      </LoginPresentation>,
    );
    const said = container.textContent ?? '';

    expect(said).not.toMatch(/choose a workspace/i);
    expect(said).not.toContain('UBOSS AI AMS');
  });

  it('reports nothing about the state of the platform to an anonymous visitor', () => {
    const { container } = render(
      <LoginPresentation variant="platform">
        <p>form</p>
      </LoginPresentation>,
    );
    const said = container.textContent ?? '';

    // The grid is a motif. Anything resembling a reading would either be invented, or would be
    // telling somebody who has not signed in how the platform is doing.
    expect(said).not.toMatch(/\d+\s*(%|ms|req|error|incident|uptime)/i);
    expect(said).not.toMatch(/healthy|degraded|operational/i);
  });

  it('keeps the form area identical, because the quality is shared even though the identity is not', () => {
    const customer = render(
      <LoginPresentation>
        <button type="button">Sign In</button>
      </LoginPresentation>,
    );
    expect(customer.container.querySelector('.uboss-login-card button')).not.toBeNull();
    customer.unmount();

    const platform = render(
      <LoginPresentation variant="platform">
        <button type="button">Sign In</button>
      </LoginPresentation>,
    );
    expect(platform.container.querySelector('.uboss-login-card button')).not.toBeNull();
  });
});
