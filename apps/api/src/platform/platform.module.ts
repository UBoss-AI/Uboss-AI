import { Module } from '@nestjs/common';

import { PlatformAdministrationService } from './platform-administration.service.js';
import { PlatformConsoleController } from './platform-console.controller.js';
import { PlatformConsoleService } from './platform-console.service.js';

/**
 * The UBoss Master Console.
 *
 * Not `@Global`, unlike the authorization and audit modules: nothing outside the Master Console
 * needs to read a plan or a feature flag yet. When a company-plane feature needs to ask "is this
 * flag on for this company", the answer is a narrow, exported flag-evaluation service — not this
 * module going global and every feature gaining the ability to change a plan.
 */
@Module({
  controllers: [PlatformConsoleController],
  providers: [PlatformConsoleService, PlatformAdministrationService],
  exports: [PlatformConsoleService, PlatformAdministrationService],
})
export class PlatformModule {}
