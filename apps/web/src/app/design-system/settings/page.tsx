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
  FormField,
  PageHeader,
  SETTINGS_SECTIONS,
  SettingsShell,
} from '@uboss/ui';

import { authApi } from '../../../lib/api-client';

/**
 * Settings shell preview: left settings navigation, right detail panel (locked UI rule).
 *
 * The `personalLabels` toggle demonstrates the approved relabelling for non-admin roles.
 * The sections rendered are whatever the caller passes — scope remains a server decision.
 */
export default function SettingsShellPreview() {
  const [activeSection, setActiveSection] = useState('general');
  const [personalLabels, setPersonalLabels] = useState(false);

  const section = SETTINGS_SECTIONS.find((item) => item.key === activeSection);
  const label = personalLabels && section?.personalLabel ? section.personalLabel : section?.label;

  return (
    <AppShell
      variant="company"
      workspaceName="SPM Medicare"
      groups={COMPANY_NAV}
      activeKey="settings"
      onNavigate={() => undefined}
      user={{ name: 'Priya Nair', role: 'Company Admin' }}
      // The reference's top bar and sidebar footer both carry a sign-out control, so the
      // preview shows them. It performs a real sign-out and returns to the login screen.
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
      scopeLabel="Company Admin · Whole company"
    >
      <PageHeader
        title="Settings"
        description={`${SETTINGS_SECTIONS.length} categories in your scope.`}
        breadcrumbs={[{ label: 'Settings' }]}
        actions={
          <Button onClick={() => setPersonalLabels((value) => !value)}>
            {personalLabels ? 'Show admin labels' : 'Show non-admin labels'}
          </Button>
        }
      />

      <SettingsShell
        sections={SETTINGS_SECTIONS}
        activeKey={activeSection}
        onSelect={setActiveSection}
        personalLabels={personalLabels}
      >
        <Card>
          <CardHeader title={label ?? 'Settings'} />
          <CardBody>
            <p className="uboss-muted">{section?.description}</p>

            {activeSection === 'organization' ? (
              <>
                <div className="uboss-section-label">Company identity</div>
                <FormField
                  label="Company Vision"
                  hint="Shown on the Hierarchy screen to everyone with hierarchy access."
                >
                  {(props) => (
                    <textarea
                      {...props}
                      readOnly
                      value="To make world-class, affordable medical devices accessible in every market SPM serves."
                    />
                  )}
                </FormField>
                <FormField label="Company Mission">
                  {(props) => (
                    <textarea
                      {...props}
                      readOnly
                      value="Deliver compliant, patient-safe devices through disciplined design controls, rigorous post-market surveillance, and an AI-augmented workforce."
                    />
                  )}
                </FormField>
                <Banner tone="info">
                  Editing Vision and Mission is an audited change. The editing UI is built with
                  Company Settings in a later prompt.
                </Banner>
              </>
            ) : (
              <Banner tone="info">
                Panel content for this category is built in the prompt that owns it. The shell,
                navigation and scoping behaviour are what Prompt 2 delivers.
              </Banner>
            )}
          </CardBody>
        </Card>
      </SettingsShell>
    </AppShell>
  );
}
