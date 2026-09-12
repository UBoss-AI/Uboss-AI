'use client';

import { useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  COMPANY_NAV,
  Card,
  CardBody,
  CardHeader,
  DonutDashboard,
  PageHeader,
} from '@uboss/ui';

import { authApi } from '../../../lib/api-client';

/**
 * Company Workspace shell preview.
 *
 * Mock navigation only. The dashboard body deliberately contains nothing but the single
 * two-slice donut: no KPI cards, objective tables, token/cost cards, notification lists,
 * hierarchy summaries, performance details or reports (locked rule, UBoss_Final_2 §29).
 */
export default function CompanyShellPreview() {
  const [activeKey, setActiveKey] = useState('dashboard');
  const [drilldown, setDrilldown] = useState<string | null>(null);

  const isDashboard = activeKey === 'dashboard';

  return (
    <AppShell
      variant="company"
      workspaceName="SPM Medicare"
      groups={COMPANY_NAV}
      activeKey={activeKey}
      onNavigate={(key) => {
        setActiveKey(key);
        setDrilldown(null);
      }}
      user={{ name: 'Priya Nair', role: 'Company Admin' }}
      // The reference's top bar and sidebar footer both carry a sign-out control, so the
      // preview shows them. It performs a real sign-out and returns to the login screen.
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
      scopeLabel="Company Admin · Whole company"
      hasNotifications
    >
      {isDashboard ? (
        <>
          <PageHeader
            title="Dashboard"
            description="One visual snapshot, scoped to what you can see."
          />

          <div style={{ maxWidth: 560, margin: '0 auto' }}>
            <Card>
              <DonutDashboard
                agents={8}
                pendingJobs={12}
                onSelectAgents={() => setDrilldown('agents')}
                onSelectPendingJobs={() => setDrilldown('todo')}
              />
            </Card>

            {drilldown ? (
              <div style={{ marginTop: 16 }}>
                <Banner tone="info">
                  {drilldown === 'agents'
                    ? 'Agents slice selected — this opens the Engine Agent list in a later prompt.'
                    : 'Pending Jobs slice selected — this opens your permitted pending work in a later prompt.'}
                </Banner>
              </div>
            ) : null}

            <p className="uboss-notice" style={{ justifyContent: 'center', marginTop: 16 }}>
              Your permission-scoped snapshot. Select a slice to drill down. Reports, budgets and
              KPIs live in their own modules — never on this dashboard.
            </p>
          </div>
        </>
      ) : (
        <>
          <PageHeader
            title={
              COMPANY_NAV.flatMap((group) => group.items).find((item) => item.key === activeKey)
                ?.label ?? 'Module'
            }
            description="Shell preview only. This module is built in a later prompt."
            breadcrumbs={[
              { label: 'Dashboard', onSelect: () => setActiveKey('dashboard') },
              { label: 'Module' },
            ]}
            actions={<Button onClick={() => setActiveKey('dashboard')}>Back to Dashboard</Button>}
          />

          <Card>
            <CardHeader title="Not built yet" />
            <CardBody>
              <p className="uboss-muted">
                Prompt 2 covers the design system and shells. Every screen still offers a route
                onward, so no navigation choice becomes a dead end.
              </p>
            </CardBody>
          </Card>
        </>
      )}
    </AppShell>
  );
}
