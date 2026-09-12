import { createHash, randomUUID } from 'node:crypto';

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
