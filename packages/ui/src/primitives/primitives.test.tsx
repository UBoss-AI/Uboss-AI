import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from './ApprovalCard';
import { Button } from './Button';
import { CreditMeter } from './CreditMeter';
import { DataTable } from './DataTable';
import { EmptyState } from './EmptyState';
import { Banner, ErrorState } from './ErrorState';
import { FormField } from './FormField';
import { MetricCard } from './MetricCard';
import { ProgressStep } from './ProgressStep';
import { SearchField } from './SearchField';
import { SecurityMetric } from './SecurityMetric';
import { SkeletonText } from './Skeleton';
import { BADGE_LADDER, BADGE_LADDER_LABELS, MedalBadge, StatusBadge } from './StatusBadge';

describe('Button', () => {
  it('defaults to type="button" so it cannot accidentally submit a form', () => {
    render(<Button>Save Draft</Button>);
    expect(screen.getByRole('button', { name: 'Save Draft' })).toHaveAttribute('type', 'button');
  });

  it('renders each variant', () => {
    const { container } = render(
      <>
        <Button variant="primary">Approve &amp; Assign</Button>
        <Button variant="danger">Suspend</Button>
        <Button variant="navy">Open</Button>
        <Button variant="ghost">Cancel</Button>
      </>,
    );

    expect(container.querySelector('.uboss-btn--primary')).toBeInTheDocument();
    expect(container.querySelector('.uboss-btn--danger')).toBeInTheDocument();
    expect(container.querySelector('.uboss-btn--navy')).toBeInTheDocument();
    expect(container.querySelector('.uboss-btn--ghost')).toBeInTheDocument();
  });

  it('does not fire when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Blocked
      </Button>,
    );

    screen.getByRole('button').click();
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('StatusBadge', () => {
  it('always renders the status text, never colour alone', () => {
    render(<StatusBadge status="Waiting Approval" />);
    expect(screen.getByText('Waiting Approval')).toBeInTheDocument();
  });

  it('maps canonical statuses to their agreed tone', () => {
    const { container } = render(
      <>
        <StatusBadge status="Live" />
        <StatusBadge status="Blocked" />
        <StatusBadge status="Running" />
        <StatusBadge status="Draft" />
      </>,
    );

    expect(container.querySelector('.uboss-badge--success')).toBeInTheDocument();
    expect(container.querySelector('.uboss-badge--danger')).toBeInTheDocument();
    expect(container.querySelector('.uboss-badge--teal')).toBeInTheDocument();
    expect(container.querySelector('.uboss-badge--grey')).toBeInTheDocument();
  });

  it('falls back to a neutral tone for an unknown status', () => {
    const { container } = render(<StatusBadge status="Bespoke State" />);
    expect(container.querySelector('.uboss-badge--grey')).toBeInTheDocument();
  });
});

describe('MedalBadge', () => {
  it('supports the baseline ladder in order', () => {
    expect([...BADGE_LADDER]).toEqual(['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']);
  });

  it('shows the company’s name for each rung, and keeps the stored one readable', () => {
    /*
     * The rungs are stored as Bronze..Diamond and shown as Starter..Legend. Renaming the stored
     * values would rewrite badges people have already earned, so the ladder keeps its identity and
     * gains a label — and the tooltip carries the stored name so a screenshot can still be matched
     * against an audit row.
     */
    render(
      <>
        {BADGE_LADDER.map((tier) => (
          <MedalBadge key={tier} tier={tier} />
        ))}
      </>,
    );

    for (const tier of BADGE_LADDER) {
      const shown = BADGE_LADDER_LABELS[tier];
      expect(screen.getByText(shown)).toBeInTheDocument();
      expect(screen.getByText(shown)).toHaveAttribute('title', `${shown} (${tier})`);
    }
  });

  it('gives the client’s five names, in the ladder’s order', () => {
    expect(BADGE_LADDER.map((tier) => BADGE_LADDER_LABELS[tier])).toEqual([
      'Starter',
      'Skilled',
      'Pro',
      'Elite',
      'Legend',
    ]);
  });
});

describe('MetricCard', () => {
  it('renders label, value and delta', () => {
    render(<MetricCard label="Active companies" value={42} delta="+3 this month" trend="up" />);

    expect(screen.getByText('Active companies')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('+3 this month')).toBeInTheDocument();
  });

  it('becomes a button when it can drill down', () => {
    const onSelect = vi.fn();
    render(<MetricCard label="Incidents" value={1} onSelect={onSelect} />);

    screen.getByRole('button').click();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('is not interactive without a handler', () => {
    render(<MetricCard label="Storage" value="340GB" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

interface DemoRow {
  id: string;
  name: string;
  status: string;
}

const columns = [
  { key: 'name', header: 'Objective', render: (row: DemoRow) => row.name },
  {
    key: 'status',
    header: 'Status',
    render: (row: DemoRow) => <StatusBadge status={row.status} />,
  },
];

const rows: DemoRow[] = [
  { id: 'OBJ-501', name: 'GSPR checklist generation', status: 'Live' },
  { id: 'OBJ-502', name: 'Tender document assembly', status: 'Draft' },
];

describe('DataTable states', () => {
  it('renders rows in the success state', () => {
    render(<DataTable caption="Objectives" columns={columns} rows={rows} rowKey={(r) => r.id} />);

    expect(screen.getByText('GSPR checklist generation')).toBeInTheDocument();
    expect(screen.getByText('Tender document assembly')).toBeInTheDocument();
  });

  it('renders the loading state', () => {
    render(
      <DataTable caption="Objectives" columns={columns} rows={[]} rowKey={(r) => r.id} loading />,
    );

    expect(screen.getByLabelText('Objectives — loading')).toBeInTheDocument();
  });

  it('renders the empty state with a way forward', () => {
    render(
      <DataTable
        caption="Objectives"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        emptyTitle="No objectives yet"
        emptyDescription="Create your first objective to get started."
        emptyActions={<Button variant="primary">Create Objective</Button>}
      />,
    );

    expect(screen.getByText('No objectives yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Objective' })).toBeInTheDocument();
  });

  it('renders the error state with a retry', () => {
    const onRetry = vi.fn();
    render(
      <DataTable
        caption="Objectives"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        error="The service did not respond."
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("Couldn't load this list")).toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('activates a row by keyboard as well as click', () => {
    const onRowSelect = vi.fn();
    render(
      <DataTable
        caption="Objectives"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowSelect={onRowSelect}
      />,
    );

    const [firstRow] = screen.getAllByRole('button');
    expect(firstRow).toHaveAttribute('tabindex', '0');

    firstRow?.click();
    expect(onRowSelect).toHaveBeenCalledWith(rows[0]);
  });
});

describe('EmptyState and ErrorState', () => {
  it('renders an empty state', () => {
    render(<EmptyState title="Nothing here yet" description="Create your first objective." />);
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
  });

  it('renders permission denied as a first-class state with a route onward', () => {
    render(
      <ErrorState
        kind="permission-denied"
        description="Ask a Company Admin to grant access."
        actions={<Button variant="primary">Go to my dashboard</Button>}
      />,
    );

    expect(screen.getByText("You don't have access to this screen")).toBeInTheDocument();
    // CR-01/3: never a dead end.
    expect(screen.getByRole('button', { name: 'Go to my dashboard' })).toBeInTheDocument();
  });

  it('announces a hard error to assistive technology', () => {
    render(<ErrorState kind="error" description="Couldn't load runs." />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders blocked and degraded states', () => {
    render(
      <>
        <ErrorState kind="blocked" />
        <ErrorState kind="degraded" />
      </>,
    );

    expect(screen.getByText('This work is blocked')).toBeInTheDocument();
    expect(screen.getByText('Showing partial data')).toBeInTheDocument();
  });

  it('renders each banner tone', () => {
    const { container } = render(
      <>
        <Banner tone="info">Confirm to proceed.</Banner>
        <Banner tone="ok">Published — V2 is now live.</Banner>
        <Banner tone="warn">You have unsaved changes.</Banner>
        <Banner tone="danger">This cannot be undone.</Banner>
      </>,
    );

    expect(container.querySelector('.uboss-banner--info')).toBeInTheDocument();
    expect(container.querySelector('.uboss-banner--ok')).toBeInTheDocument();
    expect(container.querySelector('.uboss-banner--warn')).toBeInTheDocument();
    expect(container.querySelector('.uboss-banner--danger')).toBeInTheDocument();
  });
});

describe('SkeletonText', () => {
  it('marks the loading region as busy', () => {
    render(<SkeletonText lines={3} />);
    const region = screen.getByLabelText('Loading');
    expect(region).toHaveAttribute('aria-busy', 'true');
  });
});

describe('FormField', () => {
  it('associates the label with the control', () => {
    render(
      <FormField label="Objective Name">
        {(props) => <input {...props} defaultValue="" />}
      </FormField>,
    );

    expect(screen.getByLabelText('Objective Name')).toBeInTheDocument();
  });

  it('marks a required field for assistive technology', () => {
    render(
      <FormField label="Employee ID" required>
        {(props) => <input {...props} />}
      </FormField>,
    );

    expect(screen.getByLabelText(/Employee ID/)).toHaveAttribute('aria-required', 'true');
  });

  it('wires the error message to the control and announces it', () => {
    render(
      <FormField label="Aadhaar Number" required error="Enter the 12-digit number.">
        {(props) => <input {...props} />}
      </FormField>,
    );

    const input = screen.getByLabelText(/Aadhaar Number/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter the 12-digit number.');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the 12-digit number.');
  });

  it('exposes hint text as the control description', () => {
    render(
      <FormField label="Reporting Manager" hint="Used to build the hierarchy.">
        {(props) => <input {...props} />}
      </FormField>,
    );

    expect(screen.getByLabelText('Reporting Manager')).toHaveAccessibleDescription(
      'Used to build the hierarchy.',
    );
  });
});

describe('SearchField', () => {
  it('always has an accessible label even when visually hidden', () => {
    render(<SearchField label="Search objectives" placeholder="Search objectives" />);
    expect(screen.getByLabelText('Search objectives')).toBeInTheDocument();
  });
});

describe('ProgressStep', () => {
  it('renders each step with a text state, not shape alone', () => {
    render(
      <ProgressStep
        label="Objective analysis"
        items={[
          { id: '1', label: 'Understanding objective', state: 'done' },
          { id: '2', label: 'Detecting human work', state: 'running' },
          { id: '3', label: 'Matching approved skills', state: 'todo' },
          { id: '4', label: 'Assigning owners', state: 'blocked' },
        ]}
      />,
    );

    expect(screen.getByText(/Completed/)).toBeInTheDocument();
    expect(screen.getByText(/In progress/)).toBeInTheDocument();
    expect(screen.getByText(/Not started/)).toBeInTheDocument();
    expect(screen.getByText(/Blocked/)).toBeInTheDocument();
  });
});

describe('ApprovalCard', () => {
  it('states explicitly that the Executor Agent cannot approve on the user behalf', () => {
    render(
      <ApprovalCard
        title="Head sign-off — GSPR checklist"
        meta="Raised 2h ago"
        status="Waiting Approval"
        humanApprovalRequired
      />,
    );

    expect(screen.getByText(/Human approval is required/)).toBeInTheDocument();
    expect(screen.getByText(/cannot approve this on your behalf/)).toBeInTheDocument();
  });

  it('omits the notice when no human approval is mandated', () => {
    render(<ApprovalCard title="Informational" meta="Today" status="Completed" />);
    expect(screen.queryByText(/Human approval is required/)).not.toBeInTheDocument();
  });
});

describe('CreditMeter', () => {
  it('shows all four stages of the locked cost lifecycle', () => {
    render(
      <CreditMeter
        label="Regulatory Affairs budget"
        budget={100}
        unit="USD"
        lifecycle={{ estimated: 10, reserved: 15, executing: 5, settled: 40 }}
      />,
    );

    // Estimate -> Reserve -> Execute -> Settle/Reconcile must all be visible.
    expect(screen.getByText(/Estimated/)).toBeInTheDocument();
    expect(screen.getByText(/Reserved/)).toBeInTheDocument();
    expect(screen.getByText(/Executing/)).toBeInTheDocument();
    expect(screen.getByText(/Settled/)).toBeInTheDocument();
  });

  it('exposes the committed spend as a meter', () => {
    render(
      <CreditMeter
        label="Department budget"
        budget={100}
        lifecycle={{ estimated: 0, reserved: 10, executing: 0, settled: 20 }}
      />,
    );

    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '30');
  });

  it('warns when projected spend exceeds the budget', () => {
    render(
      <CreditMeter
        label="Department budget"
        budget={50}
        lifecycle={{ estimated: 30, reserved: 20, executing: 10, settled: 10 }}
      />,
    );

    expect(screen.getByText(/exceeds the budget/)).toBeInTheDocument();
  });

  it('does not divide by zero when no budget is set', () => {
    render(
      <CreditMeter
        label="Unbudgeted"
        budget={0}
        lifecycle={{ estimated: 0, reserved: 0, executing: 0, settled: 0 }}
      />,
    );

    expect(screen.getByRole('meter')).toBeInTheDocument();
  });
});

describe('SecurityMetric', () => {
  it('renders each level with a text equivalent', () => {
    render(
      <>
        <SecurityMetric label="MFA enrolment" value="92%" level="ok" />
        <SecurityMetric label="Stale sessions" value={3} level="attention" />
        <SecurityMetric label="Failed logins" value={41} level="critical" />
      </>,
    );

    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });
});

describe('ProgressStep — a moving indicator must mean moving work', () => {
  /*
   * `running` carries two different meanings in this product and only the caller knows which.
   *
   * A wizard marks its current step `running` to say "you are here". An analysis run marks a
   * stage `running` because a durable job really is working. The first must not have a ring
   * pulsing beside a form that is waiting for typing — the audit caught exactly that, still
   * moving 1.5 seconds after the page had settled — and the second needs one, because it is the
   * only thing on screen saying the wait is progress rather than a hang.
   *
   * These tests pin which class each case gets, since the difference between them is honesty
   * about what is happening and not a matter of taste.
   */
  const items = [
    { id: 'a', label: 'Reading the objective', state: 'done' as const },
    { id: 'b', label: 'Decomposing', state: 'running' as const },
    { id: 'c', label: 'Building the workflow', state: 'todo' as const },
  ];

  it('marks position quietly by default', () => {
    const { container } = render(<ProgressStep items={items} label="Steps" />);

    const pulse = container.querySelector('.uboss-step-pulse');
    expect(pulse).not.toBeNull();
    // The plain class plays once; the stylesheet gives only --live an infinite iteration count.
    expect(pulse?.classList.contains('uboss-step-pulse--live')).toBe(false);
  });

  it('marks genuinely running work as live when the caller says so', () => {
    const { container } = render(<ProgressStep items={items} label="Steps" live />);

    expect(container.querySelector('.uboss-step-pulse--live')).not.toBeNull();
  });

  it('gives a live indicator only to the running step', () => {
    const { container } = render(<ProgressStep items={items} label="Steps" live />);

    // One running step in, one indicator out. A done or todo step must not appear busy.
    expect(container.querySelectorAll('.uboss-step-pulse--live')).toHaveLength(1);
  });

  it('shows no indicator at all once nothing is running', () => {
    const finished = items.map((item) => ({ ...item, state: 'done' as const }));
    const { container } = render(<ProgressStep items={finished} label="Steps" live />);

    expect(container.querySelectorAll('.uboss-step-pulse')).toHaveLength(0);
  });

  it('states every step in words, not only by shape or colour', () => {
    const { container } = render(<ProgressStep items={items} label="Steps" live />);

    // Rendered for assistive technology only, as " — Completed" and so on, so read the spans
    // rather than looking for the bare word.
    const spoken = [...container.querySelectorAll('.uboss-sr-only')].map((el) =>
      el.textContent?.trim(),
    );

    // Whatever the indicator does, the state has to be readable without seeing it.
    expect(spoken).toEqual(['— Completed', '— In progress', '— Not started']);
  });
});
