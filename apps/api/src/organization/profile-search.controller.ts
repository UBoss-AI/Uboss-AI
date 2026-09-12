import { Controller, Get, Query, UnauthorizedException } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';

import {
  PERFORMANCE_SHARING_DESCRIPTIONS,
  PERFORMANCE_SHARING_LABELS,
  PERFORMANCE_SHARING_MODES,
  PORTABLE_PROFILE_STANCE,
  PROFILE_SEARCH_INPUT_STANCE,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { ProfileSearchService } from './profile-search.service.js';

class SearchQueryDto {
  /**
   * The UBoss Unique ID. `UB-XXXX-XXXX`.
   *
   * Length-bounded here and format-checked in the service, which is where the refusal message
   * belongs — a client that sends an email should be told that a portable profile is found by
   * UBoss Unique ID and by nothing else, not given a regex.
   */
  @IsString() @MinLength(4) @MaxLength(32) ubossUniqueId!: string;
}

/**
 * Portable UBoss Profile Search — Prompt 37A.
 *
 * ## Why the route is tenant-scoped even though the answer is not
 *
 * The lookup crosses companies; the **authority to perform it** does not. `@TenantScoped` puts the
 * caller in their own company's context, which is where their permission and their company's
 * policy are evaluated and where the audit row is written. A platform-plane route would have had
 * no company to check the policy against and no trail to write into.
 *
 * ## Two grants, and `profile-search:View` is not the interesting one
 *
 * Every role template holds `profile-search:View` — it governs whether the nav item appears. The
 * control is `users:Administer`, applied in the service: the approved documents say *"Authorized
 * HR/Admin"*, and an Employee being able to read another company's employment records is exactly
 * what that phrase excludes.
 *
 * The decorator here asks for the module grant so an unauthorized request is refused at the guard
 * without touching the database; the service then applies the real one.
 */
@Controller('tenants/:tenantId/profile-search')
@TenantScoped()
export class ProfileSearchController {
  constructor(
    private readonly profileSearch: ProfileSearchService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** What the screen states about this feature, in the product's own words. */
  @Get('meta')
  @RequirePermission({ module: 'profile-search', action: 'View' })
  async meta(): Promise<unknown> {
    const scope = this.tenantContext.requireScope();

    return {
      inputStance: PROFILE_SEARCH_INPUT_STANCE,
      profileStance: PORTABLE_PROFILE_STANCE,
      sharingModes: PERFORMANCE_SHARING_MODES.map((mode) => ({
        key: mode,
        label: PERFORMANCE_SHARING_LABELS[mode],
        description: PERFORMANCE_SHARING_DESCRIPTIONS[mode],
      })),
      // So the screen can say "this is switched off" rather than offering a box that always
      // returns a 403.
      enabled: await this.profileSearch.searchEnabledFor(scope),
    };
  }

  /**
   * Look somebody up.
   *
   * A `GET` with a query parameter, which puts the searched id in the access log — and that is
   * fine and arguably right: the id is not a secret, and every lookup is audited with it anyway.
   */
  @Get()
  @RequirePermission({ module: 'profile-search', action: 'View' })
  async search(@Query() query: SearchQueryDto): Promise<unknown> {
    return this.profileSearch.search({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ubossUniqueId: query.ubossUniqueId,
    });
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Profile search is for signed-in company members.');
    }
    return id;
  }
}
