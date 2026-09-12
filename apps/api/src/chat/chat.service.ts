import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  CHAT_CONTEXT_TYPES,
  directConversationKey,
  MAX_SEARCH_RESULTS,
  mentionHandles,
  mentionsOutsideConversation,
  messageProblems,
  participantProblems,
  searchProblems,
  unreadCount,
  type ChatContextRef,
  type ChatContextType,
  type ConversationKind,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { ChatContextService } from './chat-context.service.js';

export interface ConversationSummary {
  id: string;
  kind: ConversationKind;
  title: string | null;
  participantUserIds: string[];
  lastMessageAt: string | null;
  unread: number;
}

/**
 * Workspace Chat — Prompt 40A (CR-03) §6.
 *
 * ## Membership is the only gate, and it is not a permission
 *
 * Every read and write here checks one thing: **is the caller a current participant**. There is no
 * `chat` module in the permission set and deliberately so — a conversation is not company data that
 * a role grants access to, it is correspondence between specific people. A `chat:View` grant would
 * mean somebody could be given access to everybody's conversations, which is a capability no role
 * in this product should have.
 *
 * The corollary is the rule this whole feature is built around: **membership grants nothing else**.
 * Being in a conversation about a restricted Objective does not let you read the Objective. That is
 * `ChatContextService`' job, and it resolves every preview against the reader's own permissions.
 *
 * ## Why chat messages are not audited
 *
 * CR-03 says so directly — *"Do not audit every normal chat message unless compliance policy
 * requires it"* — and it is right. An audit trail that contained every message would be a second
 * copy of every conversation, in the one table designed never to be deleted, defeating both the
 * retention rules and the point of the trail. What **is** audited is the structural act: creating a
 * conversation, adding somebody, and attaching a context reference — because those change who can
 * see what.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
    private readonly context: ChatContextService,
  ) {}

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  /**
   * Start a conversation, or return the direct one that already exists.
   *
   * Idempotent for a direct message by construction: `directConversationKey` sorts the two ids, so
   * two people who message each other at the same instant converge on one row rather than creating
   * two and each seeing half the history.
   */
  async startConversation(input: {
    scope: TenantScope;
    actorUserId: string;
    kind: ConversationKind;
    participantUserIds: readonly string[];
    title?: string | undefined;
  }): Promise<{ id: string; created: boolean }> {
    const problems = participantProblems({
      kind: input.kind,
      participantUserIds: input.participantUserIds,
      createdByUserId: input.actorUserId,
      ...(input.title === undefined ? {} : { title: input.title }),
    });
    if (problems.length > 0) throw new BadRequestException(problems.join(' '));

    await this.assertAllAreColleagues(input.scope, input.participantUserIds);

    const directKey =
      input.kind === 'Direct'
        ? directConversationKey(
            input.participantUserIds[0] as string,
            input.participantUserIds[1] as string,
          )
        : null;

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      if (directKey !== null) {
        const existing = await this.prisma.client.chatConversation.findFirst({
          where: { tenantId: input.scope.tenantId, directKey },
          select: { id: true },
        });
        if (existing !== null) return { id: existing.id, created: false };
      }

      const conversation = await this.prisma.client.chatConversation.create({
        data: {
          tenantId: input.scope.tenantId,
          kind: input.kind,
          title: input.kind === 'Group' ? (input.title ?? null) : null,
          directKey,
          createdByUserId: input.actorUserId,
        },
      });

      await this.prisma.client.chatParticipant.createMany({
        data: input.participantUserIds.map((userId) => ({
          tenantId: input.scope.tenantId,
          conversationId: conversation.id,
          userId,
        })),
      });

      await this.audit.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'chat.conversation_started',
        actorUserId: input.actorUserId,
        resourceType: 'chat-conversation',
        resourceId: conversation.id,
        summary:
          input.kind === 'Direct'
            ? 'Started a direct conversation.'
            : `Started the group conversation "${input.title ?? ''}".`,
        // The participant *count*, not the list: who is in a conversation is the conversation's
        // business, and an audit trail is read by people who are not in it.
        metadata: { kind: input.kind, participants: input.participantUserIds.length },
      });

      return { id: conversation.id, created: true };
    });
  }

  /** The conversations this person is in, newest activity first. */
  async listConversations(input: {
    scope: TenantScope;
    actorUserId: string;
  }): Promise<ConversationSummary[]> {
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const mine = await this.prisma.client.chatParticipant.findMany({
        where: { tenantId: input.scope.tenantId, userId: input.actorUserId, leftAt: null },
        select: { conversationId: true, lastReadAt: true },
      });
      if (mine.length === 0) return [];

      const ids = mine.map((row) => row.conversationId);
      const readMarkers = new Map(mine.map((row) => [row.conversationId, row.lastReadAt]));

      const conversations = await this.prisma.client.chatConversation.findMany({
        where: { tenantId: input.scope.tenantId, id: { in: ids } },
        select: {
          id: true,
          kind: true,
          title: true,
          lastMessageAt: true,
          participants: { where: { leftAt: null }, select: { userId: true } },
          messages: {
            where: { deletedAt: null },
            select: { sentAt: true, authorUserId: true },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
      });

      return conversations.map((conversation) => ({
        id: conversation.id,
        kind: conversation.kind as ConversationKind,
        title: conversation.title,
        participantUserIds: conversation.participants.map((row) => row.userId),
        lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        unread: unreadCount({
          messages: conversation.messages.map((message) => ({
            sentAt: message.sentAt.toISOString(),
            authorUserId: message.authorUserId,
          })),
          lastReadAt: readMarkers.get(conversation.id)?.toISOString() ?? null,
          viewerUserId: input.actorUserId,
        }),
      }));
    });
  }

  /**
   * Read a conversation: its messages, and its context previews resolved for this viewer.
   *
   * The previews are the interesting part. Two people opening the same conversation see different
   * previews for the same reference, because each is resolved against their own permissions — and
   * that is correct rather than inconsistent.
   */
  async readConversation(input: {
    scope: TenantScope;
    actorUserId: string;
    conversationId: string;
  }): Promise<unknown> {
    await this.assertParticipant(input.scope, input.conversationId, input.actorUserId);

    const loaded = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const conversation = await this.prisma.client.chatConversation.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.conversationId },
        select: {
          id: true,
          kind: true,
          title: true,
          participants: { where: { leftAt: null }, select: { userId: true, joinedAt: true } },
          contextRefs: { select: { contextType: true, resourceId: true } },
        },
      });
      if (conversation === null) throw new NotFoundException('There is no such conversation.');

      const messages = await this.prisma.client.chatMessage.findMany({
        where: { tenantId: input.scope.tenantId, conversationId: input.conversationId },
        select: {
          id: true,
          authorUserId: true,
          body: true,
          mentionedUserIds: true,
          sentAt: true,
          deletedAt: true,
          attachments: {
            select: {
              storedFileId: true,
              file: { select: { filename: true, sizeBytes: true, scanState: true } },
            },
          },
        },
        orderBy: { sentAt: 'asc' },
        take: 500,
      });

      return { conversation, messages };
    });

    const refs: ChatContextRef[] = loaded.conversation.contextRefs.map((row) => ({
      type: row.contextType as ChatContextType,
      id: row.resourceId,
    }));

    const previews = await this.context.previewAll({
      scope: input.scope,
      viewerUserId: input.actorUserId,
      refs,
    });

    return {
      id: loaded.conversation.id,
      kind: loaded.conversation.kind,
      title: loaded.conversation.title,
      participantUserIds: loaded.conversation.participants.map((row) => row.userId),
      context: previews,
      messages: loaded.messages.map((message) => ({
        id: message.id,
        authorUserId: message.authorUserId,
        // A deleted message keeps its place so the reply below it still makes sense, and shows
        // that something was removed rather than silently closing the gap.
        body: message.deletedAt === null ? message.body : null,
        deleted: message.deletedAt !== null,
        mentionedUserIds: message.mentionedUserIds,
        sentAt: message.sentAt.toISOString(),
        attachments: message.attachments.map((attachment) => ({
          storedFileId: attachment.storedFileId,
          filename: attachment.file.filename,
          sizeBytes: attachment.file.sizeBytes,
          // **A file that has not been cleared cannot be opened**, and the screen says which.
          // Hiding it would make the conversation misleading; serving it would make chat the way
          // malware moves around a company.
          downloadable: attachment.file.scanState === 'Clean',
          scanState: attachment.file.scanState,
        })),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async sendMessage(input: {
    scope: TenantScope;
    actorUserId: string;
    conversationId: string;
    body: string;
    attachmentIds?: readonly string[] | undefined;
    /** Handle → user id, resolved by the caller against this company's directory. */
    mentionResolutions?: Record<string, string> | undefined;
  }): Promise<{ id: string; mentionedUserIds: string[]; ignoredMentions: string[] }> {
    const participants = await this.assertParticipant(
      input.scope,
      input.conversationId,
      input.actorUserId,
    );

    const attachmentIds = input.attachmentIds ?? [];
    const problems = messageProblems({ body: input.body, attachmentIds });
    if (problems.length > 0) throw new BadRequestException(problems.join(' '));

    const resolutions = input.mentionResolutions ?? {};
    const handles = mentionHandles(input.body);
    const resolved = handles
      .map((handle) => resolutions[handle])
      .filter((userId): userId is string => userId !== undefined);

    /**
     * A mention of somebody outside the conversation is dropped, and reported as dropped.
     *
     * Resolving it would notify a person about a conversation they cannot open — which both leaks
     * that it exists and sends them somewhere they will be refused. Reported rather than silently
     * ignored so the sender can be told "Dana is not in this conversation" and add them on purpose.
     */
    const outside = mentionsOutsideConversation({
      mentionedUserIds: resolved,
      participantUserIds: participants,
    });
    const mentionedUserIds = resolved.filter((userId) => !outside.includes(userId));

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      if (attachmentIds.length > 0) {
        // Every attachment must be a file in *this* company. Without this check an id from
        // another company would be accepted, and RLS would then hide the file while the join row
        // pointed at it — a broken attachment rather than a leak, but still wrong.
        const found = await this.prisma.client.storedFile.count({
          where: {
            tenantId: input.scope.tenantId,
            id: { in: [...attachmentIds] },
            deletedAt: null,
          },
        });
        if (found !== attachmentIds.length) {
          throw new BadRequestException('One of those attachments is not a file in this company.');
        }
      }

      const message = await this.prisma.client.chatMessage.create({
        data: {
          tenantId: input.scope.tenantId,
          conversationId: input.conversationId,
          authorUserId: input.actorUserId,
          body: input.body.trim(),
          mentionedUserIds,
        },
      });

      if (attachmentIds.length > 0) {
        await this.prisma.client.chatMessageAttachment.createMany({
          data: attachmentIds.map((storedFileId) => ({
            tenantId: input.scope.tenantId,
            messageId: message.id,
            storedFileId,
          })),
        });
      }

      await this.prisma.client.chatConversation.update({
        where: { id: input.conversationId },
        data: { lastMessageAt: message.sentAt },
      });

      return { id: message.id, mentionedUserIds, ignoredMentions: outside };
    });
  }

  /**
   * Delete your own message.
   *
   * The row stays and the body is blanked — enforced by `deleted_message_keeps_no_text`, so it is a
   * guarantee rather than a habit. Only the author: a conversation where other people can remove
   * your words is not correspondence.
   */
  async deleteMessage(input: {
    scope: TenantScope;
    actorUserId: string;
    conversationId: string;
    messageId: string;
  }): Promise<{ deleted: true }> {
    await this.assertParticipant(input.scope, input.conversationId, input.actorUserId);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const message = await this.prisma.client.chatMessage.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          id: input.messageId,
          conversationId: input.conversationId,
        },
        select: { authorUserId: true, deletedAt: true },
      });
      if (message === null) throw new NotFoundException('There is no such message.');
      if (message.authorUserId !== input.actorUserId) {
        throw new ForbiddenException('You can only delete your own messages.');
      }
      if (message.deletedAt !== null) return { deleted: true as const };

      await this.prisma.client.chatMessage.update({
        where: { id: input.messageId },
        data: { deletedAt: new Date(), body: '' },
      });
      return { deleted: true as const };
    });
  }

  /** Move this person's read marker to now. */
  async markRead(input: {
    scope: TenantScope;
    actorUserId: string;
    conversationId: string;
  }): Promise<{ lastReadAt: string }> {
    await this.assertParticipant(input.scope, input.conversationId, input.actorUserId);
    const now = new Date();

    await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.chatParticipant.updateMany({
        where: {
          tenantId: input.scope.tenantId,
          conversationId: input.conversationId,
          userId: input.actorUserId,
        },
        data: { lastReadAt: now },
      }),
    );

    return { lastReadAt: now.toISOString() };
  }

  // -------------------------------------------------------------------------
  // Context references
  // -------------------------------------------------------------------------

  /**
   * Attach a "we are discussing this" reference.
   *
   * **Requires that the person attaching it can see the thing.** Otherwise anybody could attach a
   * reference to an arbitrary id and wait for a colleague with access to open the conversation and
   * render the preview for them — using somebody else's permissions as an oracle. Checking at
   * attach time closes that, and checking again at every read closes the case where access is lost
   * afterwards.
   */
  async addContext(input: {
    scope: TenantScope;
    actorUserId: string;
    conversationId: string;
    ref: ChatContextRef;
  }): Promise<{ added: boolean }> {
    await this.assertParticipant(input.scope, input.conversationId, input.actorUserId);

    if (!CHAT_CONTEXT_TYPES.includes(input.ref.type)) {
      throw new BadRequestException(
        `A conversation can refer to: ${CHAT_CONTEXT_TYPES.join(', ')}.`,
      );
    }

    const preview = await this.context.preview({
      scope: input.scope,
      viewerUserId: input.actorUserId,
      ref: input.ref,
    });
    if (!preview.accessible) {
      throw new ForbiddenException('You cannot link something you do not have access to yourself.');
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.chatContextRefRow.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          conversationId: input.conversationId,
          contextType: input.ref.type,
          resourceId: input.ref.id,
        },
        select: { id: true },
      });
      if (existing !== null) return { added: false };

      await this.prisma.client.chatContextRefRow.create({
        data: {
          tenantId: input.scope.tenantId,
          conversationId: input.conversationId,
          contextType: input.ref.type,
          resourceId: input.ref.id,
          addedByUserId: input.actorUserId,
        },
      });

      // Audited, unlike a message: attaching a reference changes what the conversation is about
      // and therefore what previews it will try to render.
      await this.audit.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'chat.context_linked',
        actorUserId: input.actorUserId,
        resourceType: 'chat-conversation',
        resourceId: input.conversationId,
        summary: `Linked a ${input.ref.type} to the conversation.`,
        metadata: { contextType: input.ref.type },
      });

      return { added: true };
    });
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Search messages in conversations this person is in.
   *
   * **Scoped to their own conversations, and that is the security property.** A search across every
   * message in the company would be a read of every conversation — the same escalation as an
   * unchecked context preview, and far easier to run. Attachment contents are not searched: that
   * needs extraction, which needs opening files, which is an authorization and scanning surface of
   * its own. Names are searched, and `SEARCH_STANCE` says exactly that.
   */
  async search(input: {
    scope: TenantScope;
    actorUserId: string;
    term: string;
  }): Promise<{ messages: unknown[]; stance: string }> {
    const problems = searchProblems(input.term);
    if (problems.length > 0) throw new BadRequestException(problems.join(' '));

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const mine = await this.prisma.client.chatParticipant.findMany({
        where: { tenantId: input.scope.tenantId, userId: input.actorUserId, leftAt: null },
        select: { conversationId: true },
      });
      const ids = mine.map((row) => row.conversationId);
      if (ids.length === 0) {
        return { messages: [], stance: 'You are not in any conversations yet.' };
      }

      const messages = await this.prisma.client.chatMessage.findMany({
        where: {
          tenantId: input.scope.tenantId,
          conversationId: { in: ids },
          deletedAt: null,
          body: { contains: input.term, mode: 'insensitive' },
        },
        select: {
          id: true,
          conversationId: true,
          authorUserId: true,
          body: true,
          sentAt: true,
        },
        orderBy: { sentAt: 'desc' },
        take: MAX_SEARCH_RESULTS,
      });

      const byName = await this.prisma.client.chatMessageAttachment.findMany({
        where: {
          tenantId: input.scope.tenantId,
          message: { conversationId: { in: ids }, deletedAt: null },
          file: { filename: { contains: input.term, mode: 'insensitive' } },
        },
        select: {
          messageId: true,
          file: { select: { filename: true } },
          message: { select: { conversationId: true, sentAt: true, authorUserId: true } },
        },
        take: MAX_SEARCH_RESULTS,
      });

      return {
        messages: [
          ...messages.map((message) => ({
            kind: 'message' as const,
            id: message.id,
            conversationId: message.conversationId,
            authorUserId: message.authorUserId,
            body: message.body,
            sentAt: message.sentAt.toISOString(),
          })),
          ...byName.map((attachment) => ({
            kind: 'attachment' as const,
            id: attachment.messageId,
            conversationId: attachment.message.conversationId,
            authorUserId: attachment.message.authorUserId,
            filename: attachment.file.filename,
            sentAt: attachment.message.sentAt.toISOString(),
          })),
        ],
        stance: 'Only conversations you are part of.',
      };
    });
  }

  // -------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------

  /**
   * The only gate: are you in this conversation?
   *
   * Returns the participant list, because every caller needs it next — for mention filtering, or
   * to render who is there. A separate read would be a second query and a second chance to forget
   * the check.
   *
   * A non-participant gets `NotFoundException`, not `Forbidden`. Deliberate: "you are not allowed
   * in that conversation" confirms the conversation exists and that these particular people are
   * talking, which is itself something a conversation's participants have not shared.
   */
  private async assertParticipant(
    scope: TenantScope,
    conversationId: string,
    userId: string,
  ): Promise<string[]> {
    const participants = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.chatParticipant.findMany({
        where: { tenantId: scope.tenantId, conversationId, leftAt: null },
        select: { userId: true },
      }),
    );

    const ids = participants.map((row) => row.userId);
    if (!ids.includes(userId)) {
      throw new NotFoundException('There is no such conversation.');
    }
    return ids;
  }

  /**
   * Everybody in a conversation must be an active member of this company.
   *
   * Checked against `tenant_memberships` rather than trusting the ids, because a conversation is
   * the one place a caller supplies a list of user ids — and an id from another company would
   * otherwise create a participant row that RLS could not see but that existed.
   */
  private async assertAllAreColleagues(
    scope: TenantScope,
    userIds: readonly string[],
  ): Promise<void> {
    const count = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.tenantMembership.count({
        where: {
          tenantId: scope.tenantId,
          userId: { in: [...new Set(userIds)] },
          accountState: 'Active',
        },
      }),
    );

    if (count !== new Set(userIds).size) {
      throw new BadRequestException('One of those people is not an active member of this company.');
    }
  }
}
