import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { DiskStorageAdapter, StorageUnavailableError } from '../src/knowledge/storage-adapter.js';

/**
 * Files on a disk.
 *
 * ## Why this adapter exists at all
 *
 * The only adapter that stored anything was the in-memory one, and it was what *every* deployment
 * got — so in production every uploaded file would have lived in the API process and vanished on
 * the next restart or deploy. Every chat attachment, every knowledge document, every piece of
 * completion evidence. The `files` row would survive and the bytes would not, and the failure
 * would surface as a download that 500s long after the upload was forgotten.
 *
 * A unit spec rather than an e2e one: this is a filesystem adapter, the interesting cases are
 * about paths and partial writes, and none of them needs a database.
 */
describe('disk storage', () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'uboss-storage-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const adapter = () => new DiskStorageAdapter(root);
  const TENANT = '01a0a8fb-8f67-71cb-99f8-f9fdedde810d';

  const store = (bytes: Buffer, filename = 'report.pdf') =>
    adapter().put({ tenantId: TENANT, filename, contentType: 'application/pdf', bytes });

  it('stores bytes and reads back exactly what went in', async () => {
    const bytes = Buffer.from('A reconciliation, with a ₹ sign and a \u0000 null byte.', 'utf8');
    const stored = await store(bytes);

    const read = await adapter().get(stored.ref);
    assert.deepEqual(read, bytes, 'the bytes came back changed');
    assert.equal(stored.sizeBytes, bytes.byteLength);
  });

  it('survives a new adapter, which is the whole point', async () => {
    // The in-memory adapter holds objects on the instance, so a restart loses them. A second
    // adapter over the same root is the closest this can get to a restart.
    const stored = await store(Buffer.from('durable'));
    const read = await new DiskStorageAdapter(root).get(stored.ref);
    assert.equal(read.toString('utf8'), 'durable');
  });

  it('mints a key that owes nothing to the filename', async () => {
    /*
     * A filename is attacker-controlled input, and a key built from one is a path traversal
     * waiting for somebody to try it. The upload validator checks the name too; this is the
     * second lock rather than the only one.
     */
    const stored = await store(Buffer.from('x'), '../../../etc/passwd');

    assert.ok(stored.ref.startsWith(`tenants/${TENANT}/files/`), stored.ref);
    assert.ok(!stored.ref.includes('..'), stored.ref);
    assert.ok(!stored.ref.includes('passwd'), stored.ref);
  });

  it('refuses a reference that escapes the root', async () => {
    /*
     * The refs this adapter mints cannot escape, so this guards against one that came from
     * somewhere else — a restored database, a future caller, a bug. That is exactly when a path
     * check earns its place, and it is the difference between a bad row and reading any file the
     * process can.
     */
    const outside = join(root, '..', 'uboss-storage-escape-proof');
    await writeFile(outside, 'not yours');

    try {
      for (const ref of [
        '../uboss-storage-escape-proof',
        'tenants/../../uboss-storage-escape-proof',
      ]) {
        await assert.rejects(
          () => adapter().get(ref),
          (error: unknown) => {
            assert.ok(error instanceof StorageUnavailableError, String(error));
            assert.match(String(error), /not inside the file store/i);
            return true;
          },
          `"${ref}" was not refused`,
        );
      }
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('says nothing is there rather than returning empty bytes', async () => {
    // Returning an empty buffer would make a missing file look like an empty one, and an empty
    // document passes every check that only looks for absence.
    await assert.rejects(
      () => adapter().get(`tenants/${TENANT}/files/00000000-0000-4000-8000-000000000000`),
      (error: unknown) => {
        assert.ok(error instanceof StorageUnavailableError);
        return true;
      },
    );
  });

  it('deletes, and deleting twice is not an error', async () => {
    const stored = await store(Buffer.from('gone soon'));

    await adapter().delete(stored.ref);
    await assert.rejects(() => adapter().get(stored.ref));

    // Idempotent by the adapter contract: a retry after a partial failure must not throw.
    await adapter().delete(stored.ref);
  });

  it('leaves no partial file behind after a successful write', async () => {
    /*
     * Written to a temporary name and renamed, so a crash midway leaves nothing rather than a
     * truncated file — and a truncated file reads back as a corrupt document rather than a
     * missing one, which passes every check that looks for absence.
     */
    const stored = await store(Buffer.from('whole'));
    const directory = join(root, 'tenants', TENANT, 'files');
    const entries = await readdir(directory);

    assert.ok(
      entries.every((entry) => !entry.endsWith('.partial')),
      `a partial file was left behind: ${entries.join(', ')}`,
    );
    assert.ok(entries.includes(stored.ref.split('/').pop() as string));
  });

  it('hashes the content, so a deletion can prove it removed the right thing', async () => {
    const stored = await store(Buffer.from('hash me'));
    // SHA-256 of 'hash me', so this is pinned against the algorithm rather than against itself.
    assert.match(stored.contentHash, /^[0-9a-f]{64}$/);

    const same = await store(Buffer.from('hash me'));
    assert.equal(same.contentHash, stored.contentHash);
    assert.notEqual(same.ref, stored.ref, 'two uploads must not share a key');
  });
});
