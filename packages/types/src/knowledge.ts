import {
  classificationAllowed,
  DEFAULT_DATA_CLASSIFICATION,
  isSensitiveClassification,
  type DataClassification,
} from './classification.js';

/**
 * Knowledge, files and safe uploads — Prompt 35.
 *
 * ## What the approved documents ask for
 *
 * Technical Architecture §22: *"Uploaded files pass content-type validation, size limits and
 * malware scanning **before use** by Agents/knowledge systems. Data classes: Public / Internal /
 * Confidential / Restricted. Apply stricter tool/AI/export rules by classification. Add
 * DLP/redaction hooks before sensitive data leaves the permitted boundary."*
 *
 * §Store list: `files / knowledge_sources` — *"tenant, classification, storage ref, scan status,
 * retention policy"*.
 *
 * UBoss_Final_1 §Settings: Knowledge & Data is *"approved knowledge sources, classification /
 * retention policy where available"*.
 *
 * ## Two words in that specification do the most work
 *
 * **"before use"** — a file that has not been scanned clean is not a file an agent may read. That
 * is not a warning on a screen; it is a state the read path refuses, and `fileIsUsable` is the one
 * place that decides it.
 *
 * **"storage ref"** — the database holds metadata and a reference, never bytes. The same rule as
 * `secret_ref` in §22, for the same reason: a database that holds the content becomes the thing
 * that has to be encrypted, scanned, backed up and deleted, and it is the wrong place for all
 * four.
 *
 * ## The classification vocabulary is not here
 *
 * It is in `classification.ts`, introduced at Prompt 33 because memory needed it and **shaped for
 * this prompt to own** (ADR-180). This module extends it with the two ceilings §22 asks for —
 * export and external egress — rather than restating the classes.
 */

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Where an uploaded file is in the scanning workflow.
 *
 * `Quarantined` is separate from `Infected` on purpose: a scanner that says "infected" has made a
 * finding, and a scanner that could not finish leaves a file nobody should use *and* nobody should
 * treat as proven malicious. Collapsing them would either release unscanned files or accuse clean
 * ones.
 */
export const FILE_SCAN_STATES = [
  'Pending',
  'Scanning',
  'Clean',
  'Infected',
  'Quarantined',
] as const;
export type FileScanState = (typeof FILE_SCAN_STATES)[number];

export const FILE_SCAN_STATE_LABELS: Record<FileScanState, string> = {
  Pending: 'Waiting to be scanned',
  Scanning: 'Being scanned',
  Clean: 'Scanned and clean',
  Infected: 'Malware found',
  Quarantined: 'Held — the scan did not complete',
};

export const FILE_SCAN_STATE_DESCRIPTIONS: Record<FileScanState, string> = {
  Pending: 'Uploaded and not yet scanned. Nothing may read it.',
  Scanning: 'A scan is running. Nothing may read it until it finishes.',
  Clean: 'A scanner found nothing. It may be used, subject to classification and permission.',
  Infected: 'A scanner found malware. It cannot be read, downloaded or given to an agent.',
  Quarantined:
    'The scan could not complete, so nothing is known about this file. Held rather than ' +
    'released — an unscanned file is not a clean one.',
};

/**
 * Whether a file may be read, downloaded or given to an agent.
 *
 * **The whole of §22's "before use" rule, in one function.** Everything else about a file — who
 * owns it, what it is classified as, which knowledge source it belongs to — is a question that
 * only arises once this returns true.
 */
export function fileIsUsable(state: FileScanState): boolean {
  return state === 'Clean';
}

/** States from which a scan may still start or restart. */
export const ALLOWED_SCAN_TRANSITIONS: Record<FileScanState, readonly FileScanState[]> = {
  Pending: ['Scanning'],
  // A scan that fails to complete quarantines rather than retrying forever in place.
  Scanning: ['Clean', 'Infected', 'Quarantined'],
  // Terminal: a clean file is not re-scanned by this workflow. A company that wants periodic
  // re-scanning is asking for a scheduled job, which is a different subject.
  Clean: [],
  // Terminal, and deliberately so. An infected file is deleted, not cleared.
  Infected: [],
  // A quarantined file may be scanned again, because nothing was ever determined about it.
  Quarantined: ['Scanning'],
};

export function mayMoveScan(from: FileScanState, to: FileScanState): boolean {
  return ALLOWED_SCAN_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Upload validation
// ---------------------------------------------------------------------------

/**
 * The largest file UBoss accepts, in bytes.
 *
 * 50 MB. The approved documents state no limit — §22 asks for "size limits" and names none — so
 * this is configuration with a documented default, and the default is chosen to be large enough
 * for the documents a company actually attaches to work (a contract, a spreadsheet, a scan of a
 * signed form) and small enough that a scanner finishes in seconds.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** The ceiling a company may configure. A gigabyte upload is a different product. */
export const MAX_CONFIGURABLE_UPLOAD_BYTES = 250 * 1024 * 1024;

/**
 * Content types UBoss accepts by default.
 *
 * An **allowlist**, not a blocklist, and that is the decision: a blocklist is a list of the attacks
 * somebody thought of. The set is the document formats a company attaches to work — text,
 * office documents, PDFs, images — and deliberately excludes archives and anything executable,
 * because a scanner that unpacks archives is a scanner with a much larger attack surface and UBoss
 * has no reason to accept one.
 */
export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/**
 * Extensions that are refused **whatever the declared content type says**.
 *
 * Because the content type is supplied by the uploader and is therefore a claim, not a fact. A
 * file called `invoice.exe` declared as `text/plain` passes an allowlist that only reads the
 * header, and this is the second lock.
 */
export const ALWAYS_REFUSED_EXTENSIONS: readonly string[] = [
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.msi',
  '.ps1',
  '.sh',
  '.jar',
  '.app',
  '.vbs',
  '.js',
  '.jse',
  '.wsf',
  '.lnk',
];

export interface UploadPolicy {
  maxBytes: number;
  allowedContentTypes: readonly string[];
}

export const DEFAULT_UPLOAD_POLICY: UploadPolicy = {
  maxBytes: DEFAULT_MAX_UPLOAD_BYTES,
  allowedContentTypes: DEFAULT_ALLOWED_CONTENT_TYPES,
};

export interface UploadRequest {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Why an upload would be refused.
 *
 * A list rather than the first failure, so somebody fixing a rejected upload sees everything at
 * once instead of discovering the size limit after fixing the type.
 */
export function uploadProblems(request: UploadRequest, policy: UploadPolicy): string[] {
  const problems: string[] = [];

  const filename = request.filename.trim();
  if (filename === '') {
    problems.push('A file needs a name.');
  }

  // Checked on the *name as given*, before any normalisation: a name containing a path separator
  // is either a mistake or an attempt to write outside the intended prefix, and neither should be
  // quietly corrected.
  if (/[\\/]/.test(filename) || filename.includes('..')) {
    problems.push(
      'A filename cannot contain a path. Upload the file by its own name — UBoss decides where ' +
        'it is stored.',
    );
  }

  const lower = filename.toLowerCase();
  const refused = ALWAYS_REFUSED_EXTENSIONS.find((extension) => lower.endsWith(extension));
  if (refused !== undefined) {
    problems.push(
      `UBoss does not accept ${refused} files, whatever they are declared as. Executable content ` +
        'has no use as company knowledge.',
    );
  }

  if (!policy.allowedContentTypes.includes(request.contentType)) {
    problems.push(
      `"${request.contentType}" is not an accepted file type. UBoss accepts documents, ` +
        'spreadsheets, presentations, PDFs, plain text and images.',
    );
  }

  if (!Number.isInteger(request.sizeBytes) || request.sizeBytes <= 0) {
    problems.push('A file needs a size.');
  } else if (request.sizeBytes > policy.maxBytes) {
    problems.push(
      `That file is ${Math.ceil(request.sizeBytes / 1024 / 1024)} MB. The limit is ` +
        `${Math.floor(policy.maxBytes / 1024 / 1024)} MB.`,
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Retention, legal hold and deletion
// ---------------------------------------------------------------------------

/**
 * What happens to a file when its retention period ends.
 *
 * §27.1 asks for "retention, legal hold, deletion/export and data-residency choices governed by
 * plan/company policy" and states no values, so these are the defensible options and the company
 * chooses.
 */
export const RETENTION_ACTIONS = ['DeleteContent', 'DeleteRecord', 'Review'] as const;
export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

export const RETENTION_ACTION_LABELS: Record<RetentionAction, string> = {
  DeleteContent: 'Delete the file, keep the record of it',
  DeleteRecord: 'Delete the file and its record',
  Review: 'Flag it for somebody to decide',
};

export const RETENTION_ACTION_DESCRIPTIONS: Record<RetentionAction, string> = {
  DeleteContent:
    'The stored content goes; the name, who uploaded it and when it was deleted stay, so "was ' +
    'our data deleted?" stays answerable.',
  DeleteRecord:
    'Everything goes, including the record that the file existed. Choose this only where a ' +
    'regulator requires it — nothing afterwards can show what was removed.',
  Review: 'Nothing is deleted automatically. Somebody is asked to decide.',
};

/** The safe default: the content goes and the record of the deletion survives. */
export const DEFAULT_RETENTION_ACTION: RetentionAction = 'DeleteContent';

/** The longest retention a company may configure, in days. Ten years, as for memory. */
export const MAX_RETENTION_DAYS = 3_650;

export interface RetentionPolicy {
  /** Null means the file is kept until somebody deletes it. */
  retentionDays: number | null;
  action: RetentionAction;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  // Null by default, and deliberately: deleting a company's documents on a schedule nobody set is
  // the most damaging possible default. A company that wants automatic retention configures it.
  retentionDays: null,
  action: DEFAULT_RETENTION_ACTION,
};

export function retentionProblems(policy: RetentionPolicy): string[] {
  const problems: string[] = [];

  if (policy.retentionDays !== null) {
    if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 1) {
      problems.push('Retention must be a whole number of days, at least one.');
    } else if (policy.retentionDays > MAX_RETENTION_DAYS) {
      problems.push(
        `Retention cannot exceed ${MAX_RETENTION_DAYS} days. To keep a file indefinitely, leave ` +
          'retention unset.',
      );
    }
  }

  if (!RETENTION_ACTIONS.includes(policy.action)) {
    problems.push(`"${policy.action}" is not a retention action.`);
  }

  return problems;
}

/**
 * When a file's retention expires. Null when it has none.
 */
export function retentionExpiry(
  policy: RetentionPolicy,
  uploadedAt: Date,
): Date | null {
  return policy.retentionDays === null
    ? null
    : new Date(uploadedAt.getTime() + policy.retentionDays * 86_400_000);
}

/**
 * Whether a file may be deleted, by retention or by a person.
 *
 * **A legal hold beats everything**, including a retention period that has expired and an explicit
 * request from an administrator. That is the entire purpose of a legal hold: it exists to stop a
 * deletion that every other rule would permit, and a hold that could be overridden by the policy
 * it was placed against would not be one.
 */
export type DeletionDecision =
  | { mayDelete: true }
  | { mayDelete: false; reason: string };

export function decideDeletion(input: {
  onLegalHold: boolean;
  legalHoldReason: string | null;
  alreadyDeleted: boolean;
}): DeletionDecision {
  if (input.alreadyDeleted) {
    return { mayDelete: false, reason: 'That file has already been deleted.' };
  }
  if (input.onLegalHold) {
    return {
      mayDelete: false,
      reason:
        'That file is under a legal hold and cannot be deleted — not by retention, and not by ' +
        'request. ' +
        (input.legalHoldReason === null
          ? 'Lift the hold first.'
          : `The hold says: ${input.legalHoldReason}`),
    };
  }
  return { mayDelete: true };
}

/** Files whose retention has run out and which are not held. Drives the sweep. */
export function filesDueForRetention(
  files: readonly {
    id: string;
    retentionExpiresAt: Date | null;
    onLegalHold: boolean;
    deletedAt: Date | null;
  }[],
  now: Date,
): string[] {
  return files
    .filter(
      (file) =>
        file.deletedAt === null &&
        !file.onLegalHold &&
        file.retentionExpiresAt !== null &&
        file.retentionExpiresAt.getTime() <= now.getTime(),
    )
    .map((file) => file.id);
}

// ---------------------------------------------------------------------------
// Knowledge sources
// ---------------------------------------------------------------------------

/**
 * What a knowledge source is made of.
 *
 * §Settings calls them "approved knowledge sources". A source is a *named, approved, scoped*
 * collection an agent may consult — not a folder of files. The distinction matters because the
 * approval and the access scope belong to the source, and a file can be in more than one.
 */
export const KNOWLEDGE_SOURCE_KINDS = ['UploadedFiles', 'Connection', 'ManualEntry'] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

export const KNOWLEDGE_SOURCE_KIND_LABELS: Record<KnowledgeSourceKind, string> = {
  UploadedFiles: 'Uploaded files',
  Connection: 'A connected system',
  ManualEntry: 'Written in UBoss',
};

/**
 * A knowledge source's lifecycle.
 *
 * `Draft -> Approved -> Retired`, and nothing may consult a source that is not `Approved`. §Settings
 * calls them "approved knowledge sources", which is a requirement rather than a description: an
 * agent reading a source nobody approved is the company's data going somewhere nobody agreed to.
 */
export const KNOWLEDGE_SOURCE_STATES = ['Draft', 'Approved', 'Retired'] as const;
export type KnowledgeSourceState = (typeof KNOWLEDGE_SOURCE_STATES)[number];

export const ALLOWED_KNOWLEDGE_TRANSITIONS: Record<
  KnowledgeSourceState,
  readonly KnowledgeSourceState[]
> = {
  Draft: ['Approved', 'Retired'],
  // Back to draft is how a source is changed: the approval was of a particular scope and
  // classification, so changing either has to be approved again.
  Approved: ['Draft', 'Retired'],
  Retired: [],
};

export function mayMoveKnowledgeSource(
  from: KnowledgeSourceState,
  to: KnowledgeSourceState,
): boolean {
  return ALLOWED_KNOWLEDGE_TRANSITIONS[from].includes(to);
}

/**
 * Who may consult a source.
 *
 * §35: *"Agent/Skill access to knowledge must be authorized by tenant, user/Agent tool policy and
 * classification."* The scope is the first of those three — the tenant is structural, and the
 * classification is a separate ceiling — so this says *which agents and people within the company*.
 */
export const KNOWLEDGE_ACCESS_SCOPES = [
  'NamedAgentsOnly',
  'Department',
  'WholeCompany',
] as const;
export type KnowledgeAccessScope = (typeof KNOWLEDGE_ACCESS_SCOPES)[number];

export const KNOWLEDGE_ACCESS_SCOPE_LABELS: Record<KnowledgeAccessScope, string> = {
  NamedAgentsOnly: 'Only the agents named on it',
  Department: 'A department',
  WholeCompany: 'Anywhere in the company',
};

/** The default, and the strictest: a source is consulted by nothing until somebody says so. */
export const DEFAULT_KNOWLEDGE_ACCESS_SCOPE: KnowledgeAccessScope = 'NamedAgentsOnly';

// ---------------------------------------------------------------------------
// The read decision
// ---------------------------------------------------------------------------

/** What an agent or a person is asking to read. */
export interface KnowledgeReadRequest {
  sourceState: KnowledgeSourceState;
  sourceScope: KnowledgeAccessScope;
  /** Agents explicitly named on the source. */
  namedAgentIds: readonly string[];
  sourceDepartmentId: string | null;
  /** The most sensitive class this source holds. */
  sourceClassification: DataClassification;

  /** The agent asking, when an agent is asking. */
  engineAgentId: string | null;
  /** The department the asking work belongs to. */
  askingDepartmentId: string | null;
  /**
   * The highest class this agent's tool policy permits it to read.
   *
   * From the Prompt 16 connection/tool policy. Null when a *person* is asking, because a person's
   * limit is their role and scope rather than an agent tool grant.
   */
  agentClassificationCeiling: DataClassification | null;
}

export type KnowledgeReadDecision =
  | { permitted: true }
  | { permitted: false; reason: string };

/**
 * Whether this read is permitted.
 *
 * §35's three conditions, in the order that fails cheapest and most informatively:
 *
 * 1. **The source is approved.** "Approved knowledge sources" is the requirement.
 * 2. **The scope admits the asker.**
 * 3. **The classification is within the agent's tool-policy ceiling.**
 *
 * **The tenant is not one of the checks here, and that is deliberate** — as with memory. A source
 * and an asker are both inside one tenant transaction against RLS-protected tables, so a source
 * from another company is not something this function could be asked about. Expressing it here
 * would imply such rows can arrive.
 *
 * **There is no vector-store branch and no embedding sharing.** §35: *"Do not build unrestricted
 * vector-memory sharing."* UBoss stores files and named sources; it does not build a shared
 * semantic index, so there is no path by which one company's content could be retrieved for
 * another's prompt.
 */
export function decideKnowledgeRead(request: KnowledgeReadRequest): KnowledgeReadDecision {
  if (request.sourceState !== 'Approved') {
    return {
      permitted: false,
      reason:
        request.sourceState === 'Retired'
          ? 'That knowledge source has been retired.'
          : 'That knowledge source has not been approved. Nothing consults a source nobody agreed to.',
    };
  }

  switch (request.sourceScope) {
    case 'NamedAgentsOnly':
      if (request.engineAgentId === null) {
        return {
          permitted: false,
          reason:
            'That source is restricted to named agents, and no agent is asking. A person reading ' +
            'it directly is a different permission.',
        };
      }
      if (!request.namedAgentIds.includes(request.engineAgentId)) {
        return {
          permitted: false,
          reason: 'That agent is not named on this knowledge source.',
        };
      }
      break;

    case 'Department':
      // A null on either side never matches, for the reason memory gives: treating null as a
      // matching value turns a scoped read into a company-wide one.
      if (
        request.sourceDepartmentId === null ||
        request.askingDepartmentId === null ||
        request.sourceDepartmentId !== request.askingDepartmentId
      ) {
        return {
          permitted: false,
          reason: 'That source belongs to a different department.',
        };
      }
      break;

    case 'WholeCompany':
      break;
  }

  if (
    request.agentClassificationCeiling !== null &&
    !classificationAllowed(request.sourceClassification, request.agentClassificationCeiling)
  ) {
    return {
      permitted: false,
      reason:
        `That source holds ${request.sourceClassification} data and this agent's tool policy ` +
        `permits up to ${request.agentClassificationCeiling}. Widening it is a deliberate ` +
        'decision somebody has to make.',
    };
  }

  return { permitted: true };
}

// ---------------------------------------------------------------------------
// Export and external egress
// ---------------------------------------------------------------------------

/**
 * The classification ceilings §22 asks for, expressed as two separate limits.
 *
 * *"Apply stricter tool/AI/export rules by classification"* — and the two are genuinely different
 * questions. Exporting a `Confidential` file to somebody inside the company who already holds the
 * permission is an ordinary act. Sending the same file **out of UBoss** through a connected system
 * is the moment §22's DLP hook exists for.
 */
export const DEFAULT_EXPORT_CEILING: DataClassification = 'Confidential';

/**
 * Nothing above `Internal` leaves the company by default.
 *
 * The strictest default in this module, and the one worth defending: the cost of it being too
 * strict is that somebody has to change a setting; the cost of it being too loose is a
 * confidential document in a third-party system, which cannot be undone.
 */
export const DEFAULT_EXTERNAL_EGRESS_CEILING: DataClassification = 'Internal';

export type EgressDecision =
  | { permitted: true; redactionRequired: boolean }
  | { permitted: false; reason: string };

/**
 * Whether classified content may leave the permitted boundary, and whether it must be redacted
 * first.
 *
 * §22: *"Add DLP/redaction hooks before sensitive data leaves the permitted boundary."* This is
 * the hook's decision half. **`redactionRequired` is a instruction to the caller, not a claim that
 * redaction happened** — UBoss has no redaction engine, and a function that returned
 * `redacted: true` would be asserting work nobody did.
 */
export function decideEgress(input: {
  classification: DataClassification;
  ceiling: DataClassification;
  /** True when the destination is outside UBoss — a connected system, an email, a download. */
  leavesTheCompany: boolean;
}): EgressDecision {
  if (!classificationAllowed(input.classification, input.ceiling)) {
    return {
      permitted: false,
      reason:
        `${input.classification} content cannot ` +
        (input.leavesTheCompany ? 'leave the company' : 'be exported') +
        `; this company permits up to ${input.ceiling}. Changing that is a settings decision, ` +
        'not something a run can do.',
    };
  }

  return {
    permitted: true,
    // Sensitive content that is permitted to leave still goes through the redaction hook. The
    // permission and the treatment are different questions, and answering only the first is how
    // a confidential document leaves intact because somebody was allowed to send it.
    redactionRequired: input.leavesTheCompany && isSensitiveClassification(input.classification),
  };
}

/**
 * What UBoss does and does not do about redaction, in words a screen shows.
 *
 * Stated as a constant so the product cannot imply a capability it lacks. §22 asks for *hooks*, and
 * hooks are what this is: the decision is made, the requirement is recorded, and the redaction
 * itself is not performed because no redaction engine exists.
 */
export const REDACTION_STANCE =
  'UBoss decides whether sensitive content may leave and records when redaction is required. It ' +
  'does not redact: no redaction engine is built or connected, so a transfer marked as needing ' +
  'redaction is refused rather than sent unredacted.';

/** The default classification a file takes when nobody says. The product-wide one. */
export const DEFAULT_FILE_CLASSIFICATION: DataClassification = DEFAULT_DATA_CLASSIFICATION;

/**
 * Every scan state is reachable, and only `Clean` is usable.
 *
 * Asserted by a test rather than assumed, because "which states may an agent read from" is the one
 * question in this module where a wrong answer is a data incident.
 */
export function onlyCleanFilesAreUsable(): boolean {
  return FILE_SCAN_STATES.filter((state) => fileIsUsable(state)).length === 1;
}
