'use client';

import { motion } from 'motion/react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  Icon,
  initials,
  PageHeader,
  SearchField,
  StatusBadge,
  transition,
} from '@uboss/ui';

import { avatarTint } from '../../lib/avatar-tint';
import {
  applyMention,
  handleFor,
  matchMentions,
  mentionQueryAt,
  mentionResolutionsFor,
} from '../../lib/mentions';

import {
  ApiError,
  authApi,
  chatApi,
  filesApi,
  organizationApi,
  type ChatConversationSummary,
  type ChatConversationView,
  type MeResponse,
} from '../../lib/api-client';
import { RequestChangePanel } from '../../components/RequestChangePanel';
import { useAccountMenu } from '../../lib/use-account-menu';
import { useSignedInUser } from '../../lib/use-signed-in-user';
import { ChatRail } from '../../components/ChatRail';
import { NewConversationPanel } from '../../components/NewConversationPanel';
import { RoutedAppShell } from '../../components/RoutedAppShell';
import { can, useMyAccess } from '../../lib/use-my-access';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../lib/active-workspace';
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
  /**
   * The departments this person may open a workshop for.
   *
   * Read from the hierarchy, which already answers "what of this company may you see": an employee
   * gets their own department, an Admin gets all of them. Asking that question here would be a
   * second answer to it, and the two would disagree.
   */
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [requestingChange, setRequestingChange] = useState(false);
  const [openId, setOpenId] = useState<string | null>(requestedId);
  const [open, setOpen] = useState<ChatConversationView | null>(null);
  const [draft, setDraft] = useState('');
  const [starting, setStarting] = useState(false);
  /** Files uploaded and waiting to go with the next message. */
  const [attached, setAttached] = useState<{ id: string; filename: string }[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);

  /*
   * The typing line is one row tall and grows with what is in it.
   *
   * A fixed three-row box took a quarter of the pane to hold the four words most messages are,
   * and still ran out on a long one. Measuring is the only way: a textarea has no intrinsic
   * height, so the height is cleared first — otherwise `scrollHeight` reports the height it
   * already has and the box can only ever grow.
   *
   * The ceiling is in the stylesheet, as `max-height`, which takes over once a message is long
   * enough to be worth scrolling instead of swallowing the conversation above it. Runs on `draft`
   * so it shrinks back to one line when a sent message clears it.
   */
  useEffect(() => {
    const box = composer.current;
    if (box === null) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
  }, [draft]);
  /**
   * The colleagues this person may start a conversation with, named.
   *
   * Read from the hierarchy, which already answers "what of this company may you see". Nobody
   * picks a person by user id: an id is not a person, and an admin asked to identify a colleague
   * by UUID will choose the wrong one eventually.
   */
  const [colleagues, setColleagues] = useState<{ userId: string; displayName: string }[]>([]);
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

  const tenantId =
    resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantId ?? null;

  const myAccess = useMyAccess();

  /*
   * Whether the server will accept a group from this person.
   *
   * The same grant the server checks, asked here only so the button is not offered to somebody
   * who would fill the form in and be refused at the end. The decision is still the server's — a
   * refusal that reaches this screen is printed verbatim.
   */
  const mayCreateGroup = can(myAccess, 'users', 'ManageAccess');

  /*
   * Everybody but the signed-in person.
   *
   * Filtered here rather than where the list is fetched: doing it in the effect made the effect
   * depend on who is signed in, and re-running a hierarchy read because an identity resolved is
   * a second request for the same answer.
   */
  const otherPeople = colleagues.filter((person) => person.userId !== me?.user.userId);

  /*
   * Who `@` can reach from here: the people in this conversation, named.
   *
   * The conversation carries ids; `colleagues` carries the names. Anybody in the room whose name
   * this person cannot see is left out rather than offered as an id — and the server drops a
   * mention of somebody outside the conversation anyway, and says that it did, so offering a
   * colleague who is not in the room would only produce that notice.
   */
  const mentionable = useMemo(() => {
    if (open === null) return [];
    const inRoom = new Set(open.participantUserIds ?? []);
    return otherPeople.filter((person) => inRoom.has(person.userId));
    // `otherPeople` is derived from `colleagues` and `me`, which are both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, colleagues, me?.user.userId]);

  /*
   * Where the cursor is, which is the only way to know whether an `@` is still being typed.
   *
   * Kept in state rather than read during render: a textarea's `selectionStart` is only correct
   * after the browser has applied the keystroke, so it is captured from the events that follow
   * one.
   */
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);

  const mentionRange = mentionQueryAt(draft, caret);
  const mentionOptions =
    mentionRange === null ? [] : matchMentions(mentionable, mentionRange.query);

  /** Put the chosen person in the draft and leave the cursor after them. */
  const pickMention = (person: { userId: string; displayName: string }) => {
    if (mentionRange === null) return;
    const next = applyMention(draft, mentionRange, person);
    setDraft(next.text);
    setMentionIndex(0);
    // After React has written the new value, or the browser puts the cursor back at the end.
    requestAnimationFrame(() => {
      const box = composer.current;
      if (box === null) return;
      box.focus();
      box.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const signedInUser = useSignedInUser(me);

  const accountMenu = useAccountMenu(me);
  const bell = useNotificationBell(tenantId ?? '');

  const activeWorkspace = useMemo(
    () => me?.workspaces.find((workspace) => workspace.tenantId === tenantId) ?? null,
    [me, tenantId],
  );

  /**
   * Open a department's workshop and go straight into it.
   *
   * The list is reloaded rather than the new conversation being pushed onto it by hand: the server
   * decides what this person is in, and a locally assembled row would be this screen's opinion of
   * that. Opening one already open is not an error — it brings its membership up to date.
   */
  const openWorkshop = useCallback(
    async (departmentId: string) => {
      if (tenantId === null) return;
      setBusy(true);
      setError(null);
      try {
        const opened = await chatApi.openDepartmentWorkshop(tenantId, departmentId);
        const refreshed = await chatApi.conversations(tenantId);
        setConversations(refreshed.conversations);
        setOpenId(opened.id);
      } catch (caught) {
        setError(
          caught instanceof ApiError ? caught.message : 'That workshop could not be opened.',
        );
      } finally {
        setBusy(false);
      }
    },
    [tenantId],
  );

  const load = useCallback(async () => {
    try {
      const identity = await authApi.me();
      setMe(identity);
      // Not `identity.activeWorkspaceId`: that field is structurally always null, so reading it
      // here meant this loader returned before it ever called the API — Workspace Chat showed
      // "No conversations yet." to every person in every company. See active-workspace.ts.
      const workspace = resolveActiveWorkspace(
        identity.workspaces,
        readRememberedWorkspace(),
      )?.tenantId;
      if (workspace === undefined) {
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

  /*
   * The departments, read on their own.
   *
   * Deliberately not part of `load`. Workshops are a convenience beside the conversation list, and
   * putting the read in the same `Promise.all` tied the list everybody needs to a call some people
   * are not allowed to make — one refusal and the screen said "no conversations yet" to somebody
   * who had plenty. A failure here costs the workshop buttons and nothing else.
   */
  useEffect(() => {
    if (tenantId === null) return;
    let current = true;
    void organizationApi
      .hierarchy(tenantId)
      .then((view) => {
        if (!current) return;
        setDepartments(
          (view.departments ?? [])
            .filter((department) => !department.archived)
            .map((department) => ({ id: department.id, name: department.name })),
        );
        setColleagues(
          (view.list ?? []).map((person) => ({
            userId: person.userId,
            displayName: person.displayName,
          })),
        );
      })
      .catch(() => {
        if (current) setDepartments([]);
      });
    return () => {
      current = false;
    };
  }, [tenantId]);

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

  /**
   * Put a file in the company's own store, then remember its id for the next message.
   *
   * Two steps rather than one, and deliberately so: the file becomes a governed record — scanned,
   * classified, retained, deletable — before any conversation points at it. A chat that carried
   * its own copies would be a second file system with none of those rules.
   *
   * The message is not sent here. Somebody attaching a spreadsheet usually wants to say something
   * about it, and sending on attach takes that away.
   */
  const attach = async (file: File) => {
    if (tenantId === null) return;
    setBusy(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      // Chunked rather than spread in one call: `String.fromCharCode(...bytes)` overflows the
      // argument limit on a file of any size, and it does it by crashing rather than by failing.
      for (let at = 0; at < bytes.length; at += 8192) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
      }

      const stored = await filesApi.upload(tenantId, {
        filename: file.name,
        contentType: file.type === '' ? 'application/octet-stream' : file.type,
        contentBase64: btoa(binary),
      });
      setAttached((current) => [...current, { id: stored.id, filename: file.name }]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That file could not be attached.');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (tenantId === null || openId === null) return;
    if (draft.trim() === '' && attached.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      /*
       * Who the `@`s in this message actually are.
       *
       * This was never sent. The server parses handles out of the body and looks each one up in
       * this map; with no map every mention resolved to nobody, so the placeholder's promise was
       * never kept for a single message. Read from the body at send time rather than collected as
       * people are picked, because a draft gets edited — a mention taken back out must not
       * notify anybody.
       */
      const mentionResolutions = mentionResolutionsFor(draft, mentionable);

      const sent = await chatApi.send(tenantId, openId, {
        body: draft,
        ...(attached.length === 0 ? {} : { attachmentIds: attached.map((file) => file.id) }),
        ...(Object.keys(mentionResolutions).length === 0 ? {} : { mentionResolutions }),
      });
      setDraft('');
      setAttached([]);
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
    <RoutedAppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="chat"
      user={signedInUser}
      accountMenu={accountMenu}
      {...bell.shellProps}
      onSignOut={() => {
        forgetWorkspace();
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      {/*
        Request Change sits in the header, beside the conversation it came from.

        The client puts it inside Workshop Chat on purpose: somebody notices a problem while
        talking about the work, and the request carries the conversation with it so the Admin can
        read what was being discussed rather than only the summary.
      */}
      <PageHeader
        title="Workspace Chat"
        description="Talk about the work, beside the work."
        breadcrumbs={[{ label: 'Operations' }]}
        actions={
          <Button size="sm" onClick={() => setRequestingChange(true)}>
            <Icon name="shield" size={16} />
            Request a change
          </Button>
        }
      />

      {error !== null ? <Banner tone="danger">{error}</Banner> : null}
      {notice !== null ? <Banner tone="info">{notice}</Banner> : null}

      {/*
        The department workshops used to be a row of buttons here as well as a section in the
        rail, so every department was on screen twice and the two disagreed about which was
        selected. They belong in the rail with everything else somebody can open — a workshop is a
        conversation, and a conversation belongs in the conversation list.
      */}

      {/*
        The screen holds its own height, and the two panes scroll inside it.

        A wrapper rather than a height on the grid itself, because the disclosure underneath is
        part of this screen: with the frame on the grid alone, the footnote hung below the fold and
        the page scrolled by exactly its height — a smaller version of the complaint this change
        exists to fix. As a flex column, the grid takes whatever the footnote leaves, whatever the
        footnote's text turns out to be, and opening the disclosure scrolls the page, which is what
        a disclosure is supposed to do.
      */}
      <div className="chat-screen">
        {loading ? (
          <Card>
            <CardBody>Loading…</CardBody>
          </Card>
        ) : (
          <div className="chat-layout">
            {/* ---- the conversation list ---- */}
            <Card>
              <CardBody>
                <div className="chat-new">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setStarting((current) => !current)}
                    data-testid="new-conversation"
                  >
                    <Icon name="plus" size={16} />
                    New
                  </Button>
                </div>

                {starting && tenantId !== null ? (
                  <NewConversationPanel
                    tenantId={tenantId}
                    people={otherPeople}
                    mayCreateGroup={mayCreateGroup}
                    onCancel={() => setStarting(false)}
                    onOpened={(conversationId) => {
                      setStarting(false);
                      setOpenId(conversationId);
                      void load();
                    }}
                  />
                ) : null}

                {/*
                  Enter searches. The button that used to sit under the box has gone.

                  This is a search of what was *said* — it asks the server — so it cannot run on
                  every keystroke, and that is why there was a button at all. But a box with a
                  magnifier in it already promises Enter, and the button sitting below it on its
                  own line was the second widest thing in the rail. The placeholder says which
                  key, so nothing about it has to be guessed.
                */}
                <form
                  className="chat-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runSearch();
                  }}
                >
                  <SearchField
                    label="Search your conversations"
                    hideLabel
                    value={search}
                    placeholder="Search messages, then press Enter"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </form>

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

                {/*
                Grouped by kind, because the three answer different questions.

                A flat list ordered by recency is right for a mailbox and wrong here: a workshop
                that has been quiet for a week sinking below six direct messages is a workshop
                nobody opens again.
              */}
                <ChatRail
                  conversations={conversations}
                  departments={departments}
                  openId={openId}
                  meUserId={me?.user.userId ?? null}
                  onOpen={setOpenId}
                  onOpenWorkshop={(departmentId) => void openWorkshop(departmentId)}
                />
              </CardBody>
            </Card>

            {/* ---- the open conversation ---- */}
            <Card>
              {/*
              Three rows: who you are talking to, what was said, and the box you say it in.

              A chat is read bottom-up — the newest message is the one you came for, and the
              composer is where your hands already are. As an ordinary stack the composer sat
              near the top of a mostly empty card whenever a conversation was quiet.
            */}
              <CardBody className="chat-pane">
                {open === null ? (
                  <p className="chat-muted">Choose a conversation.</p>
                ) : (
                  <>
                    {/*
                      The head of the conversation, not a heading above a card.

                      It was the name on its own in bold — the same thing every other card on the
                      product puts at its top, which is why this screen read as a panel rather
                      than as somewhere people talk. The same circle the rail draws for this
                      conversation, the name, and who is in it: the three things a chat window has
                      had at its top for twenty years.
                    */}
                    {(() => {
                      const label = conversationLabel(open, me?.user.userId ?? null);
                      // `participantUserIds` is what this view carries; the named list belongs to
                      // the rail's summary. A count needs no names.
                      const people = open.participantUserIds?.length ?? 0;

                      return (
                        <header className="chat-head">
                          <span
                            className="uboss-avatar"
                            style={{ background: avatarTint(label) }}
                            aria-hidden="true"
                          >
                            {initials(label)}
                          </span>
                          <div className="chat-head-text">
                            <h2 className="chat-title">{label}</h2>
                            {/* Never a presence claim. There is no socket here and a test
                                enforces that nothing on this screen says "online". Who is in the
                                room is a fact the server already sent. */}
                            {people > 0 ? (
                              <p className="chat-head-sub">
                                {people} {people === 1 ? 'person' : 'people'} in this conversation
                              </p>
                            ) : null}
                          </div>
                        </header>
                      );
                    })()}

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
                      {/*
                      A conversation nobody has spoken in yet says so.

                      An empty pane between a title and a composer reads as something that failed
                      to load — which is exactly the wrong thing for a department workshop, where
                      being the first to say anything is the normal case rather than a sign that
                      the screen is broken.
                    */}
                      {open.messages.length === 0 ? (
                        <li className="chat-empty">
                          Nothing has been said here yet. Start the conversation.
                        </li>
                      ) : null}
                      {open.messages.map((message, index) => {
                        /*
                         * Who said it decides which side it sits on.
                         *
                         * Every message used to be the same bordered box in one column, so a
                         * conversation read as a log rather than as an exchange — you had to read
                         * the name above each one to work out who was talking. Mine go right and
                         * carry the filled tint; everybody else's stay left behind their avatar.
                         */
                        const mine = message.authorUserId === me?.user.userId;

                        /*
                         * A run by one person is one block, not a stack of labelled cards.
                         *
                         * Three messages sent in a row repeated the name and the timestamp three
                         * times, which is most of what was on the screen. Five minutes is the
                         * usual boundary: past that the gap is long enough that the time is worth
                         * printing again.
                         */
                        const previous = open.messages[index - 1];
                        const runOn =
                          previous !== undefined &&
                          previous.authorUserId === message.authorUserId &&
                          new Date(message.sentAt).getTime() - new Date(previous.sentAt).getTime() <
                            5 * 60 * 1000;

                        return (
                          /*
                           * A message arrives rather than appearing. Keyed by its id, so this runs
                           * once when the message is first rendered and never again on a re-fetch.
                           *
                           * This is not a liveness claim. There is no socket bound and this screen
                           * deliberately has no typing indicator, presence dot or "live" badge — a
                           * test enforces that. A message easing in says "this is new to the
                           * list", which is true of a message that has just been loaded.
                           */
                          <motion.li
                            key={message.id}
                            className={[
                              'chat-message',
                              mine ? 'chat-message-mine' : '',
                              runOn ? 'chat-message-runon' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={transition('small', 'enter')}
                          >
                            {/*
                              The avatar column keeps its width even when no avatar is drawn, so a
                              run of messages stays in one line down the page instead of the second
                              one sliding left under the first.
                            */}
                            <span className="chat-avatar" aria-hidden="true">
                              {mine || runOn ? null : (
                                <span
                                  className="uboss-avatar uboss-avatar--sm"
                                  style={{ background: avatarTint(message.authorName) }}
                                >
                                  {initials(message.authorName)}
                                </span>
                              )}
                            </span>

                            <div className="chat-bubble">
                              {runOn ? null : (
                                <div className="chat-message-meta">
                                  <span>{mine ? 'You' : message.authorName}</span>
                                  <time dateTime={message.sentAt}>
                                    {messageTime(message.sentAt)}
                                  </time>
                                </div>
                              )}
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
                            </div>
                          </motion.li>
                        );
                      })}
                    </ul>

                    <div className="chat-compose">
                      {/*
                      What is attached, before it is sent.

                      Listed rather than counted: "2 files" is not something somebody can check,
                      and the one thing they want to do at this moment is take the wrong one off
                      again.

                      Above the typing line rather than below it, because the line is now a single
                      row that grows with the message and anything under it would be pushed about
                      as somebody types.
                    */}
                      {attached.length === 0 ? null : (
                        <ul className="chat-attached" data-testid="chat-attached">
                          {attached.map((file) => (
                            <li key={file.id}>
                              <Icon name="file" size={16} />
                              <span>{file.filename}</span>
                              <button
                                type="button"
                                className="uboss-link"
                                onClick={() =>
                                  setAttached((current) =>
                                    current.filter((entry) => entry.id !== file.id),
                                  )
                                }
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      {/*
                      The people `@` can reach, while one is being typed.

                      The placeholder has always said "use @name to mention somebody" and nothing
                      implemented it: the server resolves handles through a `mentionResolutions`
                      map the client sends, and the client never sent one, so every mention
                      resolved to nobody. Picking from a list is also the only way to get the
                      handle right — the server's pattern has no spaces in it, so "@Aman Singh" is
                      a mention of "Aman" and then a word.

                      Above the box rather than below: the composer sits at the foot of the pane,
                      and a list under it would open off the bottom of the window.
                    */}
                      {mentionOptions.length > 0 ? (
                        <ul className="chat-mentions" role="listbox" aria-label="Mention somebody">
                          {mentionOptions.map((person, index) => (
                            <li key={person.userId}>
                              <button
                                type="button"
                                className={
                                  index === mentionIndex ? 'chat-mention is-active' : 'chat-mention'
                                }
                                role="option"
                                aria-selected={index === mentionIndex}
                                /* The textarea must not lose focus before the click lands, or the
                                   cursor position the insert depends on is gone. */
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => pickMention(person)}
                              >
                                <span
                                  className="uboss-avatar uboss-avatar--sm"
                                  style={{ background: avatarTint(person.displayName) }}
                                  aria-hidden="true"
                                >
                                  {initials(person.displayName)}
                                </span>
                                <span className="chat-mention-name">{person.displayName}</span>
                                <span className="chat-mention-handle">
                                  @{handleFor(person.displayName)}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      {/*
                      One line: what you are typing, and the two things you can do with it.

                      The box was three rows tall and square, with the controls on their own line
                      underneath — a form, sat under a conversation. It is a rounded bar now,
                      one line high, that grows as the message does and goes back to one line once
                      it is sent. Both controls sit on that line rather than below it.

                      Neither carries a word: a paper clip and a paper plane are what every
                      composer uses, and the accessible name carries the meaning for anyone who
                      cannot see them. Send is the only filled control on the screen.
                    */}
                      <div className="chat-compose-row">
                        <textarea
                          ref={composer}
                          aria-label="Message"
                          value={draft}
                          rows={1}
                          onChange={(event) => {
                            setDraft(event.target.value);
                            setCaret(event.target.selectionStart);
                            setMentionIndex(0);
                          }}
                          /* Clicking or arrowing moves the cursor without changing the text, and
                             the picker depends on where the cursor is. */
                          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
                          onKeyDown={(event) => {
                            if (mentionOptions.length === 0) return;
                            /*
                              The picker takes these keys only while it is open, so the textarea
                              keeps them the rest of the time: Enter still makes a new line in a
                              message, and Escape still does nothing.
                            */
                            if (event.key === 'ArrowDown') {
                              event.preventDefault();
                              setMentionIndex((at) => (at + 1) % mentionOptions.length);
                            } else if (event.key === 'ArrowUp') {
                              event.preventDefault();
                              setMentionIndex(
                                (at) => (at - 1 + mentionOptions.length) % mentionOptions.length,
                              );
                            } else if (event.key === 'Enter' || event.key === 'Tab') {
                              const chosen = mentionOptions[mentionIndex];
                              if (chosen === undefined) return;
                              event.preventDefault();
                              pickMention(chosen);
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              // Closes it without touching the text: moving the cursor past the
                              // handle is what ends the mention.
                              setCaret(draft.length);
                            }
                          }}
                          placeholder="Write a message. Use @name to mention somebody."
                        />
                        <input
                          ref={fileInput}
                          type="file"
                          className="chat-file"
                          aria-label="Attach a file"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file !== undefined) void attach(file);
                            event.target.value = '';
                          }}
                        />
                        <button
                          type="button"
                          className="chat-compose-icon"
                          disabled={busy}
                          onClick={() => fileInput.current?.click()}
                          data-testid="chat-attach"
                          aria-label="Attach a file"
                          title="Attach a file"
                        >
                          <Icon name="file" size={18} />
                        </button>
                        <button
                          type="button"
                          className="chat-compose-icon chat-compose-send"
                          onClick={() => void send()}
                          disabled={busy || (draft.trim() === '' && attached.length === 0)}
                          /* The word the button no longer shows is the name it still carries. */
                          aria-label="Send"
                          title="Send"
                        >
                          <Icon name="send" size={18} />
                        </button>
                      </div>
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
              Still printed verbatim, in the server's words, because both are claims somebody would
              otherwise make on the product's behalf: that a linked Objective is readable because it
              is linked, and that "live" means a socket.

              Behind a disclosure rather than standing open. Two paragraphs about in-process
              publishers and socket transports, permanently under every conversation, is the
              "reading the software instead of using it" the audit brief opens on — and it was
              pushing the composer up the screen on a phone. Collapsed, not deleted: the honesty
              is the point of it, and `open` would defeat the change while `hidden` would hide it.
            */}
              <details className="chat-stances">
                <summary>How chat handles linked work and delivery</summary>
                <p className="chat-muted" data-testid="chat-context-stance">
                  {stances.context}
                </p>
                <p className="chat-muted" data-testid="chat-realtime-stance">
                  {stances.realtime}
                </p>
              </details>
            </CardBody>
          </Card>
        ) : null}
      </div>

      {tenantId === null ? null : (
        <RequestChangePanel
          tenantId={tenantId}
          open={requestingChange}
          conversationId={openId ?? undefined}
          onClose={() => setRequestingChange(false)}
          onFiled={setNotice}
        />
      )}
    </RoutedAppShell>
  );
}

/**
 * `useSearchParams()` needs a Suspense boundary or the production build fails outright.
 *
 * The boundary exists because Discuss deep-links here: `/chat?conversation=<id>` is how a
 * conversation started from an Objective or an Exception opens on the one screen that owns chat.
 */
/**
 * The time above a message.
 *
 * `toLocaleString()` printed `10/12/2026, 3:08:47 PM` inside every bubble — a date, a year and a
 * second's precision on something said a moment ago, taking more room than most messages. Today's
 * messages carry the time alone; older ones earn their date back, because that is the point at
 * which the date is the part you need.
 *
 * Seconds never appear. Nobody reading a conversation is placing two messages within one minute
 * of each other, and the order on the screen already answers it if they are.
 */
function messageTime(sentAt: string): string {
  const at = new Date(sentAt);
  const today = new Date();
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();

  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      });
}

/**
 * What to call a conversation.
 *
 * A group uses its title. A direct message is titled by the other person, because "Direct
 * message" is what it *is*, not what it is *about* — a list of six of them, all reading "Direct
 * message", tells you nothing and was what this screen showed.
 */
function conversationLabel(
  conversation: { title: string | null; participants?: { userId: string; displayName: string }[] },
  viewerUserId: string | null,
): string {
  if (conversation.title !== null && conversation.title.trim() !== '') return conversation.title;

  const others = (conversation.participants ?? []).filter(
    (participant) => participant.userId !== viewerUserId,
  );
  if (others.length === 1) return others[0]!.displayName;
  if (others.length > 1) return others.map((participant) => participant.displayName).join(', ');
  // A conversation with only yourself in it is a note to self, and saying so is better than
  // falling back to a label that describes the database.
  return 'Just you';
}

export default function WorkspaceChatPage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceChatInner />
    </Suspense>
  );
}
