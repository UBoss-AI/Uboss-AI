import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { FileService } from '../knowledge/file.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** What the image formats a photo may be. A closed list, checked on upload. */
export const PHOTO_CONTENT_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/** Two megabytes. A profile photo larger than this is a camera file nobody resized. */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export interface PhotoView {
  userId: string;
  /** Null when there is no photo — the screen then shows initials. */
  storedFileId: string | null;
  contentType: string | null;
  uploadedAt: string | null;
  /** False while a scan has not cleared it. The screen falls back to initials. */
  viewable: boolean;
  /** Always present, so a screen never has to compute a fallback from a name it may not have. */
  initials: string;
}

/**
 * The optional employee photo — Prompt 40A (CR-03) §3.
 *
 * ## The six mandatory fields are untouched
 *
 * CR-03 is explicit: add the photo *"without changing the six mandatory Add Employee fields"*. So
 * this is a separate table and a separate route, reachable after a person exists. Nothing about Add
 * Employee changes, nothing gains an asterisk, and a company that never uploads a photo sees
 * initials everywhere — which is why `initials` is always returned rather than left to the client.
 *
 * ## Stored as a file, because it is one
 *
 * *"Store through the existing secure object/file-storage abstraction, not base64 in normal DB
 * fields."* So a photo goes through `FileService` exactly like any other upload: the same size
 * validation, the same storage adapter, the same malware scan, the same audit trail. A bespoke
 * `photo_bytes` column would have bypassed all four — and an unscanned image upload is a real
 * attack surface, not a theoretical one.
 *
 * **A photo that has not been cleared by a scan is not served.** The screen shows initials, which
 * is indistinguishable from "no photo yet" and therefore tells an attacker nothing about what the
 * scanner did.
 *
 * ## Nothing to do with Aadhaar
 *
 * Stated because the two are adjacent on the same form and must never be conflated: a photo is a
 * convenience for recognising a colleague in the hierarchy. It is not identity evidence, it
 * verifies nothing, and it is not part of the portable profile that crosses a company boundary.
 */
@Injectable()
export class EmployeePhotoService {
  private readonly logger = new Logger(EmployeePhotoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly files: FileService,
    private readonly audit: AuditEventService,
  ) {}

  /**
   * Upload or replace a photo.
   *
   * ## Who may
   *
   * Yourself, always — your own photo is yours. Somebody else needs `users:EditDraft`, the grant
   * that already governs editing an employment record. Without the self case an employee could not
   * set their own picture without an administrator, which would make the feature useless; without
   * the permission case anybody could change a colleague's photo, which is a small but real form
   * of impersonation in a directory.
   */
  async upload(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    filename: string;
    contentType: string;
    /** Base64, as the Prompt 35 upload path already accepts. */
    contentBase64: string;
  }): Promise<PhotoView> {
    await this.assertMayEdit(input.scope, input.actorUserId, input.subjectUserId);

    if (!PHOTO_CONTENT_TYPES.includes(input.contentType)) {
      throw new BadRequestException(`A photo must be one of: ${PHOTO_CONTENT_TYPES.join(', ')}.`);
    }

    // Checked on the decoded length, not on the base64 string, which is a third larger. Checking
    // the encoded length would refuse a file that is actually within the limit.
    const decodedBytes = Math.floor((input.contentBase64.length * 3) / 4);
    if (decodedBytes > MAX_PHOTO_BYTES) {
      throw new BadRequestException(
        `A photo must be ${Math.round(MAX_PHOTO_BYTES / 1024)} KB or smaller. Resize it and try again.`,
      );
    }

    await this.requireMember(input.scope, input.subjectUserId);

    // `uploadAuthorizedElsewhere`, because the authorization above is the photo rule — yourself,
    // or a colleague with `users:EditDraft` — and not the Knowledge & Data grant a standard
    // Employee does not hold. See the seam's own note for why that is a seam and not a looser gate.
    const uploaded = await this.files.uploadAuthorizedElsewhere({
      scope: input.scope,
      actorUserId: input.actorUserId,
      filename: input.filename,
      contentType: input.contentType,
      bytes: Buffer.from(input.contentBase64, 'base64'),
      // `Internal`: a photo of a colleague is not public and is not confidential business data.
      classification: 'Internal',
    });

    const previous = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.employeePhoto.findFirst({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
        select: { id: true, storedFileId: true },
      });

      if (existing === null) {
        await this.prisma.client.employeePhoto.create({
          data: {
            tenantId: input.scope.tenantId,
            userId: input.subjectUserId,
            storedFileId: uploaded.id,
            uploadedByUserId: input.actorUserId,
          },
        });
      } else {
        await this.prisma.client.employeePhoto.update({
          where: { id: existing.id },
          data: {
            storedFileId: uploaded.id,
            uploadedByUserId: input.actorUserId,
            uploadedAt: new Date(),
          },
        });
      }

      await this.audit.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'organization.employee_photo_set',
        actorUserId: input.actorUserId,
        resourceType: 'employee-photo',
        resourceId: input.subjectUserId,
        summary:
          input.actorUserId === input.subjectUserId
            ? 'Set their own profile photo.'
            : 'Set a colleague’s profile photo.',
        metadata: { subjectUserId: input.subjectUserId, replaced: existing !== null },
      });

      return existing?.storedFileId ?? null;
    });

    /**
     * The replaced file is deleted, not orphaned.
     *
     * A photo changed five times would otherwise leave four files in storage that nothing points
     * at, still holding a picture of somebody who thought they had replaced it. Deleted after the
     * pointer moved, so a failure here leaves a harmless orphan rather than a dangling pointer.
     */
    if (previous !== null) {
      await this.files
        .deleteAuthorizedElsewhere({
          scope: input.scope,
          actorUserId: input.actorUserId,
          fileId: previous,
          reason: 'Replaced by a newer profile photo.',
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Replaced photo ${previous} could not be deleted: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        });
    }

    return this.view({
      scope: input.scope,
      actorUserId: input.actorUserId,
      subjectUserId: input.subjectUserId,
    });
  }

  /**
   * Remove a photo.
   *
   * Deletes the pointer **and** the file. "Remove my photo" has to mean the picture is gone, not
   * that a screen stopped showing it — anything less would be a promise the product did not keep.
   */
  async remove(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
  }): Promise<{ removed: boolean }> {
    await this.assertMayEdit(input.scope, input.actorUserId, input.subjectUserId);

    const storedFileId = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.employeePhoto.findFirst({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
        select: { id: true, storedFileId: true },
      });
      if (existing === null) return null;

      await this.prisma.client.employeePhoto.delete({ where: { id: existing.id } });

      await this.audit.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'organization.employee_photo_removed',
        actorUserId: input.actorUserId,
        resourceType: 'employee-photo',
        resourceId: input.subjectUserId,
        summary: 'Removed a profile photo.',
        metadata: { subjectUserId: input.subjectUserId },
      });

      return existing.storedFileId;
    });

    if (storedFileId === null) return { removed: false };

    await this.files.deleteAuthorizedElsewhere({
      scope: input.scope,
      actorUserId: input.actorUserId,
      fileId: storedFileId,
      reason: 'The profile photo was removed.',
    });

    return { removed: true };
  }

  /**
   * One person's photo, or the initials to show instead.
   *
   * `users:View`-free on purpose: a photo is shown in the Hierarchy, in a person selector and
   * beside a task assignee, and every member of a company can already see their colleagues' names
   * in those places. Gating a face behind a grant that does not gate the name would be a
   * distinction without a difference — and would leave selectors rendering blanks for most people.
   */
  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
  }): Promise<PhotoView> {
    const member = await this.requireMember(input.scope, input.subjectUserId);

    const photo = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.employeePhoto.findFirst({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
        select: {
          storedFileId: true,
          uploadedAt: true,
          file: { select: { contentType: true, scanState: true, deletedAt: true } },
        },
      }),
    );

    const initials = initialsOf(member.displayName);

    if (photo === null || photo.file.deletedAt !== null) {
      return {
        userId: input.subjectUserId,
        storedFileId: null,
        contentType: null,
        uploadedAt: null,
        viewable: false,
        initials,
      };
    }

    return {
      userId: input.subjectUserId,
      storedFileId: photo.storedFileId,
      contentType: photo.file.contentType,
      uploadedAt: photo.uploadedAt.toISOString(),
      // Not viewable until a scan clears it. Indistinguishable from "no photo", which is what
      // stops the state of the scanner leaking to whoever uploaded the file.
      viewable: photo.file.scanState === 'Clean',
      initials,
    };
  }

  /** Photos for a list of people, for the Hierarchy and for selectors. */
  async viewMany(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserIds: readonly string[];
  }): Promise<PhotoView[]> {
    const views: PhotoView[] = [];
    for (const subjectUserId of input.subjectUserIds.slice(0, 500)) {
      views.push(
        await this.view({
          scope: input.scope,
          actorUserId: input.actorUserId,
          subjectUserId,
        }),
      );
    }
    return views;
  }

  /**
   * The image itself.
   *
   * ## Why this does not go through the generic file download
   *
   * `FileService.download` requires `settings:Export` and returns base64 JSON. Neither suits a
   * photo: a standard Employee holds `settings:View` and nothing more, so every avatar in the
   * Hierarchy would render as a broken image for most of the company — and an `<img>` cannot
   * consume a JSON envelope anyway.
   *
   * So the photo carries its own read rule, which is the same one as its metadata: **any member of
   * the company**. A face is shown beside a name in the Hierarchy, in a person selector and next to
   * a task assignee, all places where the name is already visible. Gating the face behind a grant
   * that does not gate the name would be a distinction without a difference.
   *
   * **A file the scan has not cleared is not served**, and the refusal is a plain `NotFound` — the
   * same answer as "there is no photo". Anything more specific would tell an uploader what the
   * scanner is doing.
   */
  async content(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
  }): Promise<{ bytes: Buffer; contentType: string }> {
    await this.requireMember(input.scope, input.subjectUserId);

    const photo = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.employeePhoto.findFirst({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
        select: {
          storedFileId: true,
          file: { select: { contentType: true, scanState: true, deletedAt: true } },
        },
      }),
    );

    if (photo === null || photo.file.deletedAt !== null || photo.file.scanState !== 'Clean') {
      throw new NotFoundException('There is no photo to show.');
    }

    const bytes = await this.files.readAuthorizedElsewhere({
      scope: input.scope,
      fileId: photo.storedFileId,
    });

    return { bytes, contentType: photo.file.contentType };
  }

  private async assertMayEdit(
    scope: TenantScope,
    actorUserId: string,
    subjectUserId: string,
  ): Promise<void> {
    if (actorUserId === subjectUserId) return;
    const context = await this.authorization.contextFor(scope, actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'EditDraft' });
  }

  private async requireMember(
    scope: TenantScope,
    userId: string,
  ): Promise<{ displayName: string }> {
    const member = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.tenantMembership.findFirst({
        where: { tenantId: scope.tenantId, userId },
        select: { user: { select: { displayName: true } } },
      }),
    );
    if (member === null) throw new NotFoundException('There is no such person in this company.');
    return { displayName: member.user.displayName };
  }
}

/**
 * Initials from a display name.
 *
 * First and last word, so "Pranav Sudhakar Kulkarni" is `PK` rather than `PSK` — which is what a
 * two-letter avatar has room for. A single-word name gives one letter; an empty one gives `?`
 * rather than an empty circle, because an empty circle reads as a loading state that never
 * finishes.
 */
export function initialsOf(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] as string).charAt(0).toUpperCase();
  const first = (words[0] as string).charAt(0);
  const last = (words[words.length - 1] as string).charAt(0);
  return `${first}${last}`.toUpperCase();
}
