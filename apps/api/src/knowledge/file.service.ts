import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  decideDeletion,
  decideEgress,
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_EXPORT_CEILING,
  DEFAULT_EXTERNAL_EGRESS_CEILING,
  DEFAULT_FILE_CLASSIFICATION,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_RETENTION_ACTION,
  fileIsUsable,
  mayMoveScan,
  retentionExpiry,
  retentionProblems,
  uploadProblems,
  type DataClassification,
  type FileScanState,
  type RetentionAction,
  type RetentionPolicy,
  type UploadPolicy,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { MALWARE_SCANNER, type MalwareScanner } from './malware-scanner.js';
import { STORAGE_ADAPTER, type StorageAdapter } from './storage-adapter.js';

/** A file as a screen shows it. Never the bytes. */
export interface StoredFileView {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  classification: DataClassification;
  scanState: FileScanState;
  scanResult: string | null;
  /** False for the mock scanner. Never omitted, so no report implies a real scan. */
  scannedByRealScanner: boolean | null;
  /** Whether anything may read it. The whole of §22's "before use" rule. */
  usable: boolean;
  retentionAction: RetentionAction;
  retentionExpiresAt: string | null;
  onLegalHold: boolean;
  legalHoldReason: string | null;
  uploadedByUserId: string;
  uploadedAt: string;
  deletedAt: string | null;
  deletedReason: string | null;
  /** Whether the content is still stored. False once deleted. */
  hasContent: boolean;
}

export interface KnowledgePolicyView {
  maxUploadBytes: number;
  allowedContentTypes: string[];
  defaultRetentionDays: number | null;
  defaultRetentionAction: RetentionAction;
  exportCeiling: DataClassification;
  externalEgressCeiling: DataClassification;
}

/**
 * Files — Prompt 35.
 *
 * ## Three things this service will not do
 *
 * **It will not hand out a file that has not been scanned clean.** `fileIsUsable` gates every read
 * and every download, and the check is at the top of each one rather than in a shared guard,
 * because a shared guard is a thing somebody later calls a method around.
 *
 * **It will not store bytes in the database.** The adapter holds them; the row holds a reference,
 * a hash and metadata. A deletion nulls the reference *and* asks the adapter to remove the object,
 * in that order, so a failure leaves an orphan in storage rather than a row pointing at content
 * the company was told had gone.
 *
 * **It will not claim a scan happened.** Every verdict records which scanner produced it, and the
 * mock records `false`. A compliance answer built on this data can tell the difference.
 */
@Injectable()
export class FileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  // -------------------------------------------------------------------------
  // The policy
  // -------------------------------------------------------------------------

  /** The company's file policy, created from the documented defaults on first read. */
  async policy(scope: TenantScope): Promise<KnowledgePolicyView> {
    const row = await this.prisma.runInTenantTransaction(scope, async () => {
      const existing = await this.prisma.client.companyKnowledgePolicy.findUnique({
        where: { tenantId: scope.tenantId },
      });
      if (existing !== null) return existing;

      // Written from the types package rather than left to the column defaults, for the reason
      // Prompt 31 learned: a governance default declared in two places can drift with nothing to
      // notice.
      return this.prisma.client.companyKnowledgePolicy.create({
        data: {
          tenantId: scope.tenantId,
          maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
          allowedContentTypes: [...DEFAULT_ALLOWED_CONTENT_TYPES],
          defaultRetentionAction: DEFAULT_RETENTION_ACTION,
          exportCeiling: DEFAULT_EXPORT_CEILING,
          externalEgressCeiling: DEFAULT_EXTERNAL_EGRESS_CEILING,
        },
      });
    });

    return {
      maxUploadBytes: row.maxUploadBytes,
      allowedContentTypes: row.allowedContentTypes,
      defaultRetentionDays: row.defaultRetentionDays,
      defaultRetentionAction: row.defaultRetentionAction as RetentionAction,
      exportCeiling: row.exportCeiling as DataClassification,
      externalEgressCeiling: row.externalEgressCeiling as DataClassification,
    };
  }

  /** Change it. `settings:Administer` — upload limits and egress ceilings are company policy. */
  async setPolicy(input: {
    scope: TenantScope;
    actorUserId: string;
    policy: KnowledgePolicyView;
    reason: string;
  }): Promise<KnowledgePolicyView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (input.reason.trim() === '') {
      throw new BadRequestException(
        'Say why the file policy is changing. It governs what the company accepts and what may ' +
          'leave, and an unexplained change cannot be reviewed.',
      );
    }

    const problems = retentionProblems({
      retentionDays: input.policy.defaultRetentionDays,
      action: input.policy.defaultRetentionAction,
    });
    if (problems.length > 0) throw new BadRequestException(problems);

    const before = await this.policy(input.scope);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.companyKnowledgePolicy.update({
        where: { tenantId: input.scope.tenantId },
        data: {
          maxUploadBytes: input.policy.maxUploadBytes,
          allowedContentTypes: input.policy.allowedContentTypes,
          defaultRetentionDays: input.policy.defaultRetentionDays,
          defaultRetentionAction: input.policy.defaultRetentionAction,
          exportCeiling: input.policy.exportCeiling,
          externalEgressCeiling: input.policy.externalEgressCeiling,
          updatedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'knowledge.policy_changed',
        resourceType: 'knowledge-policy',
        resourceId: input.scope.tenantId,
        actorUserId: input.actorUserId,
        summary: `File and knowledge policy changed. ${input.reason}`,
        resourceVersion: row.version,
        metadata: {
          reason: input.reason,
          // Both sides, because "what changed" is what an access review asks and reconstructing
          // it from two events is work nobody does.
          beforeEgressCeiling: before.externalEgressCeiling,
          afterEgressCeiling: input.policy.externalEgressCeiling,
          beforeExportCeiling: before.exportCeiling,
          afterExportCeiling: input.policy.exportCeiling,
          beforeMaxUploadBytes: before.maxUploadBytes,
          afterMaxUploadBytes: input.policy.maxUploadBytes,
        },
      });

      return {
        maxUploadBytes: row.maxUploadBytes,
        allowedContentTypes: row.allowedContentTypes,
        defaultRetentionDays: row.defaultRetentionDays,
        defaultRetentionAction: row.defaultRetentionAction as RetentionAction,
        exportCeiling: row.exportCeiling as DataClassification,
        externalEgressCeiling: row.externalEgressCeiling as DataClassification,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Uploading
  // -------------------------------------------------------------------------

  /**
   * Accept a file, store it, and scan it.
   *
   * `settings:EditDraft` — uploading company knowledge is an ordinary act for somebody who
   * administers settings, and not one an Employee performs unasked. The validation runs **before**
   * the bytes reach the adapter, so a refused upload never becomes a stored object nobody has a
   * row for.
   *
   * The scan runs in the same call rather than being queued. That is a deliberate limitation and
   * it is recorded: there is no scanning queue, so a large file blocks its request. Wiring it to
   * the Prompt 26 scheduler is the right answer and would have been a second queue built here.
   */
  async upload(input: {
    scope: TenantScope;
    actorUserId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
    classification?: DataClassification;
  }): Promise<StoredFileView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'EditDraft' });
    return this.uploadAuthorizedElsewhere(input);
  }

  /**
   * The bytes, with the permission check already made by somebody else.
   *
   * The read counterpart to `uploadAuthorizedElsewhere`. Needed for the same reason: a photo is
   * read by every member of a company, and `download` requires `settings:Export`.
   *
   * Deliberately **narrower** than `download`: no security event, no export-ceiling check, and no
   * view returned. Those belong to a person exporting a document from Knowledge & Data, which is a
   * different act from a browser fetching an avatar — recording an audit row per rendered face
   * would bury the trail under the Hierarchy screen.
   *
   * The caller must have authorized the read. `EmployeePhotoService.content` is the only caller,
   * and it checks membership and the scan state first.
   */
  async readAuthorizedElsewhere(input: { scope: TenantScope; fileId: string }): Promise<Buffer> {
    const file = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.storedFile.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.fileId, deletedAt: null },
        select: { storageRef: true },
      }),
    );

    if (file === null || file.storageRef === null) {
      throw new NotFoundException('That file does not exist in this company.');
    }

    return this.storage.get(file.storageRef);
  }

  /**
   * The upload, with the Knowledge & Data permission check already made by somebody else.
   *
   * ## Why this seam exists rather than a looser gate on `upload`
   *
   * Prompt 40A added two file kinds whose authorization is genuinely not
   * `settings:EditDraft`: an **employee photo** (yours, or a colleague's with
   * `users:EditDraft`) and a **chat attachment** (anybody in the conversation). A standard
   * Employee holds `settings:View` and nothing more, so routing those through `upload` would
   * have meant either refusing an employee their own photo or widening the Knowledge & Data
   * grant for everybody — and the second would have handed every employee the company file
   * store to prove a point about avatars.
   *
   * So the *work* is shared and the *gate* is the caller's. Everything that makes the file layer
   * worth reusing still applies: the size and type validation, the storage abstraction, the
   * content hash, the malware scan, the classification and the audit row.
   *
   * **A caller must have performed its own authorization before calling this.** The two in the
   * codebase are `EmployeePhotoService` and the chat attachment path, and both check first. Any
   * new caller is taking on that obligation — which is why the name says so out loud rather than
   * being a tidy `performUpload`.
   */
  async uploadAuthorizedElsewhere(input: {
    scope: TenantScope;
    actorUserId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
    classification?: DataClassification;
  }): Promise<StoredFileView> {
    const policy = await this.policy(input.scope);
    const uploadPolicy: UploadPolicy = {
      maxBytes: policy.maxUploadBytes,
      allowedContentTypes: policy.allowedContentTypes,
    };

    const problems = uploadProblems(
      {
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.bytes.byteLength,
      },
      uploadPolicy,
    );

    if (problems.length > 0) {
      // A refused upload is a security event, not just a validation failure: somebody attempting
      // to upload an executable is worth seeing in the Security Center whether or not they meant
      // anything by it.
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.fileUploadRefused,
        actorUserId: input.actorUserId,
        tenantId: input.scope.tenantId,
        resourceType: 'file',
        summary: `Upload refused: ${input.filename}`,
        metadata: {
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.bytes.byteLength,
          problems: problems.join(' '),
        },
      });
      throw new BadRequestException(problems);
    }

    if (!this.storage.canStore) {
      throw new ConflictException(
        `File storage is not available: the "${this.storage.name}" adapter stores nothing. ` +
          'Uploading would create a record pointing at content that does not exist.',
      );
    }

    const stored = await this.storage.put({
      tenantId: input.scope.tenantId,
      filename: input.filename,
      contentType: input.contentType,
      bytes: input.bytes,
    });

    const retention: RetentionPolicy = {
      retentionDays: policy.defaultRetentionDays,
      action: policy.defaultRetentionAction,
    };
    const uploadedAt = new Date();

    const created = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.storedFile.create({
        data: {
          tenantId: input.scope.tenantId,
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: stored.sizeBytes,
          storageRef: stored.ref,
          contentHash: stored.contentHash,
          classification: input.classification ?? DEFAULT_FILE_CLASSIFICATION,
          retentionAction: retention.action,
          retentionExpiresAt: retentionExpiry(retention, uploadedAt),
          uploadedByUserId: input.actorUserId,
          uploadedAt,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'knowledge.file_uploaded',
        resourceType: 'file',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        summary: `${input.filename} uploaded, awaiting a scan.`,
        metadata: {
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: stored.sizeBytes,
          classification: row.classification,
          storageAdapter: this.storage.name,
        },
      });

      return row;
    });

    // Scanned straight away. Until this finishes the file is `Pending` and nothing may read it.
    return this.scan({ scope: input.scope, fileId: created.id, bytes: input.bytes });
  }

  /**
   * Scan a file and record the verdict.
   *
   * Split out from `upload` so a quarantined file can be scanned again without being re-uploaded,
   * and so the transition table governs the move rather than the call site.
   *
   * **The row never sits in `Scanning`.** The scan is synchronous, so the state moves straight from
   * `Pending` to its verdict; the guard asks `mayMoveScan(current, 'Scanning')` because that is the
   * real question — *may a scan start from here* — and writing an intermediate state nobody could
   * ever observe would be a row update for the benefit of nothing. When the scan moves onto the
   * Prompt 26 scheduler the intermediate state becomes real and this method writes it, which is why
   * the state exists in the vocabulary now rather than being added later.
   */
  async scan(input: {
    scope: TenantScope;
    fileId: string;
    bytes?: Buffer;
  }): Promise<StoredFileView> {
    const file = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.storedFile.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.fileId },
      }),
    );

    if (file === null) {
      throw new NotFoundException('That file does not exist in this company.');
    }

    if (!mayMoveScan(file.scanState as FileScanState, 'Scanning')) {
      throw new ConflictException(
        `A file that is ${file.scanState} cannot be scanned again. ` +
          (file.scanState === 'Clean'
            ? 'It has already been scanned.'
            : 'An infected file is deleted rather than re-scanned.'),
      );
    }

    const bytes =
      input.bytes ?? (file.storageRef === null ? null : await this.storage.get(file.storageRef));

    if (bytes === null) {
      throw new ConflictException('That file has no stored content, so there is nothing to scan.');
    }

    const verdict = await this.scanner.scan({ filename: file.filename, bytes });

    const updated = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const updatedRow = await this.prisma.client.storedFile.update({
        where: { id: file.id },
        data: {
          scanState: verdict.outcome,
          scannedAt: new Date(),
          scanResult: verdict.detail,
          scannedByRealScanner: verdict.scannedByRealScanner,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'knowledge.file_scanned',
        resourceType: 'file',
        resourceId: file.id,
        summary: `${file.filename}: ${verdict.outcome}.`,
        resourceVersion: updatedRow.version,
        metadata: {
          outcome: verdict.outcome,
          detail: verdict.detail,
          scanner: this.scanner.name,
          // The honesty flag, on the record as well as on the row.
          scannedByRealScanner: verdict.scannedByRealScanner,
        },
      });

      return updatedRow;
    });

    // Outside the tenant transaction, because the security trail is written as a platform
    // operation and `runAsPlatformOperation` refuses to nest inside a tenant one. Recording it
    // inside would drop the event silently — the failure mode Prompt 7 found the hard way.
    if (verdict.outcome !== 'Clean') {
      await this.securityEvents.recordSuspicious({
        action:
          verdict.outcome === 'Infected'
            ? SECURITY_ACTIONS.fileScanFoundMalware
            : SECURITY_ACTIONS.fileQuarantined,
        tenantId: input.scope.tenantId,
        resourceType: 'file',
        resourceId: file.id,
        summary: `${file.filename}: ${verdict.detail}`,
        metadata: { outcome: verdict.outcome, scanner: this.scanner.name },
      });
    }

    return FileService.toView(updated);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(input: {
    scope: TenantScope;
    actorUserId: string;
    includeDeleted?: boolean;
    limit?: number;
  }): Promise<StoredFileView[]> {
    await this.assertMaySeeKnowledge(input.scope, input.actorUserId);

    const rows = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.storedFile.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...(input.includeDeleted === true ? {} : { deletedAt: null }),
        },
        orderBy: [{ uploadedAt: 'desc' }],
        take: Math.min(input.limit ?? 100, 200),
      }),
    );

    return rows.map((row) => FileService.toView(row));
  }

  /**
   * Download a file's bytes.
   *
   * Three gates, in order: the permission, **the scan**, and the export ceiling. The scan check is
   * not a formality — a file that has not been scanned clean is exactly the thing a download must
   * refuse, and it is refused here as well as at every other read path rather than in one shared
   * guard somebody could call around.
   */
  async download(input: {
    scope: TenantScope;
    actorUserId: string;
    fileId: string;
  }): Promise<{ view: StoredFileView; bytes: Buffer }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Export' });

    const file = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.storedFile.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.fileId },
      }),
    );

    if (file === null || file.deletedAt !== null) {
      throw new NotFoundException('That file does not exist in this company.');
    }

    if (!fileIsUsable(file.scanState as FileScanState)) {
      throw new ForbiddenException(
        `That file is ${file.scanState.toLowerCase()} and cannot be downloaded. Nothing reads a ` +
          'file that has not been scanned clean.',
      );
    }

    const policy = await this.policy(input.scope);
    const decision = decideEgress({
      classification: file.classification as DataClassification,
      ceiling: policy.exportCeiling,
      // A download by a person to their own machine is an export, not external egress: it stays
      // within what the company's own people are entitled to. Sending it onward is the other
      // decision, and the connection path is where that is made.
      leavesTheCompany: false,
    });

    if (!decision.permitted) {
      throw new ForbiddenException(decision.reason);
    }

    if (file.storageRef === null) {
      throw new ConflictException('That file has no stored content.');
    }

    const bytes = await this.storage.get(file.storageRef);

    // An export is recorded as a security event, so it appears in the Security Center's Data
    // Exports view alongside the audit and security trail exports.
    await this.securityEvents.record({
      action: SECURITY_ACTIONS.fileDownloaded,
      actorUserId: input.actorUserId,
      tenantId: input.scope.tenantId,
      resourceType: 'file',
      resourceId: file.id,
      summary: `${file.filename} downloaded.`,
      metadata: {
        filename: file.filename,
        classification: file.classification,
        sizeBytes: file.sizeBytes,
      },
    });

    return { view: FileService.toView(file), bytes };
  }

  /**
   * Whether classified content may leave the company, and whether redaction is required first.
   *
   * §22's DLP hook. **UBoss does not redact** — see `REDACTION_STANCE` — so a transfer that needs
   * redaction is refused rather than sent unredacted. Exposed as its own method because the
   * connection path, the notification path and any future integration all have to ask the same
   * question, and three copies of it would drift.
   */
  async mayLeaveTheCompany(input: {
    scope: TenantScope;
    classification: DataClassification;
  }): Promise<{ permitted: boolean; reason: string | null; redactionRequired: boolean }> {
    const policy = await this.policy(input.scope);
    const decision = decideEgress({
      classification: input.classification,
      ceiling: policy.externalEgressCeiling,
      leavesTheCompany: true,
    });

    if (!decision.permitted) {
      return { permitted: false, reason: decision.reason, redactionRequired: false };
    }

    return {
      // Permitted *and* needing redaction is refused, because nothing redacts. Reporting it as
      // permitted would let a caller send it intact.
      permitted: !decision.redactionRequired,
      reason: decision.redactionRequired
        ? 'That content is sensitive and would have to be redacted before it left the company. ' +
          'UBoss has no redaction engine, so the transfer is refused rather than sent unredacted.'
        : null,
      redactionRequired: decision.redactionRequired,
    };
  }

  // -------------------------------------------------------------------------
  // Classification, holds and deletion
  // -------------------------------------------------------------------------

  /** Reclassify a file. `settings:Administer` — it changes who may read and export it. */
  async classify(input: {
    scope: TenantScope;
    actorUserId: string;
    fileId: string;
    classification: DataClassification;
    reason: string;
  }): Promise<StoredFileView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (input.reason.trim() === '') {
      throw new BadRequestException('Say why the classification is changing.');
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const file = await this.prisma.client.storedFile.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.fileId },
      });
      if (file === null) throw new NotFoundException('That file does not exist in this company.');

      const updated = await this.prisma.client.storedFile.update({
        where: { id: file.id },
        data: { classification: input.classification, version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'knowledge.file_reclassified',
        resourceType: 'file',
        resourceId: file.id,
        actorUserId: input.actorUserId,
        summary: `${file.filename}: ${file.classification} → ${input.classification}. ${input.reason}`,
        resourceVersion: updated.version,
        metadata: {
          before: file.classification,
          after: input.classification,
          reason: input.reason,
        },
      });

      return FileService.toView(updated);
    });
  }

  /**
   * Place or lift a legal hold.
   *
   * `settings:Administer`, and both directions are audited. A hold is the one thing in this module
   * that overrides every other rule, so who placed it and why is the whole record.
   */
  async setLegalHold(input: {
    scope: TenantScope;
    actorUserId: string;
    fileId: string;
    onHold: boolean;
    reason: string;
  }): Promise<StoredFileView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (input.reason.trim() === '') {
      throw new BadRequestException(
        input.onHold
          ? 'A legal hold needs a reason. A hold nobody can explain is a hold nobody can lift.'
          : 'Say why the hold is being lifted.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const file = await this.prisma.client.storedFile.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.fileId },
      });
      if (file === null) throw new NotFoundException('That file does not exist in this company.');

      if (file.onLegalHold === input.onHold) {
        throw new ConflictException(
          input.onHold
            ? 'That file is already under a legal hold.'
            : 'That file is not under a legal hold.',
        );
      }

      const updated = await this.prisma.client.storedFile.update({
        where: { id: file.id },
        data: input.onHold
          ? {
              onLegalHold: true,
              legalHoldReason: input.reason,
              legalHoldPlacedAt: new Date(),
              legalHoldPlacedByUserId: input.actorUserId,
              version: { increment: 1 },
            }
          : {
              onLegalHold: false,
              legalHoldReason: null,
              legalHoldPlacedAt: null,
              legalHoldPlacedByUserId: null,
              version: { increment: 1 },
            },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: input.onHold ? 'knowledge.legal_hold_placed' : 'knowledge.legal_hold_lifted',
        resourceType: 'file',
        resourceId: file.id,
        actorUserId: input.actorUserId,
        summary: `${file.filename}: legal hold ${input.onHold ? 'placed' : 'lifted'}. ${input.reason}`,
        resourceVersion: updated.version,
        metadata: {
          reason: input.reason,
          // The previous hold's reason, so lifting one records what it was for.
          previousReason: file.legalHoldReason ?? '',
        },
      });

      return FileService.toView(updated);
    });
  }

  /**
   * Delete a file's content.
   *
   * **A legal hold beats this**, and the refusal is the database's as well as the service's. The
   * content goes and the row survives with its name, dates and reason, because "was our data
   * deleted?" has to be answerable — the same shape as a memory deletion at Prompt 33.
   */
  async delete(input: {
    scope: TenantScope;
    actorUserId: string;
    fileId: string;
    reason: string;
  }): Promise<StoredFileView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    return this.deleteAuthorizedElsewhere(input);
  }

  /**
   * The deletion, with the permission check already made by somebody else.
   *
   * The counterpart to `uploadAuthorizedElsewhere`, and needed for the same reason: "remove my
   * photo" is not an administrative act, so it cannot require `settings:Administer`. Everything
   * that matters is still here — the legal-hold refusal, the row-before-object ordering, the
   * storage delete and the audit event.
   *
   * The legal-hold check in particular is **not** bypassed, and must never be: a file under hold
   * stays whoever asks and for whatever reason.
   */
  async deleteAuthorizedElsewhere(input: {
    scope: TenantScope;
    actorUserId: string;
    fileId: string;
    reason: string;
  }): Promise<StoredFileView> {
    if (input.reason.trim() === '') {
      throw new BadRequestException('Say why this file is being deleted.');
    }

    const file = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.storedFile.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.fileId },
      }),
    );
    if (file === null) throw new NotFoundException('That file does not exist in this company.');

    const decision = decideDeletion({
      onLegalHold: file.onLegalHold,
      legalHoldReason: file.legalHoldReason,
      alreadyDeleted: file.deletedAt !== null,
    });
    if (!decision.mayDelete) throw new ForbiddenException(decision.reason);

    // The row first, then the object. A failure between them leaves an orphan in storage — which
    // is a cleanup problem — rather than a row claiming the content is gone while it is not,
    // which is a lie to a customer who asked for a deletion.
    const updated = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.storedFile.update({
        where: { id: file.id },
        data: {
          storageRef: null,
          deletedAt: new Date(),
          deletedReason: input.reason,
          deletedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'knowledge.file_deleted',
        resourceType: 'file',
        resourceId: file.id,
        actorUserId: input.actorUserId,
        summary: `${file.filename} deleted. ${input.reason}`,
        resourceVersion: row.version,
        metadata: {
          filename: file.filename,
          reason: input.reason,
          classification: file.classification,
          // Proves the deletion removed the right object.
          contentHash: file.contentHash ?? '',
        },
      });

      return row;
    });

    if (file.storageRef !== null) {
      await this.storage.delete(file.storageRef);
    }

    return FileService.toView(updated);
  }

  /**
   * The retention sweep.
   *
   * Nothing schedules it — the fifth job now waiting on the Prompt 26 business-cron scheduler. It
   * is reachable and tested, which is the honest state. **A held file is never swept**, and that
   * is checked here as well as by the database.
   */
  async sweepRetention(input: {
    scope: TenantScope;
    now?: Date;
  }): Promise<{ deleted: number; heldBack: number }> {
    const now = input.now ?? new Date();

    const due = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.storedFile.findMany({
        where: {
          tenantId: input.scope.tenantId,
          deletedAt: null,
          retentionExpiresAt: { not: null, lte: now },
        },
        select: {
          id: true,
          filename: true,
          storageRef: true,
          onLegalHold: true,
          retentionAction: true,
        },
      }),
    );

    let deleted = 0;
    let heldBack = 0;

    for (const file of due) {
      if (file.onLegalHold) {
        heldBack += 1;
        continue;
      }
      // `Review` means a person decides; the sweep leaves it alone and it stays visible as
      // overdue rather than being deleted by a policy that asked for a decision.
      if (file.retentionAction === 'Review') {
        heldBack += 1;
        continue;
      }

      await this.prisma.runInTenantTransaction(input.scope, async () => {
        await this.prisma.client.storedFile.update({
          where: { id: file.id },
          data: {
            storageRef: null,
            deletedAt: now,
            deletedReason: 'Retention period reached.',
            deletedByUserId: null,
            version: { increment: 1 },
          },
        });

        await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'knowledge.file_retention_expired',
          resourceType: 'file',
          resourceId: file.id,
          summary: `${file.filename} deleted: its retention period ended.`,
          metadata: { filename: file.filename, retentionAction: file.retentionAction },
        });
      });

      if (file.storageRef !== null) {
        await this.storage.delete(file.storageRef);
      }
      deleted += 1;
    }

    return { deleted, heldBack };
  }

  /**
   * Who may see the company's file inventory.
   *
   * **Deliberately not `settings:View`**, and this is the one authorization decision in Prompt 35
   * worth arguing over. `settings:View` is on the Employee role template — it is the grant that
   * lets somebody open Settings and see their own profile. A list of every document the company
   * holds, with its classification and who uploaded it, is a different thing: filenames alone leak
   * a great deal ("Redundancy_consultation_list.xlsx"), and the classification column tells a
   * reader exactly which files are worth pursuing.
   *
   * So it is `settings:Administer` **or** `settings:Approve`. Both are real grants on real
   * templates — CompanyAdmin holds the first, Approver the second — and an Approver needs it,
   * because approving a knowledge source without being able to see what is in it is approving
   * nothing. An Employee holds neither.
   *
   * Written as two `authorize` calls rather than one grant because there is no "either of these"
   * in `AuthorizeInput`, and inventing one would be a change to the authorization engine for a
   * single screen.
   */
  async assertMaySeeKnowledge(scope: TenantScope, actorUserId: string): Promise<void> {
    const context = await this.authorization.contextFor(scope, actorUserId);

    for (const action of ['Administer', 'Approve'] as const) {
      const decision = await this.authorization.authorize(context, {
        module: 'settings',
        action,
      });
      if (decision.allowed) return;
    }

    throw new ForbiddenException(
      'Company knowledge and files are for administrators and approvers. A list of every ' +
        'document a company holds, with its classification, is not a general settings view.',
    );
  }

  /** What the screen needs: the adapters in use and whether they are real. */
  adapters(): { storage: string; storageCanStore: boolean; scanner: string } {
    return {
      storage: this.storage.name,
      storageCanStore: this.storage.canStore,
      scanner: this.scanner.name,
    };
  }

  private static toView(row: {
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    classification: string;
    scanState: string;
    scanResult: string | null;
    scannedByRealScanner: boolean | null;
    retentionAction: string;
    retentionExpiresAt: Date | null;
    onLegalHold: boolean;
    legalHoldReason: string | null;
    uploadedByUserId: string;
    uploadedAt: Date;
    deletedAt: Date | null;
    deletedReason: string | null;
    storageRef: string | null;
  }): StoredFileView {
    return {
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      classification: row.classification as DataClassification,
      scanState: row.scanState as FileScanState,
      scanResult: row.scanResult,
      scannedByRealScanner: row.scannedByRealScanner,
      usable: fileIsUsable(row.scanState as FileScanState) && row.deletedAt === null,
      retentionAction: row.retentionAction as RetentionAction,
      retentionExpiresAt: row.retentionExpiresAt?.toISOString() ?? null,
      onLegalHold: row.onLegalHold,
      legalHoldReason: row.legalHoldReason,
      uploadedByUserId: row.uploadedByUserId,
      uploadedAt: row.uploadedAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
      deletedReason: row.deletedReason,
      hasContent: row.storageRef !== null,
    };
  }
}
