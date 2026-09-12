import { Global, Module } from '@nestjs/common';

import { AuditEventRepository } from './audit-event.repository.js';
import { AuditTrailRepository } from './audit-trail.repository.js';
import { AuthorizationRepository } from './authorization.repository.js';
import { EnterpriseIdentityRepository } from './enterprise-identity.repository.js';
import { InvitationRepository } from './invitation.repository.js';
import { MfaRepository } from './mfa.repository.js';
import { ProvisioningRepository } from './provisioning.repository.js';
import { PasswordResetRepository } from './password-reset.repository.js';
import { NotificationRepository } from './notification.repository.js';
import { OutboxRepository } from './outbox.repository.js';
import { PlatformRepository } from './platform.repository.js';
import { SessionRepository } from './session.repository.js';
import { UserCredentialRepository } from './user-credential.repository.js';
import { PrismaService } from './prisma.service.js';
import { TenantMembershipRepository } from './tenant-membership.repository.js';
import { TenantRepository } from './tenant.repository.js';
import { UserRepository } from './user.repository.js';

/**
 * Persistence layer.
 *
 * Global because `PrismaService` carries the ambient-transaction store: a second instance would
 * mean a repository could silently write outside the transaction a service had opened.
 *
 * Feature modules inject repositories; nothing outside this module constructs a PrismaClient.
 */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useFactory: () => new PrismaService() },
    TenantRepository,
    UserRepository,
    TenantMembershipRepository,
    AuditEventRepository,
    AuditTrailRepository,
    PlatformRepository,
    NotificationRepository,
    OutboxRepository,
    UserCredentialRepository,
    InvitationRepository,
    PasswordResetRepository,
    SessionRepository,
    MfaRepository,
    EnterpriseIdentityRepository,
    ProvisioningRepository,
    AuthorizationRepository,
  ],
  exports: [
    PrismaService,
    TenantRepository,
    UserRepository,
    TenantMembershipRepository,
    AuditEventRepository,
    AuditTrailRepository,
    PlatformRepository,
    NotificationRepository,
    OutboxRepository,
    UserCredentialRepository,
    InvitationRepository,
    PasswordResetRepository,
    SessionRepository,
    MfaRepository,
    EnterpriseIdentityRepository,
    ProvisioningRepository,
    AuthorizationRepository,
  ],
})
export class PersistenceModule {}
