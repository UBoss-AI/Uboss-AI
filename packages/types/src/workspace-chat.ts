/**
 * UBoss Workspace Chat — Prompt 40A (CR-03).
 *
 * ## The one rule everything else here serves
 *
 * **Chat membership never grants access to the referenced resource.**
 *
 * A conversation can be *about* an Objective, a task, an agent run, an approval or an exception,
 * and being in that conversation must not let anybody see any of those. Get this wrong and chat
 * becomes the easiest privilege escalation in the product: invite yourself to a thread, read the
 * context preview, and walk out with a restricted Objective — with no permission check anywhere
 * near it, because the check was on the conversation and the conversation was yours.
 *
 * So a context reference stores **only a type and an id**. Every preview is resolved against the
 * *viewer's* own authorization at read time, and a viewer without access gets a stated refusal
 * rather than a blank — `restrictedPreview` exists so a screen shows "you do not have access to
 * this" instead of an empty box the reader mistakes for a bug.
 *
 * ## What this deliberately is not
 *
 * Not a Slack clone, and the prompt lists the exclusions by name: no voice, no video, no social
 * feed, no fake presence or activity, no GIF or reaction ecosystem. `EXCLUDED_BY_DESIGN` holds
 * them as data, because a scope boundary nobody wrote down is a scope boundary somebody quietly
 * crosses — and each of these would be weeks of work that makes the product worse at what it is
 * for.
 *
 * **Presence in particular.** A green dot is either a live signal — which needs a socket transport
 * UBoss does not have — or it is invented. An invented one tells people a colleague is available
 * when they are not, which is worse than no dot at all.
 */

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * The two shapes a conversation comes in.
 *
 * `Direct` is between exactly two people and has no name — naming a two-person chat is a feature
 * nobody uses and a field everybody has to handle. `Group` is a small named conversation.
 *
 * No channels, no threads-within-threads, no workspaces-within-workspaces. The prompt says "small
 * group/team conversation", and a hierarchy of containers is the thing that makes chat products
 * large.
 */
export const CONVERSATION_KINDS = ['Direct', 'Group'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_KIND_LABELS: Record<ConversationKind, string> = {
  Direct: 'Direct message',
  Group: 'Group conversation',
};

/**
 * How many people may be in one group conversation.
 *
 * Twenty. Not a technical limit — a statement about what this feature is. Past about twenty a
 * conversation needs moderation, roles, pinned messages and announcement-only modes, which is the
 * Slack-scale product the prompt rules out. A team that needs more is a team that needs a
 * different tool, and saying so is better than growing into one badly.
 */
export const MAX_GROUP_PARTICIPANTS = 20;

export const MAX_CONVERSATION_TITLE = 120;
export const MAX_MESSAGE_BODY = 4_000;

export interface ConversationParticipant {
  userId: string;
  /** When they were added, so a joiner's view of history can be reasoned about. */
  joinedAt: string;
  /** Null while they are still a participant. */
  leftAt: string | null;
}

export function participantProblems(input: {
  kind: ConversationKind;
  participantUserIds: readonly string[];
  title?: string | undefined;
  createdByUserId: string;
}): string[] {
  const problems: string[] = [];
  const unique = new Set(input.participantUserIds);

  if (unique.size !== input.participantUserIds.length) {
    problems.push('Somebody is listed twice.');
  }

  if (!unique.has(input.createdByUserId)) {
    // A conversation you are not in is a conversation you created for other people and cannot
    // see. Either it is a mistake or it is an attempt to make one; both are worth refusing.
    problems.push('You cannot start a conversation you are not part of.');
  }

  if (input.kind === 'Direct') {
    if (unique.size !== 2) {
      problems.push('A direct message is between exactly two people.');
    }
    if (input.title !== undefined && input.title.trim() !== '') {
      problems.push('A direct message does not have a name.');
    }
  } else {
    if (unique.size < 2) {
      problems.push('A group conversation needs at least two people.');
    }
    if (unique.size > MAX_GROUP_PARTICIPANTS) {
      problems.push(
        `A group conversation holds up to ${MAX_GROUP_PARTICIPANTS} people. Past that a ` +
          'conversation needs moderation and announcement modes, which this is deliberately not.',
      );
    }
    if ((input.title ?? '').trim() === '') {
      problems.push('Give the group a name, so people can tell their conversations apart.');
    } else if ((input.title ?? '').length > MAX_CONVERSATION_TITLE) {
      problems.push(`A name is at most ${MAX_CONVERSATION_TITLE} characters.`);
    }
  }

  return problems;
}

/**
 * The stable identity of a direct conversation between two people.
 *
 * Sorted and joined, so "Alice and Bob" and "Bob and Alice" are the same key. Without it, two
 * people who message each other at the same moment end up with two direct conversations and each
 * sees half the history — a bug that looks like lost messages and is very hard to explain.
 */
export function directConversationKey(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join(':');
}

// ---------------------------------------------------------------------------
// Messages, mentions and unread state
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  conversationId: string;
  authorUserId: string;
  body: string;
  /** User ids extracted from the body at write time. */
  mentionedUserIds: readonly string[];
  attachmentIds: readonly string[];
  sentAt: string;
  /** Set when the author deleted it; the row stays so the conversation does not lose its shape. */
  deletedAt: string | null;
}

export function messageProblems(input: {
  body: string;
  attachmentIds: readonly string[];
}): string[] {
  const problems: string[] = [];
  const body = input.body.trim();

  if (body === '' && input.attachmentIds.length === 0) {
    problems.push('Say something, or attach something.');
  }
  if (input.body.length > MAX_MESSAGE_BODY) {
    problems.push(`A message is at most ${MAX_MESSAGE_BODY} characters.`);
  }
  if (input.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    problems.push(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments on one message.`);
  }
  return problems;
}

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/**
 * Find the mentions in a message body.
 *
 * `@` followed by a handle. Returns the **handles**, not user ids: resolving a handle to a person
 * is a tenant-scoped lookup, and doing it here would mean this pure function needed a directory.
 *
 * A mention of somebody **outside the conversation** is not a mention. Resolving it would notify a
 * person about a conversation they cannot open — which both leaks the fact that it exists and sends
 * them somewhere they are refused. The caller filters against the participant list, and
 * `mentionsOutsideConversation` exists so a screen can say "Dana is not in this conversation"
 * rather than silently doing nothing.
 */
export function mentionHandles(body: string): string[] {
  const found = new Set<string>();
  const pattern = /(^|[^\w@])@([A-Za-z0-9._-]{2,60})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match[2] !== undefined) found.add(match[2]);
  }
  return [...found];
}

export function mentionsOutsideConversation(input: {
  mentionedUserIds: readonly string[];
  participantUserIds: readonly string[];
}): string[] {
  const participants = new Set(input.participantUserIds);
  return input.mentionedUserIds.filter((userId) => !participants.has(userId));
}

/**
 * Unread state, computed from a read marker rather than stored per message.
 *
 * One `lastReadAt` per participant per conversation, not a row per person per message. With a
 * hundred people and a thousand messages the per-message table is a hundred thousand rows that
 * exist only to render a number — and every one of them is a write on a screen scroll.
 *
 * The trade is real and worth stating: a marker cannot express "read the newest and skipped one in
 * the middle". Nobody needs that, and pretending otherwise is how the hundred thousand rows get
 * built.
 */
export function unreadCount(input: {
  messages: readonly { sentAt: string; authorUserId: string }[];
  lastReadAt: string | null;
  viewerUserId: string;
}): number {
  return input.messages.filter((message) => {
    // Your own messages are never unread. A badge that counted them would make sending a message
    // look like receiving one.
    if (message.authorUserId === input.viewerUserId) return false;
    if (input.lastReadAt === null) return true;
    return message.sentAt > input.lastReadAt;
  }).length;
}

// ---------------------------------------------------------------------------
// Contextual references — the security-critical part
// ---------------------------------------------------------------------------

/**
 * What a conversation can be *about*.
 *
 * Exactly the six the prompt names. A closed set, because each one needs a resolver that knows how
 * to check the viewer's access to that kind of thing — an open `resourceType: string` would let a
 * later prompt add a seventh with no resolver and get an unchecked preview for free.
 */
export const CHAT_CONTEXT_TYPES = [
  'Objective',
  'HumanTask',
  'EngineAgent',
  'AgentRun',
  'ApprovalRequest',
  'ExecutorException',
] as const;
export type ChatContextType = (typeof CHAT_CONTEXT_TYPES)[number];

export const CHAT_CONTEXT_LABELS: Record<ChatContextType, string> = {
  Objective: 'Objective',
  HumanTask: 'Task',
  EngineAgent: 'Engine Agent',
  AgentRun: 'Agent run',
  ApprovalRequest: 'Approval',
  ExecutorException: 'Exception',
};

/**
 * A stored reference. **A type and an id, and nothing else.**
 *
 * No cached title, no cached status, no cached summary — and that absence is the design. A cached
 * title is a copy of the resource's content sitting outside its own authorization: the moment it
 * is stored, anybody who can read the conversation can read it, and no permission check will ever
 * run again. It would also go stale, so it would be a leak *and* wrong.
 */
export interface ChatContextRef {
  type: ChatContextType;
  id: string;
}

/**
 * What a viewer is shown for a reference.
 *
 * Two shapes, and the discriminator is `accessible`. This is a union rather than an object with
 * optional fields so that **a caller cannot read `title` without having handled the refused case**
 * — the type system enforces the check the comment asks for.
 */
export type ChatContextPreview =
  | {
      accessible: true;
      type: ChatContextType;
      id: string;
      /** Resolved now, against this viewer's authorization. Never stored on the conversation. */
      title: string;
      status: string | null;
      deepLink: string;
    }
  | {
      accessible: false;
      type: ChatContextType;
      /**
       * The id is still returned, deliberately.
       *
       * It is already in the conversation the viewer can read, so withholding it protects nothing —
       * and returning it lets them quote it when asking somebody for access. What is withheld is
       * everything that would tell them what the thing *is*.
       */
      id: string;
      reason: string;
    };

export const RESTRICTED_PREVIEW_REASON =
  'This conversation refers to something you do not have access to. Being in the conversation ' +
  'does not grant access — ask the owner if you need it.';

/**
 * Build the refusal.
 *
 * A function rather than a literal at each call site, so every resolver refuses identically. Six
 * resolvers writing their own wording is six chances for one of them to say something that reveals
 * what was refused.
 */
export function restrictedPreview(ref: ChatContextRef): ChatContextPreview {
  return {
    accessible: false,
    type: ref.type,
    id: ref.id,
    reason: RESTRICTED_PREVIEW_REASON,
  };
}

/**
 * The permission each context type is resolved against.
 *
 * The resource's **own** module, never `chat`. That is the whole point: a preview is a read of that
 * resource, so it answers to that resource's permission exactly as the resource's own screen does.
 *
 * `AgentRun` resolves against `agents` rather than a module of its own, because a run is something
 * an agent did and the company screen that shows runs is Engine Agents.
 */
export const CONTEXT_PERMISSION: Record<ChatContextType, { module: string; action: string }> = {
  Objective: { module: 'objective', action: 'View' },
  HumanTask: { module: 'todo', action: 'View' },
  EngineAgent: { module: 'agents', action: 'View' },
  AgentRun: { module: 'agents', action: 'View' },
  ApprovalRequest: { module: 'approvals', action: 'View' },
  ExecutorException: { module: 'executor', action: 'View' },
};

export const CONTEXT_STANCE =
  'A conversation can refer to an Objective, a task, an agent, a run, an approval or an exception. ' +
  'The reference is a type and an id. What you see of it is resolved against your own permissions ' +
  'every time you open the conversation — so joining a conversation never gives you access to ' +
  'anything, and losing access removes the preview without anybody editing the conversation.';

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Attachments go through the Prompt 35 file layer, not a second one.
 *
 * Which means they inherit the validation, the size ceiling, the malware scan and the storage
 * abstraction that already exist — and it means a chat attachment cannot become the one upload path
 * in the product that nothing scans. A second file pipeline "just for chat" is exactly how that
 * happens.
 *
 * **A quarantined attachment is not downloadable**, and the message still shows that something was
 * attached. Hiding it would make the conversation misleading; serving it would make chat the way
 * malware moves around a company.
 */
export const ATTACHMENT_STANCE =
  'A chat attachment is a file in your company file store: same size limits, same checks, same ' +
  'scan, same audit. If a scan has not cleared it, it is shown as attached and cannot be opened.';

export const CHAT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * What chat search covers, and the bit that would be a leak if it did not.
 *
 * **Only conversations the searcher is in.** A search that reached every message in the company
 * would be a read of every conversation, which is the same escalation as an unchecked context
 * preview wearing a different hat — and it would be far easier to run.
 *
 * Attachment *contents* are not searched: that needs extraction, which needs opening files, which
 * is a scan-and-authorization surface of its own. Names are searched, and the stance says so.
 */
export const SEARCH_STANCE =
  'Search covers messages and attachment names in conversations you are part of. It does not read ' +
  'inside attachments, and it never reaches a conversation you are not in.';

export const MIN_SEARCH_TERM = 2;
export const MAX_SEARCH_RESULTS = 50;

export function searchProblems(term: string): string[] {
  const trimmed = term.trim();
  if (trimmed.length < MIN_SEARCH_TERM) {
    return [`Type at least ${MIN_SEARCH_TERM} characters.`];
  }
  return [];
}

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

/**
 * What Workspace Chat will not become, with the reason for each.
 *
 * Served by the API so the boundary is visible to whoever asks for the feature next, rather than
 * living in one person's memory of a prompt.
 */
export const EXCLUDED_BY_DESIGN: readonly { feature: string; why: string }[] = [
  {
    feature: 'Voice and video calls',
    why: 'A different product with different infrastructure, and every company already has one.',
  },
  {
    feature: 'A social feed',
    why: 'UBoss is a place work is recorded, not a place attention is competed for.',
  },
  {
    feature: 'Presence and activity indicators',
    why:
      'A green dot is either a live signal — which needs a socket transport this does not have — ' +
      'or it is invented. An invented one tells you a colleague is available when they are not.',
  },
  {
    feature: 'Reactions, emoji and GIFs',
    why:
      'An ecosystem rather than a feature: pickers, skin tones, custom uploads, per-tenant sets. ' +
      'It would be the largest part of chat by code and the smallest by value here.',
  },
  {
    feature: 'Channels and threads within threads',
    why: 'A hierarchy of containers is what turns a chat feature into a chat platform.',
  },
  {
    feature: 'Message editing history',
    why:
      'Delete leaves the message row so the conversation keeps its shape. A full edit trail is an ' +
      'audit feature, and the audit trail is where audit features belong.',
  },
];

/**
 * How live delivery works today, stated rather than implied.
 *
 * The realtime seam in this codebase (`RunProgressGateway`) is a **transport-free publisher**: it
 * fans events out to in-process subscribers and there is no socket server bound to it. Chat uses
 * the same pattern, which means the durable messages are real and complete, and "live" today means
 * a client polls.
 *
 * Said plainly because the alternative is somebody demonstrating chat and calling it realtime.
 */
export const REALTIME_STANCE =
  'Messages are durable and complete the moment they are sent. Live delivery uses the same ' +
  'in-process publisher the run engine uses, and no socket transport is bound in this build — so ' +
  'a client sees new messages when it next asks. UBoss must not be described as having realtime ' +
  'chat delivery until a transport is wired.';
