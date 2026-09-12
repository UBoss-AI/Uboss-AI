import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import {
  ATTACHMENT_STANCE,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_CONTEXT_LABELS,
  CHAT_CONTEXT_TYPES,
  CONTEXT_STANCE,
  CONVERSATION_KIND_LABELS,
  CONVERSATION_KINDS,
  EXCLUDED_BY_DESIGN,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_GROUP_PARTICIPANTS,
  MAX_MESSAGE_BODY,
  REALTIME_STANCE,
  SEARCH_STANCE,
  type ChatContextType,
  type ConversationKind,
} from '@uboss/types';

import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { ChatService } from './chat.service.js';

class StartConversationDto {
  @IsIn(CONVERSATION_KINDS as readonly string[]) kind!: ConversationKind;
  @IsArray() @ArrayMaxSize(MAX_GROUP_PARTICIPANTS) @IsUUID(7, { each: true })
  participantUserIds!: string[];
  @IsOptional() @IsString() @MaxLength(120) title?: string;
}

class SendMessageDto {
  @IsString() @MaxLength(MAX_MESSAGE_BODY) body!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_ATTACHMENTS_PER_MESSAGE) @IsUUID(7, { each: true })
  attachmentIds?: string[];
  /** Handle → user id. Resolved by the client from the company directory it already shows. */
  @IsOptional() @IsObject() mentionResolutions?: Record<string, string>;
}

class AddContextDto {
  @IsIn(CHAT_CONTEXT_TYPES as readonly string[]) contextType!: ChatContextType;
  @IsUUID(7) resourceId!: string;
}

/**
 * Workspace Chat — Prompt 40A (CR-03) §6.
 *
 * ## No `@RequirePermission` anywhere, and that is the design
 *
 * Every route here is gated on **being a participant**, which the service checks. There is
 * deliberately no `chat` module in the permission set: a conversation is correspondence between
 * specific people, not company data a role grants access to. A `chat:View` grant would mean
 * somebody could be given access to everybody's conversations, which is a capability no role in
 * this product should have — and an administrator who needs a conversation for an investigation
 * goes through break-glass, which is recorded, time-boxed and tells the customer.
 *
 * `@TenantScoped` still applies, so a verified membership in this company is required before any
 * of this runs.
 */
@Controller('tenants/:tenantId/chat')
@TenantScoped()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /** What chat is, what it will not become, and how live it actually is. */
  @Get('meta')
  async meta(): Promise<unknown> {
    return {
      kinds: CONVERSATION_KINDS.map((kind) => ({
        key: kind,
        label: CONVERSATION_KIND_LABELS[kind],
      })),
      contextTypes: CHAT_CONTEXT_TYPES.map((type) => ({
        key: type,
        label: CHAT_CONTEXT_LABELS[type],
      })),
      limits: {
        maxGroupParticipants: MAX_GROUP_PARTICIPANTS,
        maxMessageBody: MAX_MESSAGE_BODY,
        maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
        maxAttachmentBytes: CHAT_ATTACHMENT_MAX_BYTES,
      },
      // Served verbatim. Each is a claim somebody would otherwise overstate — especially the
      // last two: that a linked Objective is readable because it is linked, and that "live" means
      // a socket.
      contextStance: CONTEXT_STANCE,
      attachmentStance: ATTACHMENT_STANCE,
      searchStance: SEARCH_STANCE,
      realtimeStance: REALTIME_STANCE,
      excludedByDesign: EXCLUDED_BY_DESIGN,
    };
  }

  @Get('conversations')
  async list(@Param('tenantId') tenantId: string): Promise<unknown> {
    return {
      conversations: await this.chat.listConversations({
        scope: tenantScopeForPlatformOperation(tenantId),
        actorUserId: this.me(),
      }),
    };
  }

  @Post('conversations')
  async start(
    @Param('tenantId') tenantId: string,
    @Body() body: StartConversationDto,
  ): Promise<unknown> {
    return this.chat.startConversation({
      scope: tenantScopeForPlatformOperation(tenantId),
      actorUserId: this.me(),
      kind: body.kind,
      participantUserIds: body.participantUserIds,
      ...(body.title === undefined ? {} : { title: body.title }),
    });
  }

  @Get('conversations/:conversationId')
  async read(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
  ): Promise<unknown> {
    return this.chat.readConversation({
      scope: tenantScopeForPlatformOperation(tenantId),
      actorUserId: this.me(),
      conversationId,
    });
  }

  @Post('conversations/:conversationId/messages')
  async send(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: SendMessageDto,
  ): Promise<unknown> {
    return this.chat.sendMessage({
      scope: tenantScopeForPlatformOperation(tenantId),
      actorUserId: this.me(),
      conversationId,
      body: body.body,
      ...(body.attachmentIds === undefined ? {} : { attachmentIds: body.attachmentIds }),
      ...(body.mentionResolutions === undefined
        ? {}
        : { mentionResolutions: body.mentionResolutions }),
    });
  }

  @Delete('conversations/:conversationId/messages/:messageId')
  async remove(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<unknown> {
    return this.chat.deleteMessage({
      scope: tenantScopeForPlatformOperation(tenantId),
      actorUserId: this.me(),
      conversationId,
      messageId,
    });
  }

  @Post('conversations/:conversationId/read')
  async markRead(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
  ): Promise<unknown> {
    return this.chat.markRead({
      scope: tenantScopeForPlatformOperation(tenantId),
      actorUserId: this.me(),
      conversationId,
    });
  }

  /** The contextual "Discuss this" link from an Objective, task, agent, run, approval or exception. */
  @Post('conversations/:conversationId/context')
  async addContext(
    @Param('tenantId') tenantId: string,
    @Param('conversationId') conversationId: string,
    @Body() body: AddContextDto,
  ): Promise<unknown> {
    return this.chat.addContext({
      scope: tenantScopeForPlatformOperation(tenantId),
      actorUserId: this.me(),
      conversationId,
      ref: { type: body.contextType, id: body.resourceId },
    });
  }

  @Get('search')
  async search(
    @Param('tenantId') tenantId: string,
    @Query('q') term = '',
  ): Promise<unknown> {
    return this.chat.search({
      scope: tenantScopeForPlatformOperation(tenantId),
      actorUserId: this.me(),
      term,
    });
  }

  private me(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Chat is for signed-in members of this company.');
    }
    return id;
  }
}
