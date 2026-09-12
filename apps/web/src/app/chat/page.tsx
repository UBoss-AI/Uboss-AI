'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  Icon,
  PageHeader,
  SearchField,
  StatusBadge,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  chatApi,
  type ChatConversationSummary,
  type ChatConversationView,
  type MeResponse,
} from '../../lib/api-client';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../lib/use-company-navigation';

/**
 * Workspace Chat — Prompt 40A (CR-03) §6.
 *
 * ## The one thing this screen must get right
 *
 * **A context preview is rendered from what the server returned, and the two shapes are different
 * components.** `{accessible: true}` shows a title and a link; `{accessible: false}` shows the
 * stated reason. It must never render a placeholder, a spinner or a greyed-out title in the second
 * case — an empty box reads as a bug and invites somebody to go looking for the thing it did not
 * show them.
 *
 * Two people in the same conversation can see different previews of the same reference. That is
 * correct rather than inconsistent, and the screen does nothing to reconcile it.
 *
 * ## What it does not claim
 *
 * No typing indicator, no live badge, no green dots. There is no socket transport bound, so the
 * honest presentation is a refresh — and `realtimeStance` is printed at the foot of the screen in
 * the server's own words rather than paraphrased into something reassuring.
 */
function WorkspaceChatInner() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  // A conversation named in the URL — how Discuss arrives from a piece of work.
  const requestedId = useSearchParams().get('conversation');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(requestedId);
  const [open, setOpen] = useState<ChatConversationView | null>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Record<string, unknown>[] | null>(null);
  const [stances, setStances] = useState<{
    realtime: string;
    context: string;
    search: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const tenantId = me?.activeWorkspaceId ?? null;
  const bell = useNotificationBell(tenantId ?? '');

  const activeWorkspace = useMemo(
    () => me?.workspaces.find((workspace) => workspace.tenantId === tenantId) ?? null,
    [me, tenantId],
  );

  const load = useCallback(async () => {
    try {
      const identity = await authApi.me();
      setMe(identity);
      const workspace = identity.activeWorkspaceId;
      if (workspace === null) {
        setLoading(false);
        return;
      }

      const [meta, list] = await Promise.all([
        chatApi.meta(workspace),
        chatApi.conversations(workspace),
      ]);

      setStances({
        realtime: meta.realtimeStance,
        context: meta.contextStance,
        search: meta.searchStance,
      });
      setConversations(list.conversations);
      // Opening the newest is a convenience for somebody arriving at Chat directly. It must not
      // override a conversation named in the URL, which is a deliberate destination.
      if (list.conversations.length > 0 && openId === null && requestedId === null) {
        setOpenId(list.conversations[0]?.id ?? null);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Chat could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [openId, requestedId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tenantId === null || openId === null) return;
    let cancelled = false;

    void (async () => {
      try {
        const conversation = await chatApi.read(tenantId, openId);
        if (cancelled) return;
        setOpen(conversation);
        // Marking read on open, not on scroll: a marker that moved on scroll would need a
        // scroll listener and would still be wrong for somebody who opened and looked away.
        await chatApi.markRead(tenantId, openId);
        const refreshed = await chatApi.conversations(tenantId);
        if (!cancelled) setConversations(refreshed.conversations);
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof ApiError ? caught.message : 'That conversation could not be opened.',
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tenantId, openId]);

  const send = async () => {
    if (tenantId === null || openId === null || draft.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const sent = await chatApi.send(tenantId, openId, { body: draft });
      setDraft('');
      if (sent.ignoredMentions.length > 0) {
        // Reported rather than silently dropped: resolving a mention of somebody outside the
        // conversation would notify them about something they cannot open.
        setNotice(
          `Sent. ${sent.ignoredMentions.length} mention(s) were not notified because those people are not in this conversation.`,
        );
      }
      setOpen(await chatApi.read(tenantId, openId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That message could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const runSearch = async () => {
    if (tenantId === null) return;
    if (search.trim().length < 2) {
      setFound(null);
      return;
    }
    try {
      const result = await chatApi.search(tenantId, search.trim());
      setFound(result.messages);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Search failed.');
    }
  };

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="chat"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Workspace Chat' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Workspace Chat"
        description="Talk about the work, beside the work."
        breadcrumbs={[{ label: 'Operations' }]}
      />

      {error !== null ? <Banner tone="danger">{error}</Banner> : null}
      {notice !== null ? <Banner tone="info">{notice}</Banner> : null}

      {loading ? (
        <Card>
          <CardBody>Loading…</CardBody>
        </Card>
      ) : (
        <div className="chat-layout">
          {/* ---- the conversation list ---- */}
          <Card>
            <CardBody>
              <div className="chat-search">
                <SearchField
                  label="Search your conversations"
                  hideLabel
                  value={search}
                  placeholder="Search your conversations"
                  onChange={(event) => setSearch(event.target.value)}
                />
                <Button variant="default" onClick={() => void runSearch()}>
                  Search
                </Button>
              </div>

              {found !== null ? (
                <div data-testid="chat-search-results">
                  <p className="chat-muted">
                    {found.length === 0 ? 'Nothing found.' : `${found.length} result(s).`}
                  </p>
                  <p className="chat-muted">{stances?.search}</p>
                  <Button variant="ghost" onClick={() => setFound(null)}>
                    Clear
                  </Button>
                </div>
              ) : null}

              <ul className="chat-list" data-testid="chat-conversations">
                {conversations.length === 0 ? (
                  <li className="chat-muted">No conversations yet.</li>
                ) : null}
                {conversations.map((conversation) => (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={
                        conversation.id === openId ? 'chat-item chat-item-open' : 'chat-item'
                      }
                      onClick={() => setOpenId(conversation.id)}
                    >
                      <span className="chat-item-name">
                        {conversation.title ?? 'Direct message'}
                      </span>
                      {conversation.unread > 0 ? (
                        // A badge, not a concatenated label — the locked rule for counts.
                        <StatusBadge status={String(conversation.unread)} tone="blue" />
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          {/* ---- the open conversation ---- */}
          <Card>
            <CardBody>
              {open === null ? (
                <p className="chat-muted">Choose a conversation.</p>
              ) : (
                <>
                  <h2 className="chat-title">{open.title ?? 'Direct message'}</h2>

                  {/* ---- what this conversation is about ---- */}
                  {open.context.length > 0 ? (
                    <section data-testid="chat-context" className="chat-context">
                      <h3 className="chat-subhead">About</h3>
                      {open.context.map((entry) =>
                        entry.accessible ? (
                          <a
                            key={`${entry.type}:${entry.id}`}
                            className="chat-context-link"
                            href={entry.deepLink}
                            data-testid="chat-context-accessible"
                          >
                            <Icon name="target" />
                            <span>{entry.title}</span>
                            {entry.status !== null ? (
                              <StatusBadge status={entry.status} tone="blue" />
                            ) : null}
                          </a>
                        ) : (
                          /**
                           * The refused shape. A stated reason, never a placeholder — being in a
                           * conversation does not grant access to what it refers to, and an empty
                           * box would read as a bug rather than as a boundary.
                           */
                          <p
                            key={`${entry.type}:${entry.id}`}
                            className="chat-context-restricted"
                            data-testid="chat-context-restricted"
                          >
                            <Icon name="shield" />
                            <span>{entry.reason}</span>
                          </p>
                        ),
                      )}
                    </section>
                  ) : null}

                  {/* ---- messages ---- */}
                  <ul className="chat-messages" data-testid="chat-messages">
                    {open.messages.map((message) => (
                      <li key={message.id} className="chat-message">
                        <div className="chat-message-meta">
                          <span>{message.authorUserId.slice(0, 8)}</span>
                          <time dateTime={message.sentAt}>
                            {new Date(message.sentAt).toLocaleString()}
                          </time>
                        </div>
                        {message.deleted ? (
                          // The row stays so the reply beneath it still makes sense.
                          <p className="chat-deleted">Message deleted</p>
                        ) : (
                          <p className="chat-body">{message.body}</p>
                        )}
                        {message.attachments.map((attachment) => (
                          <p key={attachment.storedFileId} className="chat-attachment">
                            <Icon name="file" />
                            <span>{attachment.filename}</span>
                            {attachment.downloadable ? null : (
                              // Shown as attached and not openable. Hiding it would make the
                              // conversation misleading; serving it would make chat the way
                              // malware moves around a company.
                              <StatusBadge status="Checking" tone="warn" />
                            )}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ul>

                  <div className="chat-compose">
                    <textarea
                      aria-label="Message"
                      value={draft}
                      rows={3}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="Write a message. Use @name to mention somebody in this conversation."
                    />
                    <Button onClick={() => void send()} disabled={busy || draft.trim() === ''}>
                      Send
                    </Button>
                  </div>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {stances !== null ? (
        <Card>
          <CardBody>
            {/*
              Printed verbatim, at the foot, in the server's words. Both are claims somebody would
              otherwise make on the product's behalf: that a linked Objective is readable because
              it is linked, and that "live" means a socket.
            */}
            <p className="chat-muted" data-testid="chat-context-stance">
              {stances.context}
            </p>
            <p className="chat-muted" data-testid="chat-realtime-stance">
              {stances.realtime}
            </p>
          </CardBody>
        </Card>
      ) : null}
    </AppShell>
  );
}

/**
 * `useSearchParams()` needs a Suspense boundary or the production build fails outright.
 *
 * The boundary exists because Discuss deep-links here: `/chat?conversation=<id>` is how a
 * conversation started from an Objective or an Exception opens on the one screen that owns chat.
 */
export default function WorkspaceChatPage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceChatInner />
    </Suspense>
  );
}
