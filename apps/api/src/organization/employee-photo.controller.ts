import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import {
  EmployeePhotoService,
  MAX_PHOTO_BYTES,
  PHOTO_CONTENT_TYPES,
} from './employee-photo.service.js';

class UploadPhotoDto {
  @IsString() @MinLength(1) @MaxLength(400) filename!: string;
  @IsIn(PHOTO_CONTENT_TYPES) contentType!: string;
  /**
   * Base64, with a generous string ceiling.
   *
   * Roughly a third above `MAX_PHOTO_BYTES` because base64 inflates by that much, plus headroom.
   * The real limit is enforced on the **decoded** length in the service — a check on the encoded
   * string would refuse a file that is actually within the limit.
   */
  @IsString() @MinLength(1) @MaxLength(Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 1024)
  contentBase64!: string;
}

/**
 * The optional employee photo — Prompt 40A (CR-03) §3.
 *
 * ## No `@RequirePermission`, and the reason is specific
 *
 * The service authorizes each call on the photo's own rule: **your own photo is yours**, and
 * somebody else's needs `users:EditDraft`. A route-level `@RequirePermission({users, EditDraft})`
 * would have refused an employee their own picture, which is the opposite of what CR-03 asks for —
 * and a route-level grant loose enough to admit them would have let them edit colleagues.
 *
 * Reading is open to any member of the company, deliberately: a photo appears in the Hierarchy,
 * in person selectors and beside a task assignee, all places where everybody can already see the
 * name. Gating the face behind a grant that does not gate the name would be a distinction without
 * a difference, and would leave selectors rendering blanks for most people.
 */
@Controller('tenants/:tenantId/photos')
@TenantScoped()
export class EmployeePhotoController {
  constructor(
    private readonly photos: EmployeePhotoService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The limits and the formats, so a picker can enforce them before a 2 MB round trip. */
  @Get('meta')
  async meta(): Promise<unknown> {
    return {
      contentTypes: PHOTO_CONTENT_TYPES,
      maxBytes: MAX_PHOTO_BYTES,
      optional: true,
      note:
        'A photo is optional and is not one of the six required Add Employee fields. It is not ' +
        'identity evidence and has nothing to do with Aadhaar.',
    };
  }

  /**
   * The image, as image bytes.
   *
   * An `<img src>` target, so the browser renders a face rather than a JSON envelope. Cached
   * privately for a few minutes: a photo changes rarely, and re-fetching every avatar on every
   * navigation is what makes a Hierarchy screen feel slow. `private` because it is a colleague's
   * face and must not sit in a shared proxy.
   */
  @Get(':userId/content')
  async content(
    @Param('userId') userId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Buffer> {
    const found = await this.photos.content({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
    });

    response.setHeader('Content-Type', found.contentType);
    response.setHeader('Cache-Control', 'private, max-age=300');
    return found.bytes;
  }

  @Get(':userId')
  async view(@Param('userId') userId: string): Promise<unknown> {
    return this.photos.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
    });
  }

  /** Several at once, for the Hierarchy and for selectors. */
  @Get()
  async viewMany(@Query('userIds') userIds = ''): Promise<unknown> {
    const ids = userIds
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    return {
      photos: await this.photos.viewMany({
        scope: this.tenantContext.requireScope(),
        actorUserId: this.currentUserId(),
        subjectUserIds: ids,
      }),
    };
  }

  @Post(':userId')
  async upload(
    @Param('userId') userId: string,
    @Body() body: UploadPhotoDto,
  ): Promise<unknown> {
    return this.photos.upload({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
      filename: body.filename,
      contentType: body.contentType,
      contentBase64: body.contentBase64,
    });
  }

  @Delete(':userId')
  async remove(@Param('userId') userId: string): Promise<unknown> {
    return this.photos.remove({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
    });
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('This requires a signed-in member of the company.');
    }
    return id;
  }
}
