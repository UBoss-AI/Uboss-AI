import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

/**
 * Where an uploaded file's bytes go — Prompt 35.
 *
 * ## The database holds a reference, never the content
 *
 * §22's rule for secrets, applied to files for the same reasons: a database that holds the content
 * becomes the thing that has to be encrypted, scanned, backed up and deleted, and it is the wrong
 * place for all four. `files.storage_ref` is an opaque key this adapter understands and nothing
 * else interprets.
 *
 * ## What is actually built, and what is not
 *
 * `InMemoryStorageAdapter` is real and complete: it stores, retrieves and deletes, and it is what
 * every test and every development run uses. **`S3StorageAdapter` is a shaped adapter with no
 * network call in it** — the prompt asks for an "S3-compatible storage adapter", and an adapter
 * built against no bucket, no credentials and no endpoint would be a claim rather than an
 * integration. It is present so the seam is real and the wiring is proved; it refuses every call
 * with an explanation rather than pretending to store anything.
 *
 * That distinction is the same one Prompt 29 draws between an implemented provider adapter and a
 * live credential-verified integration, and it is drawn the same way: in the type, in the error,
 * and on the screen.
 */

/** A key the adapter understands. Opaque to everything else. */
export type StorageRef = string;

export interface StoredObject {
  ref: StorageRef;
  /** SHA-256 of the bytes, hex. Lets a deletion prove it removed the right thing. */
  contentHash: string;
  sizeBytes: number;
}

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export abstract class StorageAdapter {
  /** Whether this adapter can actually store anything. False for a shaped-but-unconfigured one. */
  abstract readonly canStore: boolean;

  /** A name for the audit trail, so a company can tell where its files went. */
  abstract readonly name: string;

  abstract put(input: {
    tenantId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<StoredObject>;

  abstract get(ref: StorageRef): Promise<Buffer>;

  /** Removes the object. Idempotent: deleting what is already gone is not an error. */
  abstract delete(ref: StorageRef): Promise<void>;
}

/**
 * The adapter that works.
 *
 * In memory, so it is process-local and does not survive a restart — which is correct for
 * development and for tests, and is stated plainly rather than described as "local storage" in a
 * way somebody might take for durable.
 *
 * **The key is generated, never derived from the filename.** A filename is attacker-controlled
 * input; a key built from one is a path traversal waiting for somebody to try it, and the upload
 * validator's path check is the second lock rather than the only one.
 */
@Injectable()
export class InMemoryStorageAdapter extends StorageAdapter {
  readonly canStore = true;
  readonly name = 'in-memory';

  private readonly objects = new Map<StorageRef, Buffer>();

  async put(input: {
    tenantId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<StoredObject> {
    // Tenant-prefixed so a stray listing is at least sorted by company, and a random id so the
    // key reveals nothing about the file and cannot collide.
    const ref = `tenants/${input.tenantId}/files/${randomUUID()}`;
    this.objects.set(ref, input.bytes);

    return {
      ref,
      contentHash: createHash('sha256').update(input.bytes).digest('hex'),
      sizeBytes: input.bytes.byteLength,
    };
  }

  async get(ref: StorageRef): Promise<Buffer> {
    const bytes = this.objects.get(ref);
    if (bytes === undefined) {
      throw new StorageUnavailableError(
        `Nothing is stored at "${ref}". In-memory storage does not survive a restart, which is ` +
          'why it is for development and tests only.',
      );
    }
    return bytes;
  }

  async delete(ref: StorageRef): Promise<void> {
    this.objects.delete(ref);
  }

  /** Test-only: how many objects are held. Lets a test prove a deletion actually removed bytes. */
  get size(): number {
    return this.objects.size;
  }
}

/**
 * Files on a disk, which is what a single-host deployment actually needs.
 *
 * ## Why this exists
 *
 * Until it did, the only adapter that stored anything was the in-memory one — so every uploaded
 * file in production would have lived in the API process and vanished on the next restart or
 * deploy. Every chat attachment, every knowledge document, every piece of completion evidence.
 * The record would survive, the bytes would not, and the failure would show up as a download
 * that 500s long after the upload was forgotten.
 *
 * S3 is the right answer at scale and its adapter is below, unconnected. This is the right answer
 * for one VPS with a docker volume, and it needs no external service, no credentials and no
 * decision about which region a company's data lives in.
 *
 * ## The key is generated, and the path is checked anyway
 *
 * The ref is `tenants/<id>/files/<uuid>` — no part of it comes from the filename, which is
 * attacker-controlled. `resolve` is still checked against the root on every read and delete,
 * because a generated key today does not stop a future caller passing a stored ref from
 * somewhere else, and `../` in a ref would otherwise read any file the process can.
 *
 * ## Written whole, then moved
 *
 * A crash midway through a write would otherwise leave a truncated file that reads back as a
 * corrupt document rather than a missing one — and a corrupt file passes every check that looks
 * for absence. The temporary name is in the same directory so the rename is atomic.
 */
@Injectable()
export class DiskStorageAdapter extends StorageAdapter {
  readonly canStore = true;
  readonly name = 'disk';

  private readonly logger = new Logger(DiskStorageAdapter.name);

  constructor(private readonly root: string) {
    super();
  }

  async put(input: {
    tenantId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<StoredObject> {
    const ref = `tenants/${input.tenantId}/files/${randomUUID()}`;
    const target = this.resolve(ref);

    await mkdir(dirname(target), { recursive: true });

    const temporary = `${target}.${randomUUID()}.partial`;
    try {
      await writeFile(temporary, input.bytes);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new StorageUnavailableError(
        `Could not store the file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      ref,
      contentHash: createHash('sha256').update(input.bytes).digest('hex'),
      sizeBytes: input.bytes.byteLength,
    };
  }

  async get(ref: StorageRef): Promise<Buffer> {
    try {
      return await readFile(this.resolve(ref));
    } catch (error) {
      throw new StorageUnavailableError(
        `Nothing is stored at "${ref}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async delete(ref: StorageRef): Promise<void> {
    // Idempotent by contract: deleting what is already gone is not an error.
    await rm(this.resolve(ref), { force: true });
  }

  /**
   * The absolute path for a ref, refusing anything that escapes the root.
   *
   * The refs this adapter mints cannot escape, so this is guarding against a ref that came from
   * somewhere else — a restored database, a future caller, a bug. That is exactly when a path
   * check earns its place.
   */
  private resolve(ref: StorageRef): string {
    const target = resolve(this.root, ref);
    const rootWithSeparator = resolve(this.root) + sep;
    if (!target.startsWith(rootWithSeparator)) {
      this.logger.error(`Refusing a storage ref that escapes the root: ${ref}`);
      throw new StorageUnavailableError('That storage reference is not inside the file store.');
    }
    return target;
  }
}

/**
 * The S3-compatible adapter, shaped and **not connected**.
 *
 * No bucket, no credentials, no endpoint and no SDK call. It exists so the seam is real — the
 * service depends on `StorageAdapter` and nothing else — and so that the day a bucket is
 * provisioned, one class is written rather than a service refactored.
 *
 * Every method refuses, with the reason. **Nothing here silently succeeds**, because a storage
 * adapter that appeared to work and stored nothing is the worst possible failure: the upload
 * succeeds, the scan succeeds, the record exists, and the file is gone.
 */
@Injectable()
export class S3StorageAdapter extends StorageAdapter {
  private readonly logger = new Logger(S3StorageAdapter.name);

  readonly canStore = false;
  readonly name = 's3-compatible (not configured)';

  private refuse(): never {
    const message =
      'S3-compatible storage is not configured. No bucket, endpoint or credential has been ' +
      'supplied, so this adapter stores nothing and says so rather than appearing to work.';
    this.logger.warn(message);
    throw new StorageUnavailableError(message);
  }

  // The parameters are declared and unused on purpose: the signatures are the seam, and a caller
  // type-checking against this class has to be checking against the real shape.
  async put(_input: {
    tenantId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<StoredObject> {
    this.refuse();
  }

  async get(_ref: StorageRef): Promise<Buffer> {
    this.refuse();
  }

  async delete(_ref: StorageRef): Promise<void> {
    this.refuse();
  }
}

/** DI token, so the service depends on the seam rather than on a class. */
export const STORAGE_ADAPTER = Symbol('STORAGE_ADAPTER');
