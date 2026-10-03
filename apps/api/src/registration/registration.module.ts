import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ProvisioningModule } from '../provisioning/provisioning.module.js';
import { RegistrationController } from './registration.controller.js';
import { SelfServeRegistrationService } from './self-serve-registration.service.js';

/**
 * A company signing itself up.
 *
 * ## Why this is its own module rather than part of `auth` or `provisioning`
 *
 * It needs both, and belongs to neither. `AuthModule` owns proving who somebody is —
 * domain verification, the mail, the tokens. `ProvisioningModule` owns creating a company from a
 * set of agreed facts. This module is the *sequence* between them: two proofs, in order, and only
 * then a company.
 *
 * Putting it inside either one would bury a public, anonymous, internet-facing endpoint among a
 * module's internal services, where the next person reading that module would not expect to find
 * one. It is the only part of the product reachable by somebody with no account at all, and that
 * is worth being able to see at a glance.
 */
@Module({
  imports: [AuthModule, ProvisioningModule],
  controllers: [RegistrationController],
  providers: [SelfServeRegistrationService],
  exports: [SelfServeRegistrationService],
})
export class RegistrationModule {}
