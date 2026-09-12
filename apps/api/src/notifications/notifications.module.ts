import { Global, Module } from '@nestjs/common';

import { EmailAdapter, LoggingEmailAdapter } from './email-adapter.js';
import { NotificationDispatcherService } from './notification-dispatcher.service.js';
import { NotificationOperationsController } from './notification-operations.controller.js';
import { NotificationController } from './notification.controller.js';
import { NotificationService } from './notification.service.js';
import { SecurityNotificationBridge } from './security-notification.bridge.js';

/**
 * Notifications and escalation.
 *
 * `@Global` because almost every later module raises notifications — approvals, to-do, Engine
 * Agent runs, connections, budgets — and each needs `raise`, not a screen. The alternative is
 * every module importing this one, or worse, each growing its own notification path, which is
 * exactly the duplicate-framework mistake the reuse rule exists to prevent.
 *
 * `EmailAdapter` is provided as the **logging** adapter, which records and sends nothing. A
 * deployment with a verified provider swaps this one line; everything above it — the outbox's
 * at-least-once delivery, its backoff, its dead-lettering, the dispatcher's audit trail — is
 * unchanged, because the transport was always the only missing piece.
 */
@Global()
@Module({
  controllers: [NotificationController, NotificationOperationsController],
  providers: [
    NotificationService,
    NotificationDispatcherService,
    { provide: EmailAdapter, useClass: LoggingEmailAdapter },
    // Subscribes to the Prompt 8 suspicious-activity seam, which was built for exactly this.
    SecurityNotificationBridge,
  ],
  exports: [NotificationService, NotificationDispatcherService, EmailAdapter],
})
export class NotificationsModule {}
