'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  FormField,
  MetricCard,
  Modal,
  PageHeader,
  SkeletonText,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  platformApi,
  platformSupportApi,
  type CompanySummary,
  type SupportTicketNoteView,
  type SupportTicketView,
} from '../../../lib/api-client';
import { useMasterConsole } from '../layout';

type OperatorTicket = SupportTicketView & { tenantId: string };

/** The states an operator can move a ticket to, and what each one means to the company. */
const NEXT_STATES: { to: string; label: string; needsNote: boolean }[] = [
  { to: 'Acknowledged', label: 'Acknowledge', needsNote: false },
  { to: 'InProgress', label: 'Start work', needsNote: false },
  { to: 'WaitingOnCustomer', label: 'Wait on customer', needsNote: false },
  { to: 'Resolved', label: 'Resolve', needsNote: true },
  { to: 'Closed', label: 'Close', needsNote: false },
];

function stateTone(state: string): StatusTone {
  if (state === 'New') return 'blue';
  if (state === 'InProgress') return 'teal';
  if (state === 'WaitingOnCustomer') return 'warn';
  if (state === 'Resolved' || state === 'Closed') return 'success';
  return 'grey';
}

function priorityTone(priority: string): StatusTone {
  if (priority === 'Urgent') return 'danger';
  if (priority === 'High') return 'warn';
  return 'grey';
}

/**
 * Support & Operations — the operator's queue.
 *
 * ## What this replaces
 *
 * A thirteen-line `ModuleShell`. Everything behind it was already built: a company raises a ticket
 * from Settings › Support, the routes to list, assign, transition and reply exist, and the tables
 * have been there since Prompt 37. Nobody at UBoss could see any of it — a customer could send a
 * ticket into a queue that had no screen.
 *
 * ## Which company, on every row
 *
 * A queue crosses companies, which is the whole reason it is a platform screen rather than a
 * company one. The company name is resolved from the console's own list rather than being
 * denormalised onto the ticket: a company that renames itself should not leave old tickets
 * labelled with the old name.
 *
 * ## A reply and an internal note are different things
 *
 * The company sees replies and never internal notes — `companyDetail` filters them server-side,
 * so this is not the enforcement. It is the place the distinction has to be *obvious*, because an
 * operator typing "the customer is being unreasonable" into the wrong box is not a bug the server
 * can catch.
 */
export default function MasterSupportPage() {
  const { can } = useMasterConsole();

  const [queue, setQueue] = useState<{
    open: number;
    waitingOnCustomer: number;
    unassigned: number;
    urgent: number;
  } | null>(null);
  const [tickets, setTickets] = useState<OperatorTicket[] | null>(null);
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [openTicket, setOpenTicket] = useState<OperatorTicket | null>(null);
  const [notes, setNotes] = useState<SupportTicketNoteView[] | null>(null);
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');

  const load = useCallback(() => {
    setError(null);
    void Promise.all([
      platformSupportApi.queue(),
      platformSupportApi.tickets(onlyOpen),
      platformApi.companies(),
    ])
      .then(([loadedQueue, loadedTickets, loadedCompanies]) => {
        setQueue(loadedQueue);
        setTickets(loadedTickets.tickets);
        setCompanies(loadedCompanies.companies);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load the support queue.'),
      );
  }, [onlyOpen]);

  useEffect(load, [load]);

  const companyName = (tenantId: string) =>
    companies.find((row) => row.tenantId === tenantId)?.name ?? tenantId.slice(0, 8);

  const openDetail = (ticket: OperatorTicket) => {
    setOpenTicket(ticket);
    setNotes(null);
    setReply('');
    setInternal(false);
    setResolutionNote('');
    void platformSupportApi
      .ticket(ticket.id)
      .then((detail) => setNotes(detail.notes))
      .catch(() => setNotes([]));
  };

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      setNotice(await work());
      load();
      if (openTicket !== null) {
        const refreshed = await platformSupportApi.ticket(openTicket.id);
        setOpenTicket(refreshed.ticket);
        setNotes(refreshed.notes);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Support & Operations"
        description="Tickets companies have raised, across every company on the platform."
      />

      {error !== null && <Banner tone="danger">{error}</Banner>}
      {notice !== null && <Banner tone="ok">{notice}</Banner>}

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}
      >
        {queue === null ? (
          <Card>
            <CardBody>
              <SkeletonText lines={2} />
            </CardBody>
          </Card>
        ) : (
          <>
            <MetricCard label="Open" value={queue.open} delta="not yet resolved" />
            <MetricCard
              label="Unassigned"
              value={queue.unassigned}
              // The one that matters: an open ticket with nobody on it is the one that ages.
              delta="nobody has picked these up"
            />
            <MetricCard label="Urgent" value={queue.urgent} delta="open and marked urgent" />
            <MetricCard
              label="Waiting on the customer"
              value={queue.waitingOnCustomer}
              delta="the ball is with them"
            />
          </>
        )}
      </div>

      <Card>
        <CardHeader
          title="Tickets"
          aside={
            <Button size="sm" onClick={() => setOnlyOpen((value) => !value)} disabled={busy}>
              {onlyOpen ? 'Show closed too' : 'Only open'}
            </Button>
          }
        />
        {tickets !== null && tickets.length === 0 ? (
          <CardBody>
            <EmptyState
              title={onlyOpen ? 'Nothing open' : 'No tickets'}
              description={
                onlyOpen
                  ? 'No company has an open ticket. Closed ones are hidden — use the button above.'
                  : 'No company has raised a ticket yet. They raise one from Settings › Support.'
              }
            />
          </CardBody>
        ) : (
          <DataTable
            caption="Support tickets across every company"
            rows={tickets ?? []}
            rowKey={(row) => row.id}
            loading={tickets === null}
            columns={[
              {
                key: 'ticket',
                header: 'Ticket',
                render: (row) => (
                  <>
                    <b>{row.subject}</b>
                    <br />
                    <small className="uboss-muted-3 uboss-mono">#{row.reference}</small>
                  </>
                ),
              },
              {
                key: 'company',
                header: 'Company',
                render: (row) => companyName(row.tenantId),
              },
              {
                key: 'kind',
                header: 'Kind',
                render: (row) => <span className="uboss-muted-3">{row.kind}</span>,
              },
              {
                key: 'priority',
                header: 'Priority',
                render: (row) => (
                  <StatusBadge status={row.priority} tone={priorityTone(row.priority)} />
                ),
              },
              {
                key: 'state',
                header: 'State',
                render: (row) => (
                  <>
                    <StatusBadge status={row.state} tone={stateTone(row.state)} dot />
                    {row.assignedOperatorUserId === null && row.isOpen ? (
                      <>
                        <br />
                        <small className="uboss-muted-3">unassigned</small>
                      </>
                    ) : null}
                  </>
                ),
              },
              {
                key: 'raised',
                header: 'Raised',
                render: (row) => (
                  <small className="uboss-muted-3">
                    {new Date(row.createdAt).toLocaleDateString()}
                  </small>
                ),
              },
              {
                key: 'actions',
                header: '',
                render: (row) => (
                  <Button size="sm" variant="ghost" onClick={() => openDetail(row)}>
                    Open
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Modal
        open={openTicket !== null}
        onClose={() => setOpenTicket(null)}
        title={openTicket === null ? '' : `#${openTicket.reference} — ${openTicket.subject}`}
        footer={<Button onClick={() => setOpenTicket(null)}>Close</Button>}
      >
        {openTicket === null ? null : (
          <>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Company</span>
              <span>{companyName(openTicket.tenantId)}</span>
              <span className="uboss-kv-key">State</span>
              <span>
                <StatusBadge status={openTicket.state} tone={stateTone(openTicket.state)} />
              </span>
              <span className="uboss-kv-key">Priority</span>
              <span>{openTicket.priority}</span>
            </div>

            <p style={{ whiteSpace: 'pre-wrap' }}>{openTicket.body}</p>

            {can('support', 'EditDraft') ? (
              <>
                <div className="uboss-section-label">Move it on</div>
                <div className="uboss-actions">
                  {NEXT_STATES.filter((next) => next.to !== openTicket.state).map((next) => (
                    <Button
                      key={next.to}
                      size="sm"
                      disabled={busy || (next.needsNote && resolutionNote.trim() === '')}
                      // Resolving without saying what was done leaves the company a state change
                      // and no answer, so the server requires the note and this disables until
                      // there is one — the same rule, said before it is refused.
                      title={
                        next.needsNote && resolutionNote.trim() === ''
                          ? 'Write what was done first'
                          : undefined
                      }
                      onClick={() =>
                        void run(async () => {
                          await platformSupportApi.transition(
                            openTicket.id,
                            next.to,
                            next.needsNote ? resolutionNote.trim() : undefined,
                          );
                          return `#${openTicket.reference} is now ${next.to}.`;
                        })
                      }
                    >
                      {next.label}
                    </Button>
                  ))}
                </div>

                <FormField
                  label="What was done"
                  hint="Required to resolve. The company reads this."
                >
                  {(wiring) => (
                    <textarea
                      {...wiring}
                      className="uboss-input"
                      rows={2}
                      value={resolutionNote}
                      onChange={(event) => setResolutionNote(event.target.value)}
                    />
                  )}
                </FormField>
              </>
            ) : null}

            <div className="uboss-section-label">History</div>
            {notes === null ? (
              <SkeletonText lines={3} />
            ) : notes.length === 0 ? (
              <p className="uboss-muted-3">Nothing has been added to this ticket yet.</p>
            ) : (
              <ul>
                {notes.map((note) => (
                  <li key={note.id}>
                    <b>{note.authorIsOperator ? 'UBoss' : 'The company'}</b>
                    {note.isInternal ? (
                      // Marked, because an internal note is the one thing here the company never
                      // sees, and an operator scanning a thread has to be able to tell at a glance.
                      <StatusBadge status="Internal" tone="warn" />
                    ) : null}
                    <br />
                    <span style={{ whiteSpace: 'pre-wrap' }}>{note.body}</span>
                    <br />
                    <small className="uboss-muted-3">
                      {new Date(note.createdAt).toLocaleString()}
                    </small>
                  </li>
                ))}
              </ul>
            )}

            {can('support', 'Comment') ? (
              <>
                <FormField
                  label={internal ? 'Internal note' : 'Reply to the company'}
                  hint={
                    internal
                      ? 'Only UBoss sees this. The company never does.'
                      : 'The company sees this in their own Support screen.'
                  }
                >
                  {(wiring) => (
                    <textarea
                      {...wiring}
                      className="uboss-input"
                      rows={3}
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                    />
                  )}
                </FormField>
                <div className="uboss-actions">
                  <label>
                    <input
                      type="checkbox"
                      checked={internal}
                      onChange={(event) => setInternal(event.target.checked)}
                    />{' '}
                    Keep this internal
                  </label>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || reply.trim() === ''}
                    onClick={() =>
                      void run(async () => {
                        await platformSupportApi.note(openTicket.id, reply.trim(), internal);
                        setReply('');
                        return internal ? 'Internal note added.' : 'Your reply was sent.';
                      })
                    }
                  >
                    {internal ? 'Add note' : 'Send reply'}
                  </Button>
                </div>
              </>
            ) : null}
          </>
        )}
      </Modal>
    </>
  );
}
