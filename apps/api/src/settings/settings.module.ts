import { Global, Module } from '@nestjs/common';

import { CompanySettingsService } from './company-settings.service.js';
import { SettingsController } from './settings.controller.js';

/**
 * Company Settings: the typed store, its inheritance and the shell's data.
 *
 * `@Global` because later prompts read a policy rather than a screen — an escalation window, a
 * default hierarchy view — and `effectiveValue` is the accessor they call. Importing a module
 * everywhere to read one integer would be noise.
 */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [CompanySettingsService],
  exports: [CompanySettingsService],
})
export class SettingsModule {}
