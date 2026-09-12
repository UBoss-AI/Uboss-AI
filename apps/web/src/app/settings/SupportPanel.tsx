'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  StatusBadge,
  type DataTableColumn,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  supportApi,
  type ServiceStatusView,
  type SupportAccessRequestView,
  type SupportMeta,
  type SupportTicketNoteView,
  type SupportTicketView,
} from '../../lib/api-client';

/**
 * Settings › Security — Support & UBoss access (Prompt 36).
 *
 * Three things a company needs in one place: **what UBoss's status is**, **whether UBoss has asked
 * to come in**, and **their own support tickets**.
 *
 * ## Why the access requests are at the top
 *
 * Because they are the only thing on this panel with a deadline. A support session waiting on the
 * company's authorization blocks a UBoss engineer who is trying to fix something for them, and a
 * company that never notices the request has effectively declined it without deciding to.
 *
 * ## What the panel states rather than implies
 *
 * `accessStance` and `stance` both come from the server verbatim. The first says what a support
 * session always involves — a written reason, a verified identity, a second approver, a scope, an
 * expiry, a notification — and that there is no bypass. The second says that UBoss's status page
 * shows published incidents and never internal detail. Both are the kind of claim a front end
 * must not paraphrase.
 */

const TICKET_TONE: Record<string, StatusTone> = {
  New: 'blue',
  Acknowledged: 'blue',
  InProgress: 'blue',
  WaitingOnCustomer: 'warn',
  Resolved: 'success',
  Closed: 'grey',
};

const STATUS_TONE: Record<string, StatusTone> = {
  ok: 'success',
  degraded: 'warn',
  down: 'danger',
};

const SEVERITY_TONE: Record<string, StatusTone> = {
  P0: 'danger',
  P1: 'warn',
  P2: 'blue',
};

function when(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

export function SupportPanel({ tenantId }: { tenantId: string | null }): React.JSX.Element {
  const [meta, setMeta] = useState<SupportMeta | null>(null);
  const [tickets, setTickets] = useState<SupportTicketView[]>([]);
  const [status, setStatus] = useState<ServiceStatusView | null>(null);
  const [access, setAccess] = useState<{
    mode: string;
    requests: SupportAccessRequestView[];
  } | null>(null);

  const [open, setOpen] = useState<{
    ticket: SupportTicketView;
    notes: SupportTicketNoteView[];
  } | null>(null);
  const [reply, setReply] = useState('');

  const [raising, setRaising] = useState(false);
  const [draft, setDraft] = useState({ subject: '', body: '', kind: 'Problem' });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    if (tenantId === null) return;
    setError(null);

    Promise.all([
      supportApi.meta(tenantId),
      supportApi.tickets(tenantId),
      supportApi.serviceStatus(tenantId),
    ])
      .then(([loadedMeta, loadedTickets, loadedStatus]) => {
        setMeta(loadedMeta);
        setTickets(loadedTickets.tickets);
        setStatus(loadedStatus);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load support.'),
      );

    // Separate, and allowed to fail quietly: this one needs `settings:Administer`, and an
    // Employee reading their own tickets should not see an error because of a panel they are not
    // entitled to.
    supportApi
      .accessRequests(tenantId)
      .then(setAccess)
      .catch(() => setAccess(null));
  }, [tenantId]);

  useEffect(load, [load]);

  const act = useCallback(
    (work: () => Promise<unknown>, success: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      work()
        .then(() => {
          setNotice(success);
          load();
        })
        .catch((caught: unknown) =>
          setError(caught instanceof ApiError ? caught.message : 'That did not work.'),
        )
        .finally(() => setBusy(false));
    },
    [load],
  );

  const openTicket = useCallback(
    (ticket: SupportTicketView) => {
      if (tenantId === null) return;
      supportApi
        .ticket(tenantId, ticket.id)
        .then((detail) => {
          setOpen(detail);
          setReply('');
        })
        .catch((caught: unknown) =>
          setError(caught instanceof ApiError ? caught.message : 'Could not open that ticket.'),
        );
    },
    [tenantId],
  );

  const ticketColumns: DataTableColumn<SupportTicketView>[] = [
    { key: 'reference', header: '#', render: (ticket) => `#${ticket.reference}` },
    {
      key: 'subject',
      header: 'Subject',
      render: (ticket) => (
        <button type="button" className="uboss-linkish" onClick={() => openTicket(ticket)}>
          {ticket.subject}
        </button>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      render: (ticket) =>
        meta?.kinds.find((kind) => kind.key === ticket.kind)?.label ?? ticket.kind,
    },
    { key: 'priority', header: 'Priority', render: (ticket) => ticket.priority },
    {
      key: 'state',
      header: 'State',
      render: (ticket) => (
        <StatusBadge
          status={meta?.states.find((state) => state.key === ticket.state)?.label ?? ticket.state}
          tone={TICKET_TONE[ticket.state] ?? 'grey'}
        />
      ),
    },
    { key: 'raised', header: 'Raised', render: (ticket) => when(ticket.createdAt) },
  ];

  return (
    <div className="uboss-stack">
      {error !== null ? <Banner tone="danger">{error}</Banner> : null}
      {notice !== null ? <Banner tone="ok">{notice}</Banner> : null}

      {/* UBoss access requests first: they are the only thing here with a deadline. */}
      {access !== null && access.requests.length > 0 ? (
        <Card>
          <CardBody>
            <h3>UBoss support is asking to access your workspace</h3>
            <p className="uboss-muted">{meta?.accessStance}</p>

            {access.requests.map((requestItem) => (
              <div key={requestItem.id} className="uboss-stack uboss-bordered">
                <p>
                  <strong>Why:</strong> {requestItem.reason}
                </p>
                <p className="uboss-muted">
                  Scope: {requestItem.allowedModules.join(', ') || 'none'} ·{' '}
                  {requestItem.allowedActions.join(', ') || 'none'}
                  {requestItem.expiresAt === null ? null : ` · expires ${when(requestItem.expiresAt)}`}
                </p>
                <div className="uboss-actions">
                  <Button
                    variant="primary"
                    disabled={busy || tenantId === null}
                    onClick={() =>
                      act(
                        () =>
                          supportApi.decideAccess(tenantId as string, requestItem.id, {
                            authorized: true,
                          }),
                        'Authorized. UBoss support can now begin this session.',
                      )
                    }
                  >
                    Authorize
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy || tenantId === null}
                    onClick={() => {
                      const note = window.prompt(
                        'Why are you declining? UBoss needs to know whether to ask differently.',
                      );
                      if (note === null || note.trim() === '') return;
                      act(
                        () =>
                          supportApi.decideAccess(tenantId as string, requestItem.id, {
                            authorized: false,
                            note: note.trim(),
                          }),
                        'Declined. UBoss cannot begin this session — there is no bypass.',
                      );
                    }}
                  >
                    Decline
                  </Button>
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {status !== null ? (
        <Card>
          <CardBody>
            <div className="uboss-row uboss-row--between">
              <h3>UBoss service status</h3>
              <StatusBadge status={status.status} tone={STATUS_TONE[status.status] ?? 'grey'} />
            </div>
            <p>{status.summary}</p>

            {status.incidents.map((incident) => (
              <div key={incident.id} className="uboss-row">
                <StatusBadge
                  status={incident.severity}
                  tone={SEVERITY_TONE[incident.severity] ?? 'grey'}
                />
                {/* The only text UBoss publishes. There is no internal headline to show. */}
                <span>{incident.customerImpact}</span>
                <small className="uboss-muted">since {when(incident.startedAt)}</small>
              </div>
            ))}

            <p className="uboss-muted">
              <small>{status.stance}</small>
            </p>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardBody>
          <div className="uboss-row uboss-row--between">
            <h3>Your support tickets</h3>
            <Button variant="navy" onClick={() => setRaising(true)}>
              Raise a ticket
            </Button>
          </div>

          <DataTable
            caption="Support tickets this company has raised"
            columns={ticketColumns}
            rows={tickets}
            rowKey={(ticket) => ticket.id}
            emptyTitle="No tickets"
            emptyDescription="Anybody in the company can raise one — reporting a problem is not an administrative act."
          />
        </CardBody>
      </Card>

      <Drawer
        open={raising}
        onClose={() => setRaising(false)}
        title="Raise a support ticket"
        footer={
          <Button
            variant="primary"
            disabled={
              busy ||
              tenantId === null ||
              draft.subject.trim().length < 4 ||
              draft.body.trim().length < 10
            }
            onClick={() =>
              act(async () => {
                await supportApi.raise(tenantId as string, {
                  subject: draft.subject.trim(),
                  body: draft.body.trim(),
                  kind: draft.kind,
                });
                setDraft({ subject: '', body: '', kind: 'Problem' });
                setRaising(false);
              }, 'Ticket raised.')
            }
          >
            Send it
          </Button>
        }
      >
        <div className="uboss-stack">
          <label className="uboss-field">
            <span>What is it about</span>
            <select
              value={draft.kind}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value })}
            >
              {(meta?.kinds ?? []).map((kind) => (
                <option key={kind.key} value={kind.key}>
                  {kind.label}
                </option>
              ))}
            </select>
          </label>

          <label className="uboss-field">
            <span>Subject</span>
            <input
              value={draft.subject}
              onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
              placeholder="Something somebody can read in a list"
            />
          </label>

          <label className="uboss-field">
            <span>What happened</span>
            <textarea
              rows={6}
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              placeholder="A ticket with no detail costs a round trip before anybody can start."
            />
          </label>
        </div>
      </Drawer>

      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open === null ? 'Ticket' : `#${open.ticket.reference} · ${open.ticket.subject}`}
        footer={
          open === null || !open.ticket.isOpen || tenantId === null ? null : (
            <Button
              variant="primary"
              disabled={busy || reply.trim().length < 2}
              onClick={() =>
                act(async () => {
                  await supportApi.reply(tenantId, open.ticket.id, reply.trim());
                  const refreshed = await supportApi.ticket(tenantId, open.ticket.id);
                  setOpen(refreshed);
                  setReply('');
                }, 'Reply sent.')
              }
            >
              Reply
            </Button>
          )
        }
      >
        {open === null ? null : (
          <div className="uboss-stack">
            <p>{open.ticket.body}</p>

            {open.ticket.resolutionNote === null ? null : (
              <Banner tone="ok">{open.ticket.resolutionNote}</Banner>
            )}

            {/* Every note here is a reply. The server never sends an operator's internal note to
                a company, so there is nothing to filter on this side. */}
            {open.notes.map((note) => (
              <div key={note.id} className="uboss-stack uboss-bordered">
                <small className="uboss-muted">
                  {note.authorIsOperator ? 'UBoss support' : 'Your company'} · {when(note.createdAt)}
                </small>
                <p>{note.body}</p>
              </div>
            ))}

            {open.ticket.isOpen ? (
              <label className="uboss-field">
                <span>Reply</span>
                <textarea
                  rows={4}
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                />
              </label>
            ) : (
              <p className="uboss-muted">
                This ticket is finished. Raise a new one referencing it if it comes back.
              </p>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
