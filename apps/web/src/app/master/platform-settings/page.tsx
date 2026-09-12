'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  PageHeader,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import { ApiError, platformApi, type PlatformSettingRow } from '../../../lib/api-client';
import { useMasterConsole } from '../layout';

/**
 * Platform Settings — global configuration.
 *
 * The reference shows two cards, `Global defaults` and `Governance`, and the settings group
 * themselves by their `section` column so those two cards come from the data rather than from a
 * hard-coded layout. A ninth setting added by an insert appears without a code change.
 *
 * ## Locked settings are shown and refused
 *
 * Some of these are **product rules**, not preferences: there is no public company signup, and
 * Aadhaar is entered for internal person matching only. They are displayed — an operator should
 * be able to see the rule the platform runs under — with the API refusing to change them.
 *
 * That is a deliberate choice over the two alternatives. Hiding them would leave an operator
 * unable to confirm the constraint is in force; showing them with a working control would let a
 * click change a client-stated requirement. The reference itself renders "Master Console only (no
 * public signup)" as a fixed value, which is the same instinct.
 *
 * ## Owner-only to write
 *
 * `platform-settings:Administer` is **Platform Owner alone**, for the same reason as feature
 * flags: a global default applies to every customer at once. Every other platform role can read
 * this screen, which is right — configuration should not be a secret from the people operating
 * against it.
 */
export default function MasterPlatformSettingsPage() {
  const router = useRouter();
  const { can } = useMasterConsole();

  const [settings, setSettings] = useState<PlatformSettingRow[] | null>(null);
  const [sections, setSections] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    platformApi
      .settings()
      .then((result) => {
        setSettings(result.settings);
        setSections(result.sections);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load platform settings.'),
      );
  }, []);

  useEffect(load, [load]);

  const mayAdminister = can('platform-settings', 'Administer');

  /**
   * Change one setting.
   *
   * A prompt rather than an editing form, and honest about being that: the values are
   * heterogeneous JSON — a string, a number, a boolean — so a real form needs a per-setting
   * editor, which is a later prompt's work. What matters now is that the *guards* are exercised:
   * the reason is mandatory and a locked setting is refused.
   */
  const edit = async (setting: PlatformSettingRow) => {
    const raw = window.prompt(
      `New value for ${setting.key} (JSON — a quoted string, a number, or true/false)`,
      JSON.stringify(setting.value),
    );
    if (raw === null) {
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      setError(
        'That is not valid JSON. A text value needs quotes around it — for example "growth" ' +
          'rather than growth.',
      );
      return;
    }

    const reason = window.prompt(`Why is ${setting.key} changing?`);
    if (!reason) {
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await platformApi.updateSetting(setting.key, value, reason);
      setNotice(`${setting.key} updated. The change is recorded in the platform audit trail.`);
      load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change that setting.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Platform Settings"
        description="Global platform configuration."
        breadcrumbs={[
          { label: 'Master Console', onSelect: () => router.push('/master/dashboard') },
          { label: 'Platform Settings' },
        ]}
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="ok">{notice}</Banner> : null}

      {!mayAdminister ? (
        <Banner tone="info">
          Read-only for your role. Changing a global setting is held by <b>Platform Owner alone</b>,
          because it applies to every customer at once.
        </Banner>
      ) : null}

      {settings === null ? (
        <Card>
          <CardBody>
            <SkeletonText lines={5} />
          </CardBody>
        </Card>
      ) : (
        sections.map((section) => (
          <Card key={section}>
            <CardHeader title={section} />
            <CardBody>
              <DataTable
                caption={`${section} settings`}
                columns={[
                  {
                    key: 'setting',
                    header: 'Setting',
                    render: (row) => (
                      <>
                        <b className="uboss-mono">{row.key}</b>
                        {row.description ? (
                          <>
                            <br />
                            <small className="uboss-muted-3">{row.description}</small>
                          </>
                        ) : null}
                      </>
                    ),
                  },
                  {
                    key: 'value',
                    header: 'Value',
                    render: (row) => (
                      <span className="uboss-mono">{JSON.stringify(row.value)}</span>
                    ),
                  },
                  {
                    key: 'locked',
                    header: '',
                    render: (row) =>
                      row.locked ? (
                        <span title="A product rule, not a preference. The API refuses to change it.">
                          <StatusBadge status="Locked rule" tone="purple" />
                        </span>
                      ) : null,
                  },
                  {
                    key: 'actions',
                    header: 'Action',
                    render: (row) =>
                      row.locked || !mayAdminister ? (
                        <span className="uboss-muted-3">—</span>
                      ) : (
                        <Button disabled={busy} onClick={() => void edit(row)}>
                          Change
                        </Button>
                      ),
                  },
                ]}
                rows={settings.filter((row) => row.section === section)}
                rowKey={(row) => row.key}
              />
            </CardBody>
          </Card>
        ))
      )}

      <Card>
        <CardHeader title="Why some settings cannot be changed here" />
        <CardBody>
          <p>
            A <b>locked</b> setting records a client-stated product rule rather than a preference.
            It is shown so the rule is visible and refused on write, because offering a control that
            silently did nothing would be worse than offering none.
          </p>
          <ul className="uboss-muted-3">
            <li>
              <b>Company creation</b> — a company is created from the Master Console. There is no
              public company signup, and nothing in the product provides one.
            </li>
            <li>
              <b>Aadhaar handling</b> — Aadhaar is entered for internal person matching only. UBoss
              performs no Aadhaar authentication and claims no verified Aadhaar status.
            </li>
          </ul>
          <p className="uboss-muted-3">
            Every change to an unlocked setting requires a reason and is recorded in the platform
            audit trail and as a <b>Critical</b> security event — a global default is the widest
            blast radius a single change can have.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
