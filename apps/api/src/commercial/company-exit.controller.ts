import { Body, Controller, Get, Param, Post, UnauthorizedException } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  DEFAULT_READ_ONLY_DAYS,
  DEFAULT_RETENTION_DAYS,
  DESTRUCTIVE_CONFIRMATION_STANCE,
  DISPOSITION_DESCRIPTIONS,
  DISPOSITION_LABELS,
  DISPOSITIONS,
  EXIT_STATE_DESCRIPTIONS,
  EXIT_STATE_LABELS,
  EXIT_STATES,
  EXPORT_EXCLUSIONS,
  EXPORT_SECTION_LABELS,
  EXPORT_SECTIONS,
  EXPORT_STANCE,
  MAX_EXIT_WINDOW_DAYS,
  tablesWithDisposition,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { CompanyExitService } from './company-exit.service.js';

class RequestExitDto {
  @IsString() @MinLength(10) @MaxLength(2000) reason!: string;
  /** True when the company asked to leave rather than UBoss ending the contract. */
  @IsOptional() @IsBoolean() requestedByCustomer?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_EXIT_WINDOW_DAYS) readOnlyDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_EXIT_WINDOW_DAYS) retentionDays?: number;
}

class ApproveExitDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

class CancelExitDto {
  @IsString() @MinLength(4) @MaxLength(1000) reason!: string;
  @IsOptional() @IsIn(['Active', 'ReadOnly']) restoreTo?: 'Active' | 'ReadOnly';
}

class DeleteContentDto {
  /**
   * The company's own identifier, typed out.
   *
   * Deliberately not the word DELETE. Typing DELETE is muscle memory — somebody who has done it
   * once will do it again on the wrong company — and typing the name of the company you are about
   * to erase is a moment of attention.
   */
  @IsString() @MinLength(1) @MaxLength(120) confirm!: string;
}

/**
 * Company exit and data portability — Prompt 38.
 *
 * ## Every route is platform-only, including the customer's own request
 *
 * A company cannot end its own contract through the product. That is not an oversight: contract end
 * is a commercial act with notice periods and obligations on both sides, and a self-service button
 * would let one administrator terminate a company's UBoss estate on an afternoon. `requestedByCustomer`
 * records that the customer asked, and a UBoss operator raises the request on their behalf — which
 * is the same shape as company provisioning, where there is no public signup either.
 *
 * ## The grants escalate with the consequences
 *
 * * **Request** — `companies:EditDraft`. A request changes nothing.
 * * **Approve, begin read-only, begin retention, cancel** — `companies:Administer`.
 * * **Delete content** — `companies:Administer` **plus** a second person's approval on the record,
 *   the elapsed retention window, and the typed confirmation. Four things, none of them a click.
 */
@Controller('platform/company-exits')
@PlatformOnly()
export class CompanyExitController {
  constructor(private readonly exits: CompanyExitService) {}

  /** The vocabulary, the windows, and what exit does to each kind of record. */
  @Get('meta')
  @RequirePermission({ module: 'companies', action: 'View' })
  async meta(): Promise<unknown> {
    return {
      states: EXIT_STATES.map((state) => ({
        key: state,
        label: EXIT_STATE_LABELS[state],
        description: EXIT_STATE_DESCRIPTIONS[state],
      })),
      defaultWindows: {
        readOnlyDays: DEFAULT_READ_ONLY_DAYS,
        retentionDays: DEFAULT_RETENTION_DAYS,
        maxDays: MAX_EXIT_WINDOW_DAYS,
      },
      // What survives and what does not, with the counts. An operator about to approve an exit is
      // entitled to see this before they do, not afterwards.
      dispositions: DISPOSITIONS.map((disposition) => ({
        key: disposition,
        label: DISPOSITION_LABELS[disposition],
        description: DISPOSITION_DESCRIPTIONS[disposition],
        tableCount: tablesWithDisposition(disposition).length,
        tables: tablesWithDisposition(disposition),
      })),
      exportSections: EXPORT_SECTIONS.map((section) => ({
        key: section,
        label: EXPORT_SECTION_LABELS[section],
      })),
      exportExclusions: EXPORT_EXCLUSIONS,
      exportStance: EXPORT_STANCE,
      confirmationStance: DESTRUCTIVE_CONFIRMATION_STANCE,
    };
  }

  /** Exits whose retention window has elapsed and which are waiting for a decision. */
  @Get('awaiting-deletion')
  @RequirePermission({ module: 'companies', action: 'View' })
  async awaitingDeletion(): Promise<unknown> {
    return { exits: await this.exits.awaitingDeletion() };
  }

  @Get('companies/:tenantId')
  @RequirePermission({ module: 'companies', action: 'View' })
  async forCompany(@Param('tenantId') tenantId: string): Promise<unknown> {
    return { exit: await this.exits.viewFor(tenantId) };
  }

  @Get(':exitId')
  @RequirePermission({ module: 'companies', action: 'View' })
  async byId(@Param('exitId') exitId: string): Promise<unknown> {
    return this.exits.byId(exitId);
  }

  // ---- Step 1 ----

  @Post('companies/:tenantId')
  @RequirePermission({ module: 'companies', action: 'EditDraft' })
  async request(
    @Param('tenantId') tenantId: string,
    @Body() body: RequestExitDto,
  ): Promise<unknown> {
    return this.exits.request({
      tenantId,
      requestedByUserId: this.currentUserId(),
      reason: body.reason,
      ...(body.requestedByCustomer === undefined
        ? {}
        : { requestedByCustomer: body.requestedByCustomer }),
      ...(body.readOnlyDays === undefined ? {} : { readOnlyDays: body.readOnlyDays }),
      ...(body.retentionDays === undefined ? {} : { retentionDays: body.retentionDays }),
    });
  }

  /** Approve. Refused if you raised it — a second person, always. */
  @Post(':exitId/approve')
  @RequirePermission({ module: 'companies', action: 'Administer' })
  async approve(@Param('exitId') exitId: string, @Body() body: ApproveExitDto): Promise<unknown> {
    return this.exits.approve({
      exitId,
      approvedByUserId: this.currentUserId(),
      ...(body.note === undefined ? {} : { note: body.note }),
    });
  }

  // ---- Step 2 ----

  /**
   * The export package.
   *
   * Available throughout the read-only period and the retention window — which is what those
   * periods are for — and refused once the content is gone.
   */
  @Get(':exitId/export')
  @RequirePermission({ module: 'companies', action: 'Export' })
  async exportPackage(@Param('exitId') exitId: string): Promise<unknown> {
    return this.exits.exportPackage({ exitId, actorUserId: this.currentUserId() });
  }

  // ---- Step 3 ----

  @Post(':exitId/read-only')
  @RequirePermission({ module: 'companies', action: 'Administer' })
  async beginReadOnly(@Param('exitId') exitId: string): Promise<unknown> {
    return this.exits.beginReadOnly({ exitId, actorUserId: this.currentUserId() });
  }

  // ---- Step 4 ----

  @Post(':exitId/retention-hold')
  @RequirePermission({ module: 'companies', action: 'Administer' })
  async beginRetentionHold(@Param('exitId') exitId: string): Promise<unknown> {
    return this.exits.beginRetentionHold({ exitId, actorUserId: this.currentUserId() });
  }

  // ---- Steps 5, 6, 7 ----

  /**
   * Delete eligible content, preserve the rest, write the certificate.
   *
   * **The one irreversible action in UBoss.** `POST` with a body carrying the typed confirmation,
   * because a `DELETE` with no body would make this a URL somebody could arrive at.
   */
  @Post(':exitId/delete-content')
  @RequirePermission({ module: 'companies', action: 'Administer' })
  async deleteContent(
    @Param('exitId') exitId: string,
    @Body() body: DeleteContentDto,
  ): Promise<unknown> {
    return this.exits.deleteContent({
      exitId,
      actorUserId: this.currentUserId(),
      typedConfirmation: body.confirm,
    });
  }

  // ---- Cancellation ----

  @Post(':exitId/cancel')
  @RequirePermission({ module: 'companies', action: 'Administer' })
  async cancel(@Param('exitId') exitId: string, @Body() body: CancelExitDto): Promise<unknown> {
    return this.exits.cancel({
      exitId,
      actorUserId: this.currentUserId(),
      reason: body.reason,
      ...(body.restoreTo === undefined ? {} : { restoreTo: body.restoreTo }),
    });
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Company exit is for signed-in platform staff.');
    }
    return id;
  }
}
