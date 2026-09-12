import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ATTACHMENT_STANCE,
  CHAT_CONTEXT_LABELS,
  CHAT_CONTEXT_TYPES,
  CONTEXT_PERMISSION,
  CONTEXT_STANCE,
  CONVERSATION_KIND_LABELS,
  CONVERSATION_KINDS,
  directConversationKey,
  EXCLUDED_BY_DESIGN,
  MAX_GROUP_PARTICIPANTS,
  mentionHandles,
  mentionsOutsideConversation,
  messageProblems,
  MIN_SEARCH_TERM,
  participantProblems,
  REALTIME_STANCE,
  RESTRICTED_PREVIEW_REASON,
  restrictedPreview,
  SEARCH_STANCE,
  searchProblems,
  unreadCount,
} from './workspace-chat.js';
import { MODULE_KEYS } from './authorization.js';

describe('conversations come in two shapes and no more', () => {
  it('labels both', () => {
    assert.deepEqual([...CONVERSATION_KINDS], ['Direct', 'Group']);
    for (const kind of CONVERSATION_KINDS) {
      assert.ok(CONVERSATION_KIND_LABELS[kind].length > 0, kind);
    }
  });

  it('accepts a direct message between two people with no name', () => {
    assert.deepEqual(
      participantProblems({
        kind: 'Direct',
        participantUserIds: ['a', 'b'],
        createdByUserId: 'a',
      }),
      [],
    );
  });

  it('refuses a direct message that is not between two people', () => {
    assert.ok(
      participantProblems({
        kind: 'Direct',
        participantUserIds: ['a', 'b', 'c'],
        createdByUserId: 'a',
      }).length > 0,
    );
  });

  it('refuses a named direct message and an unnamed group', () => {
    // Naming a two-person chat is a feature nobody uses and a field everybody has to handle.
    assert.ok(
      participantProblems({
        kind: 'Direct',
        participantUserIds: ['a', 'b'],
        createdByUserId: 'a',
        title: 'Us two',
      }).length > 0,
    );
    assert.ok(
      participantProblems({
        kind: 'Group',
        participantUserIds: ['a', 'b'],
        createdByUserId: 'a',
        title: '  ',
      }).length > 0,
    );
  });

  it('refuses a conversation the creator is not in', () => {
    // A conversation you are not in is one you created for other people and cannot see. Either a
    // mistake or an attempt to make one, and both are worth refusing.
    const problems = participantProblems({
      kind: 'Group',
      participantUserIds: ['b', 'c'],
      createdByUserId: 'a',
      title: 'About you two',
    });
    assert.ok(problems.some((problem) => /not part of/i.test(problem)));
  });

  it('refuses somebody listed twice', () => {
    assert.ok(
      participantProblems({
        kind: 'Group',
        participantUserIds: ['a', 'b', 'b'],
        createdByUserId: 'a',
        title: 'Team',
      }).some((problem) => /twice/i.test(problem)),
    );
  });

  it('caps a group, and says why rather than only refusing', () => {
    const problems = participantProblems({
      kind: 'Group',
      participantUserIds: Array.from({ length: MAX_GROUP_PARTICIPANTS + 1 }, (_, i) => `u${i}`),
      createdByUserId: 'u0',
      title: 'Everybody',
    });
    assert.ok(problems.some((problem) => /moderation/i.test(problem)));
  });

  it('gives a pair one conversation key whichever way round they are', () => {
    // Without this, two people messaging each other at the same instant get two conversations and
    // each sees half the history — which presents as lost messages.
    assert.equal(directConversationKey('b', 'a'), directConversationKey('a', 'b'));
  });
});

describe('messages', () => {
  it('accepts text, or an attachment with no text', () => {
    assert.deepEqual(messageProblems({ body: 'Morning', attachmentIds: [] }), []);
    assert.deepEqual(messageProblems({ body: '', attachmentIds: ['f1'] }), []);
  });

  it('refuses nothing at all', () => {
    assert.ok(messageProblems({ body: '   ', attachmentIds: [] }).length > 0);
  });

  it('refuses more attachments than a message should carry', () => {
    assert.ok(
      messageProblems({
        body: 'Here',
        attachmentIds: ['1', '2', '3', '4', '5', '6'],
      }).length > 0,
    );
  });
});

describe('mentions', () => {
  it('finds handles and ignores an email address', () => {
    // `someone@example.com` is not a mention of `example`. Without the boundary check every email
    // in a message would notify a stranger.
    assert.deepEqual(mentionHandles('Hi @priya and @dev.ops').sort(), ['dev.ops', 'priya']);
    assert.deepEqual(mentionHandles('write to priya@example.com'), []);
  });

  it('does not repeat a handle mentioned twice', () => {
    assert.deepEqual(mentionHandles('@priya @priya'), ['priya']);
  });

  it('reports a mention of somebody outside the conversation', () => {
    // Resolving it would notify a person about a conversation they cannot open — which leaks that
    // it exists and sends them somewhere they are refused.
    assert.deepEqual(
      mentionsOutsideConversation({
        mentionedUserIds: ['a', 'x'],
        participantUserIds: ['a', 'b'],
      }),
      ['x'],
    );
  });
});

describe('unread state', () => {
  const message = (sentAt: string, authorUserId: string) => ({ sentAt, authorUserId });

  it('counts everything when nothing has been read', () => {
    assert.equal(
      unreadCount({
        messages: [message('2026-01-01T10:00:00Z', 'b'), message('2026-01-01T11:00:00Z', 'b')],
        lastReadAt: null,
        viewerUserId: 'a',
      }),
      2,
    );
  });

  it('never counts your own messages', () => {
    // A badge that counted them would make sending a message look like receiving one.
    assert.equal(
      unreadCount({
        messages: [message('2026-01-01T10:00:00Z', 'a')],
        lastReadAt: null,
        viewerUserId: 'a',
      }),
      0,
    );
  });

  it('counts only what arrived after the marker', () => {
    assert.equal(
      unreadCount({
        messages: [message('2026-01-01T10:00:00Z', 'b'), message('2026-01-01T12:00:00Z', 'b')],
        lastReadAt: '2026-01-01T11:00:00Z',
        viewerUserId: 'a',
      }),
      1,
    );
  });
});

describe('a context reference is a type and an id', () => {
  it('covers exactly the six the prompt names', () => {
    assert.deepEqual(
      [...CHAT_CONTEXT_TYPES],
      ['Objective', 'HumanTask', 'EngineAgent', 'AgentRun', 'ApprovalRequest', 'ExecutorException'],
    );
    for (const type of CHAT_CONTEXT_TYPES) {
      assert.ok(CHAT_CONTEXT_LABELS[type].length > 0, type);
    }
  });

  it('resolves every type against that resource’s own module', () => {
    // **The rule the whole feature turns on.** Resolving against a `chat` permission would make
    // chat an authority of its own, and being in a conversation would become a way to read things.
    const modules = new Set<string>(MODULE_KEYS);
    for (const type of CHAT_CONTEXT_TYPES) {
      const required = CONTEXT_PERMISSION[type];
      assert.ok(modules.has(required.module), `${type} names unknown module ${required.module}`);
      assert.notEqual(required.module, 'chat', `${type} resolves against chat`);
      assert.equal(required.action, 'View', `${type} needs more than View`);
    }
  });

  it('builds one refusal, with no hint of what was refused', () => {
    const preview = restrictedPreview({ type: 'Objective', id: 'obj-1' });
    assert.equal(preview.accessible, false);
    if (preview.accessible) return;
    assert.equal(preview.reason, RESTRICTED_PREVIEW_REASON);
    // The id comes back — it is already in the conversation the viewer can read, so withholding it
    // protects nothing and returning it lets them ask somebody for access.
    assert.equal(preview.id, 'obj-1');
    // What is withheld is everything that says what the thing *is*.
    assert.equal('title' in preview, false);
    assert.equal('status' in preview, false);
    assert.equal('deepLink' in preview, false);
  });

  it('says in the refusal that membership grants nothing', () => {
    assert.match(RESTRICTED_PREVIEW_REASON, /does not grant access/i);
  });

  it('states the stance in terms a customer could be shown', () => {
    assert.match(CONTEXT_STANCE, /type and an id/i);
    assert.match(CONTEXT_STANCE, /your own permissions/i);
  });
});

describe('search', () => {
  it('refuses a term too short to mean anything', () => {
    assert.ok(searchProblems('a').length > 0);
    assert.deepEqual(searchProblems('ab'), []);
    assert.equal(MIN_SEARCH_TERM, 2);
  });

  it('says it never reaches a conversation you are not in', () => {
    // The security property. A search across every message would be a read of every conversation.
    assert.match(SEARCH_STANCE, /conversations you are part of/i);
    assert.match(SEARCH_STANCE, /never reaches/i);
  });

  it('says it does not read inside attachments', () => {
    assert.match(SEARCH_STANCE, /does not read inside/i);
  });
});

describe('the boundary is written down', () => {
  it('excludes the Slack-scale features with a reason each', () => {
    assert.ok(EXCLUDED_BY_DESIGN.length >= 5);
    for (const entry of EXCLUDED_BY_DESIGN) {
      assert.ok(entry.feature.length > 0);
      assert.ok(entry.why.length > 30, `${entry.feature} has no argument`);
    }
  });

  it('names the four the prompt rules out', () => {
    const features = EXCLUDED_BY_DESIGN.map((entry) => entry.feature.toLowerCase()).join(' | ');
    for (const excluded of ['voice', 'social feed', 'presence', 'reaction']) {
      assert.ok(features.includes(excluded), `${excluded} is not on the excluded list`);
    }
  });

  it('explains presence rather than only excluding it', () => {
    // The interesting one: a green dot is either a live signal — needing a transport this does not
    // have — or it is invented, and an invented one tells you a colleague is available when they
    // are not.
    const presence = EXCLUDED_BY_DESIGN.find((entry) =>
      entry.feature.toLowerCase().includes('presence'),
    );
    assert.match(presence?.why ?? '', /invented/i);
  });

  it('does not claim realtime delivery it does not have', () => {
    assert.match(REALTIME_STANCE, /no socket transport is bound/i);
    assert.match(REALTIME_STANCE, /must not be described/i);
  });

  it('says an attachment is an ordinary file, scan and all', () => {
    assert.match(ATTACHMENT_STANCE, /same scan/i);
    assert.match(ATTACHMENT_STANCE, /cannot be opened/i);
  });
});
