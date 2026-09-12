import { Body, Controller, Get, Param, Put, Query, UnauthorizedException } from '@nestjs/common';
import {
  Allow,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { SETTINGS_CATEGORIES } from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { CompanySettingsService } from './company-settings.service.js';

export class UpdateSettingsDto {
  /**
   * Key/value pairs, keyed by catalogue key.
   *
   * `@Allow()` because the *values* are deliberately untyped here — a setting can be a boolean,
   * an integer, a string or an enum member, and the catalogue's `validateSetting` is what checks
   * each one against its declared type. Without `@Allow()`, `whitelist: true` **strips** a
   * property with no validation decorator and `forbidNonWhitelisted` then rejects the request —
   * the Prompt 9 lesson, which cost every settings write a 400 there.
   */
  @IsObject()
  @Allow()
  values!: Record<string, unknown>;

  /** Required when any changed setting is material. Refused server-side, not just here. */
  @IsOptional()
  @IsString()
  @MinLength(5, { message: 'reason must explain the change.' })
  @MaxLength(1000)
  reason?: string;
}

export class SettingKeyDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)
  @MaxLength(120)
  key!: string;
}

/**
 * Company Settings — the shell's data, and the writes behind it.
 *
 * ## The route permission is the floor, not the check
 *
 * `settings:View` gets a caller to the screen. **Every individual setting's own permission is
 * checked by the service**, per the client's rule that the backend enforces every setting
 * permission — so a caller sees exactly the settings they may read and `editable` per setting is
 * the server's answer. A screen may disable a control on it; the write path checks again anyway.
 *
 * **Authorization is never through hidden navigation.** A category withheld from the response is
 * also refused on write, and the response says *how many* were withheld so the screen shows a
 * shorter list rather than an empty one that reads as a bug.
 */
@Controller('tenants/:tenantId/settings')
@TenantScoped()
export class SettingsController {
  constructor(
    private readonly settings: CompanySettingsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The whole shell: the categories this caller may see, with each setting's source. */
  @Get()
  @RequirePermission({ module: 'settings', action: 'View' })
  async view(): Promise<unknown> {
    return this.settings.viewFor(this.tenantContext.requireScope(), this.currentUserId());
  }

  /** The full category list, so a screen can render the information architecture. */
  @Get('categories')
  @RequirePermission({ module: 'settings', action: 'View' })
  categories(): unknown {
    return {
      categories: SETTINGS_CATEGORIES,
      note:
        'The complete information architecture. Which of these a given person reaches is ' +
        'decided by the server per category, and every setting inside one carries its own ' +
        'permission — a category missing from your own view was withheld, not removed.',
    };
  }

  /**
   * Change one or more settings.
   *
   * Several at once because a settings panel has one Save button and cross-setting rules exist.
   * A payload mixing a setting the caller may change with one they may not is refused **whole**,
   * naming the key — a partial save is a change nobody asked for.
   */
  @Put()
  @RequirePermission({ module: 'settings', action: 'View' })
  async update(@Body() body: UpdateSettingsDto): Promise<unknown> {
    const changed = await this.settings.update({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      values: body.values,
      reason: body.reason,
    });
    return { changed };
  }

  /** The version history for a material setting. `settings:Audit`. */
  @Get('history')
  @RequirePermission({ module: 'settings', action: 'Audit' })
  async history(@Query() query: SettingKeyDto): Promise<unknown> {
    const changes = await this.settings.historyFor({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      key: query.key,
    });
    return { key: query.key, changes };
  }

  /** One effective value, for a screen that needs a single policy rather than the whole shell. */
  @Get('value/:key')
  @RequirePermission({ module: 'settings', action: 'View' })
  async value(@Param('key') key: string): Promise<unknown> {
    return {
      key,
      value: await this.settings.effectiveValue(this.tenantContext.requireScope(), key),
    };
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
