import { Global, Module } from '@nestjs/common';

import { EmailAdapter } from './email-adapter.js';
import { NotificationDispatcherService } from './notification-dispatcher.service.js';
import { NotificationOperationsController } from './notification-operations.controller.js';
import { NotificationController } from './notification.controller.js';
import { NotificationService } from './notification.service.js';
import { SecurityNotificationBridge } from './security-notification.bridge.js';
import { OutboxDispatchRunner } from './outbox-dispatch.runner.js';
import { chooseEmailAdapter } from './smtp-email-adapter.js';

/**
 * Notifications and escalation.
 *
 * `@Global` because almost every later module raises notifications — approvals, to-do, Engine
 * Agent runs, connections, budgets — and each needs `raise`, not a screen. The alternative is
 * every module importing this one, or worse, each growing its own notification path, which is
 * exactly the duplicate-framework mistake the reuse rule exists to prevent.
 *
 * `EmailAdapter` is chosen from the environment. With a complete `UBOSS_SMTP_*` set it is the
 * SMTP transport; with none of it, the **logging** adapter, which records and sends nothing and
 * says so through `deliversRealMail: false`. Everything above the seam — the outbox's
 * at-least-once delivery, its backoff, its dead-lettering, the dispatcher's audit trail — is the
 * same either way, because the transport was always the only missing piece.
 *
 * The choice is made once, at construction, and logged. A half-configured SMTP environment
 * **throws** rather than falling back: somebody who set a host and forgot the password has a
 * broken deployment, and silently sending nothing is how that survives to production.
 */
@Global()
@Module({
  controllers: [NotificationController, NotificationOperationsController],
  providers: [
    NotificationService,
    NotificationDispatcherService,
    // Nothing called the dispatcher on a clock, so every queued notification sat Pending with
    // zero attempts. The controller's own docblock had said so since it was written.
    OutboxDispatchRunner,
    { provide: EmailAdapter, useFactory: () => chooseEmailAdapter() },
    // Subscribes to the Prompt 8 suspicious-activity seam, which was built for exactly this.
    SecurityNotificationBridge,
  ],
  exports: [NotificationService, NotificationDispatcherService, EmailAdapter],
})
export class NotificationsModule {}
