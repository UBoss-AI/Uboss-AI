import { Module } from '@nestjs/common';

import { ChatContextService } from './chat-context.service.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

/**
 * Workspace Chat — Prompt 40A (CR-03) §6.
 *
 * Not `@Global`, unlike most feature modules here, and the reason is worth stating: nothing else in
 * the product needs to send a message. Chat reads other modules' resources — through
 * `ChatContextService`, always with the reader's own permissions — and is read by none of them. It
 * is a leaf, like `ReportsModule`, so it is imported late and exports only what a test needs.
 */
@Module({
  controllers: [ChatController],
  providers: [ChatService, ChatContextService],
  exports: [ChatService, ChatContextService],
})
export class ChatModule {}
