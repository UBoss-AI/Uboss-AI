import { Global, Module } from '@nestjs/common';

import { SkillRouterController } from './skill-router.controller.js';
import { SkillRouterService } from './skill-router.service.js';
import { PlatformSkillController, SkillController } from './skill.controller.js';
import { SkillService } from './skill.service.js';

/**
 * Skills: the platform catalogue and each company's own.
 *
 * `@Global` because Prompt 18's Skill Router, and every later prompt that runs AI work, must ask
 * **one** question — "which approved published versions apply here" — and must never be able to
 * reach an unapproved one. A module that had to be imported to ask that would eventually be
 * skipped, and the skipping caller would be the bug.
 *
 * There is deliberately no template provider, no instantiation service and no library: the locked
 * rule is that Skills are governed capabilities, not Templates, and nothing here offers a
 * copy-me-and-forget path.
 */
@Global()
@Module({
  controllers: [SkillController, PlatformSkillController, SkillRouterController],
  providers: [SkillService, SkillRouterService],
  exports: [SkillService, SkillRouterService],
})
export class SkillsModule {}
